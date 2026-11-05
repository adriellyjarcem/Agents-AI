#!/usr/bin/env python3
"""
Monitor em tempo real: fica conectado ao WhatsApp e, a cada imagem nova no grupo escolhido,
lê o Informe Estoque Visual (OCR local) e lança na planilha na hora.

Como funciona:
  - O script entra no WhatsApp como um "aparelho conectado" (como o WhatsApp Web), usando a
    biblioteca neonize. Na primeira vez mostra um QR code: no celular, WhatsApp > Configurações >
    Aparelhos conectados > Conectar um aparelho. A sessão fica salva; das próximas vezes conecta sozinho.
  - Na primeira vez também pergunta qual grupo monitorar e guarda a escolha em config.json.
  - Cada imagem do grupo é baixada para a pasta de imagens (com um .json ao lado: quem enviou,
    quando, legenda) e só depois é lida e lançada. Se o PC desligar ou a planilha estiver aberta
    no Excel, nada se perde: o lançamento é refeito quando der.
  - Mensagens que chegam enquanto o script está desligado são entregues quando ele volta
    (o WhatsApp guarda por alguns dias para aparelhos conectados).

Uso:
    python monitorar_grupo.py                      # primeira vez: QR code + escolha do grupo
    python monitorar_grupo.py --grupo "Estoque"    # escolhe o grupo pelo nome
    python monitorar_grupo.py --trocar-grupo       # escolher outro grupo

Atenção: é um cliente não oficial do WhatsApp. O uso é por sua conta; o ideal é usar um número
dedicado que participe do grupo.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import sys
import threading
from datetime import datetime
from pathlib import Path

PASTA = Path(__file__).resolve().parent
sys.path.insert(0, str(PASTA))

import coletar_imagens as ci  # noqa: E402
from leitor_informe import ErroLeitura, LeitorInforme  # noqa: E402

ARQUIVO_CONFIG = PASTA / "config.json"
ARQUIVO_SESSAO = "sessao_whatsapp.sqlite3"  # criado na pasta do script
ARQUIVO_QR = PASTA / "qrcode_whatsapp.png"
EXTENSOES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
ESPERA_PLANILHA_ABERTA = 60  # segundos entre tentativas quando a planilha está aberta no Excel

log = logging.getLogger("monitor")


def configurar_log() -> None:
    formato = logging.Formatter("%(asctime)s  %(message)s", "%d/%m/%Y %H:%M:%S")
    tela = logging.StreamHandler(sys.stdout)
    tela.setFormatter(formato)
    arquivo = logging.FileHandler(PASTA / "monitor.log", encoding="utf-8")
    arquivo.setFormatter(formato)
    log.addHandler(tela)
    log.addHandler(arquivo)
    log.setLevel(logging.INFO)
    log.propagate = False  # o neonize configura o log geral; evita mensagens duplicadas
    logging.getLogger("whatsmeow").setLevel(logging.WARNING)


def ler_config() -> dict:
    try:
        return json.loads(ARQUIVO_CONFIG.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def salvar_config(config: dict) -> None:
    ARQUIVO_CONFIG.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def chave_jid(jid) -> str:
    return f"{jid.User}@{jid.Server}"


def para_datahora(timestamp: int) -> datetime:
    # O neonize entrega o horário em milissegundos; aceita segundos por garantia
    return datetime.fromtimestamp(timestamp / 1000 if timestamp > 10**11 else timestamp)


def midia_da_mensagem(mensagem):
    """Devolve (mensagem a baixar, mimetype, legenda) se for imagem; senão None."""
    if mensagem.HasField("imageMessage"):
        img = mensagem.imageMessage
        return mensagem, img.mimetype or "image/jpeg", img.caption
    doc_msg = mensagem
    if mensagem.HasField("documentWithCaptionMessage"):
        doc_msg = mensagem.documentWithCaptionMessage.message
    if doc_msg.HasField("documentMessage") and doc_msg.documentMessage.mimetype.startswith("image/"):
        doc = doc_msg.documentMessage
        return doc_msg, doc.mimetype, doc.caption
    return None


class Monitor:
    def __init__(self, planilha: Path, pasta_imagens: Path, config: dict):
        self.planilha = planilha
        self.pasta_imagens = pasta_imagens
        self.config = config
        self.leitor = LeitorInforme()
        self.fila: queue.Queue = queue.Queue()
        self.conectado = threading.Event()
        self.encerrar = threading.Event()
        self.alvo = config.get("grupo_jid")  # "123456@g.us"
        self.nome_alvo = config.get("grupo_nome", "")
        self.antes_da_escolha: list = []  # mensagens que chegaram antes de escolher o grupo
        self.trava = threading.Lock()

    # ------------------------------------------------------------------ eventos do WhatsApp

    def ao_receber_qr(self, _cliente, dados: bytes) -> None:
        import segno
        qr = segno.make_qr(dados)
        qr.save(ARQUIVO_QR, scale=8, border=4)
        log.info("Leia o QR code com o celular do número que está no grupo:")
        log.info("  WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho")
        log.info(f"  (o QR code também foi salvo em {ARQUIVO_QR.name} e aberto na tela)")
        try:
            qr.terminal(compact=True)
        except Exception:
            pass
        if hasattr(os, "startfile"):
            try:
                os.startfile(ARQUIVO_QR)  # abre a imagem no Windows
            except OSError:
                pass

    def ao_conectar(self, _cliente, _evento) -> None:
        if ARQUIVO_QR.exists():
            ARQUIVO_QR.unlink(missing_ok=True)
        log.info("Conectado ao WhatsApp.")
        self.conectado.set()

    def ao_desconectar_sessao(self, _cliente, _evento) -> None:
        log.error("O celular desconectou este aparelho. Rode de novo para ler um novo QR code.")
        Path(PASTA / ARQUIVO_SESSAO).unlink(missing_ok=True)
        self.encerrar.set()

    def ao_receber_mensagem(self, cliente, evento) -> None:
        origem = evento.Info.MessageSource
        if not origem.IsGroup:
            return
        midia = midia_da_mensagem(evento.Message)
        if midia is None:
            return
        with self.trava:
            if self.alvo is None:
                self.antes_da_escolha.append((cliente, evento))
                return
        if chave_jid(origem.Chat) == self.alvo:
            self.fila.put(("baixar", cliente, evento))

    # ------------------------------------------------------------------ escolha do grupo

    def escolher_grupo(self, cliente, nome_pedido: str | None) -> None:
        grupos = sorted(cliente.get_joined_groups(), key=lambda g: g.GroupName.Name.casefold())
        if not grupos:
            sys.exit("Este número não participa de nenhum grupo.")
        if nome_pedido:
            alvo = ci.normalizar(nome_pedido)
            achados = [g for g in grupos if alvo in ci.normalizar(g.GroupName.Name)]
            exatos = [g for g in achados if ci.normalizar(g.GroupName.Name) == alvo]
            achados = exatos or achados
            if len(achados) != 1:
                nomes = "\n  ".join(g.GroupName.Name for g in (achados or grupos))
                log.error(f'"{nome_pedido}" {"combina com mais de um grupo" if achados else "não encontrado"}:\n  {nomes}')
                self.encerrar.set()
                return
            grupo = achados[0]
        else:
            print("\nGrupos deste número:")
            for i, g in enumerate(grupos, 1):
                print(f"  {i:3}. {g.GroupName.Name}")
            while True:
                resposta = input("\nNúmero do grupo a monitorar: ").strip()
                if resposta.isdigit() and 1 <= int(resposta) <= len(grupos):
                    grupo = grupos[int(resposta) - 1]
                    break
                print("Digite um dos números da lista.")

        with self.trava:
            self.alvo = chave_jid(grupo.JID)
            self.nome_alvo = grupo.GroupName.Name
            self.config.update(grupo_jid=self.alvo, grupo_nome=self.nome_alvo)
            salvar_config(self.config)
            pendentes, self.antes_da_escolha = self.antes_da_escolha, []
        log.info(f'Monitorando o grupo "{self.nome_alvo}". As configurações ficaram em {ARQUIVO_CONFIG.name}.')
        for cliente_, evento in pendentes:
            if chave_jid(evento.Info.MessageSource.Chat) == self.alvo:
                self.fila.put(("baixar", cliente_, evento))

    # ------------------------------------------------------------------ trabalho (em segundo plano)

    def trabalhar(self) -> None:
        while not self.encerrar.is_set():
            try:
                tarefa = self.fila.get(timeout=1)
            except queue.Empty:
                continue
            try:
                if tarefa[0] == "baixar":
                    imagem = self.baixar(tarefa[1], tarefa[2])
                    if imagem:
                        self.lancar(imagem)
                else:
                    self.lancar(tarefa[1])
            except Exception:
                log.exception("Erro inesperado; o monitor continua rodando.")

    def baixar(self, cliente, evento) -> Path | None:
        info = evento.Info
        mensagem, mimetype, legenda = midia_da_mensagem(evento.Message)
        quando = para_datahora(info.Timestamp)
        nome = f"{quando:%Y%m%d_%H%M%S}_{info.ID}{EXTENSOES.get(mimetype, '.jpg')}"
        destino = self.pasta_imagens / nome
        if destino.exists():
            return None  # mensagem repetida: já baixada e lançada
        try:
            dados = cliente.download_any(mensagem)
        except Exception as erro:
            log.error(f"Não consegui baixar a imagem de {info.Pushname} ({erro})")
            return None
        destino.write_bytes(dados)
        destino.with_suffix(".json").write_text(json.dumps({
            "quando": quando.isoformat(), "remetente": info.Pushname, "grupo": self.nome_alvo,
            "legenda": legenda, "id": info.ID,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        log.info(f"Imagem nova de {info.Pushname or '?'} ({quando:%d/%m %H:%M}): {nome}")
        return destino

    def lancar(self, imagem: Path) -> None:
        meta = json.loads(imagem.with_suffix(".json").read_text(encoding="utf-8"))
        hash_ = ci.sha256(imagem)
        reg = ci.RegistroImagem(datetime.fromisoformat(meta["quando"]), meta.get("remetente", ""),
                                imagem.name, meta.get("legenda", ""), imagem)
        try:
            informe = self.leitor.ler(imagem)  # lê uma vez só, mesmo que a gravação precise esperar
        except ErroLeitura as erro:
            log.error(f"  {imagem.name}: {erro}")
            return
        while not self.encerrar.is_set():
            try:
                if not self._gravar(reg, informe, meta.get("grupo", ""), hash_):
                    return  # já estava na planilha
                break
            except PermissionError:
                log.warning(f"A planilha {self.planilha.name} está aberta no Excel; "
                            f"tento de novo em {ESPERA_PLANILHA_ABERTA} s (feche para lançar).")
                self.encerrar.wait(ESPERA_PLANILHA_ABERTA)
        else:
            return  # encerrando: fica pendente e é lançada na próxima vez que o monitor abrir
        if not informe["eh_informe_estoque"]:
            log.info("  não é um Informe Estoque Visual; ignorada.")
        else:
            log.info(f"  lançado: {informe['unidade']} {informe['data_informe']}, estoque total "
                     f"{informe['estoque_total_visual']}  [{ci.conferir(informe)}]")

    def _gravar(self, reg, informe: dict, grupo: str, hash_: str) -> bool:
        wb, ws_resumo, ws_detalhe, ws_ignoradas = ci.abrir_planilha(self.planilha)
        if hash_ in ci.hashes_existentes(ws_resumo) | ci.hashes_existentes(ws_ignoradas):
            return False
        if informe["eh_informe_estoque"]:
            ci.lancar(ws_resumo, ws_detalhe, reg, informe, grupo, reg.caminho, self.planilha, hash_)
        else:
            ci.escrever(ws_ignoradas, {"Enviado em": reg.quando.date(), "Remetente": reg.remetente,
                                       "Arquivo": reg.arquivo, "Hash (SHA-256)": hash_})
        ci.finalizar_abas(ws_resumo, ws_detalhe, ws_ignoradas)
        self.planilha.parent.mkdir(parents=True, exist_ok=True)
        wb.save(self.planilha)
        return True

    def pendentes_no_disco(self) -> None:
        """Imagens já baixadas mas não lançadas (PC desligou, erro...): lança agora."""
        lancadas = set()
        if self.planilha.exists():
            _, ws_resumo, _, ws_ignoradas = ci.abrir_planilha(self.planilha)
            lancadas = ci.hashes_existentes(ws_resumo) | ci.hashes_existentes(ws_ignoradas)
        for meta in sorted(self.pasta_imagens.glob("*.json")):
            imagens = [p for p in meta.parent.glob(meta.stem + ".*") if p.suffix != ".json"]
            if imagens and ci.sha256(imagens[0]) not in lancadas:
                log.info(f"Lançando imagem pendente: {imagens[0].name}")
                self.fila.put(("lancar", imagens[0]))


def main() -> None:
    p = argparse.ArgumentParser(description="Monitora um grupo do WhatsApp e lança os informes na planilha.")
    p.add_argument("--grupo", help="nome (ou parte do nome) do grupo; sem isso, pergunta na primeira vez")
    p.add_argument("--trocar-grupo", action="store_true", help="esquece o grupo salvo e pergunta de novo")
    p.add_argument("--planilha", type=Path, help="planilha de saída (padrão: estoque_visual.xlsx nesta pasta)")
    p.add_argument("--pasta-imagens", type=Path, help="onde guardar as imagens (padrão: pasta 'imagens' aqui)")
    args = p.parse_args()

    configurar_log()
    try:
        from neonize.client import NewClient
        from neonize.events import ConnectedEv, LoggedOutEv, MessageEv
    except ImportError:
        sys.exit("Falta a biblioteca neonize. Instale com:  py -m pip install -r requirements.txt")

    config = ler_config()
    if args.trocar_grupo or (args.grupo and ci.normalizar(args.grupo) not in ci.normalizar(config.get("grupo_nome", ""))):
        config.pop("grupo_jid", None)
        config.pop("grupo_nome", None)
    if args.planilha:
        config["planilha"] = str(args.planilha.resolve())
    if args.pasta_imagens:
        config["pasta_imagens"] = str(args.pasta_imagens.resolve())
    planilha = Path(config.get("planilha", PASTA / "estoque_visual.xlsx"))
    pasta_imagens = Path(config.get("pasta_imagens", PASTA / "imagens"))
    pasta_imagens.mkdir(parents=True, exist_ok=True)
    salvar_config(config)

    monitor = Monitor(planilha, pasta_imagens, config)
    os.chdir(PASTA)  # a sessão do WhatsApp fica salva nesta pasta
    cliente = NewClient(ARQUIVO_SESSAO)
    cliente.event.qr(monitor.ao_receber_qr)
    cliente.event(ConnectedEv)(monitor.ao_conectar)
    cliente.event(LoggedOutEv)(monitor.ao_desconectar_sessao)
    cliente.event(MessageEv)(monitor.ao_receber_mensagem)

    log.info(f"Planilha: {planilha}")
    log.info("Conectando ao WhatsApp...")
    def conectar():
        try:
            cliente.connect()
        except Exception as erro:  # sem internet, WhatsApp fora do ar...
            log.error(f"Falha na conexão com o WhatsApp: {erro}")
        monitor.encerrar.set()  # o iniciar_monitor.bat abre o monitor de novo em seguida

    threading.Thread(target=conectar, daemon=True).start()
    threading.Thread(target=monitor.trabalhar, daemon=True).start()
    monitor.pendentes_no_disco()

    try:
        while not monitor.conectado.wait(1):
            if monitor.encerrar.is_set():
                break
        if monitor.conectado.is_set() and monitor.alvo is None:
            monitor.escolher_grupo(cliente, args.grupo)
        if monitor.alvo:
            log.info(f'Monitorando o grupo "{monitor.nome_alvo}". Deixe esta janela aberta (Ctrl+C para sair).')
        while not monitor.encerrar.wait(1):
            pass
    except KeyboardInterrupt:
        log.info("Encerrando...")
    finally:
        monitor.encerrar.set()
        try:
            cliente.disconnect()
        except Exception:
            pass
    sys.exit(1 if not monitor.alvo else 0)


if __name__ == "__main__":
    main()
