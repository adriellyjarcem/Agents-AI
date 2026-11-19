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
import hashlib
import json
import logging
import os
import queue
import re
import shutil
import socket
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

PASTA = Path(__file__).resolve().parent
sys.path.insert(0, str(PASTA))

try:
    import coletar_imagens as ci  # noqa: E402
    from leitor_informe import ErroLeitura, LeitorInforme  # noqa: E402
    from visitas import ColetorVisitas  # noqa: E402
except ModuleNotFoundError as erro:
    sys.exit(f"Falta a biblioteca '{erro.name}'. Rode o instalar.bat, ou no cmd, nesta pasta:\n"
             f"  py -m pip install -r requirements.txt")

ARQUIVO_CONFIG = PASTA / "config.json"
ARQUIVO_SESSAO = "sessao_whatsapp.sqlite3"  # criado na pasta do script
ARQUIVO_QR = PASTA / "qrcode_whatsapp.png"
EXTENSOES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
ARQUIVO_PARAR = PASTA / "parar.flag"  # criado pelo parar_monitor.bat
ARQUIVO_PID = PASTA / "monitor.pid"
# Só uma cópia do monitor por pasta (porta local, não abre nada para a rede). Cada pasta tem a sua
# porta, então dá para ter um monitor em outra pasta (outro aparelho conectado no mesmo número).
PORTA_TRAVA = 49000 + int(hashlib.sha1(str(PASTA).casefold().encode()).hexdigest(), 16) % 1000
SAIDA_JA_RODANDO = 3
ESPERA_COPIA = 60  # segundos entre tentativas de copiar para a pasta de destino
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


def processo_ativo(arquivo_pid: Path) -> bool:
    """O monitor.pid desta pasta aponta para um processo que ainda está rodando?"""
    try:
        pid = int(arquivo_pid.read_text().strip())
    except (OSError, ValueError):
        return False
    if pid == os.getpid():
        return False
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        processo = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not processo:
            return False
        codigo = ctypes.c_ulong()
        ativo = kernel32.GetExitCodeProcess(processo, ctypes.byref(codigo)) and codigo.value == 259  # STILL_ACTIVE
        kernel32.CloseHandle(processo)
        return bool(ativo)
    try:
        os.kill(pid, 0)  # só no Linux/Mac: sinal 0 apenas confere se o processo existe
        return True
    except OSError:
        return False


def ler_config() -> dict:
    try:
        return json.loads(ARQUIVO_CONFIG.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def salvar_config(config: dict) -> None:
    ARQUIVO_CONFIG.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def chave_jid(jid) -> str:
    return f"{jid.User}@{jid.Server}"


def destino_da_copia(copiar_para: str | None, planilha: Path) -> Path | None:
    """Pasta (ou arquivo .xlsx) onde salvar uma cópia da planilha depois de cada lançamento."""
    if not copiar_para:
        return None
    destino = Path(copiar_para.strip().strip('"'))
    return destino if destino.suffix.lower() == ".xlsx" else destino / planilha.name


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
        self.copia = destino_da_copia(config.get("copiar_para"), planilha)
        self.copia_pendente = self.copia is not None  # ao abrir, atualiza a cópia uma vez
        self.ultima_tentativa_copia = 0.0
        # Visitas: mensagens e fotos de um contato (conversa individual), uma pasta por visita
        self.visitas = None
        if config.get("visitas_contato") and config.get("visitas_pasta"):
            self.visitas = ColetorVisitas(PASTA / "visitas", Path(config["visitas_pasta"]), config["visitas_contato"])
        self.visitas_pendente = self.visitas is not None  # ao abrir, confere as pastas uma vez
        self.ultima_tentativa_visitas = 0.0
        self._aviso_visitas = None
        self.pasta_imagens = pasta_imagens
        self.config = config
        self.leitor = LeitorInforme()
        self.fila: queue.Queue = queue.Queue()
        self.conectado = threading.Event()
        self.encerrar = threading.Event()
        self.alvo = config.get("grupo_jid")  # "123456@g.us"
        self.nome_alvo = config.get("grupo_nome", "")
        self.antes_da_escolha: list = []
        self.estoque = config.get("estoque", True)  # False: esta pasta só coleta as visitas  # mensagens que chegaram antes de escolher o grupo
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
            if self.visitas is not None and not origem.IsFromMe:
                self.fila.put(("privada", cliente, evento))  # confere o contato em segundo plano
            return
        if not self.estoque:
            return  # esta pasta só coleta visitas
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
        log.info(f"Grupo escolhido; a escolha ficou salva em {ARQUIVO_CONFIG.name}.")
        for cliente_, evento in pendentes:
            if chave_jid(evento.Info.MessageSource.Chat) == self.alvo:
                self.fila.put(("baixar", cliente_, evento))

    # ------------------------------------------------------------------ trabalho (em segundo plano)

    def trabalhar(self) -> None:
        while not self.encerrar.is_set():
            try:
                tarefa = self.fila.get(timeout=1)
            except queue.Empty:
                if self.copia_pendente and time.monotonic() - self.ultima_tentativa_copia >= ESPERA_COPIA:
                    self.copiar()
                if self.visitas_pendente and time.monotonic() - self.ultima_tentativa_visitas >= ESPERA_COPIA:
                    self.publicar_visitas()
                continue
            try:
                if tarefa[0] == "privada":
                    if self.visitas.eh_do_contato(tarefa[1], tarefa[2]) and self.visitas.registrar(tarefa[1], tarefa[2]):
                        self.publicar_visitas()
                elif tarefa[0] == "baixar":
                    imagem = self.baixar(tarefa[1], tarefa[2])
                    if imagem:
                        self.lancar(imagem)
                else:
                    self.lancar(tarefa[1])
            except Exception:
                log.exception("Erro inesperado; o monitor continua rodando.")

    def publicar_visitas(self) -> None:
        """Monta/atualiza as pastas das visitas; se o destino não estiver disponível, tenta depois."""
        self.ultima_tentativa_visitas = time.monotonic()
        try:
            self.visitas.publicar()
        except OSError as erro:
            if self._aviso_visitas is None or self.ultima_tentativa_visitas - self._aviso_visitas > 1800:
                self._aviso_visitas = self.ultima_tentativa_visitas  # avisa no máximo a cada 30 min
                motivo = "um arquivo está aberto por alguém" if isinstance(erro, PermissionError) else erro
                log.warning(f"Visitas: não consegui atualizar as pastas em {self.visitas.destino} ({motivo}). "
                            f"As mensagens estão guardadas; tento de novo a cada {ESPERA_COPIA // 60} min.")
            self.visitas_pendente = True
            return
        if self._aviso_visitas is not None:
            log.info("Visitas: pastas atualizadas.")
            self._aviso_visitas = None
        self.visitas_pendente = False

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
            ci.lancar(ws_resumo, ws_detalhe, reg, informe, grupo, reg.caminho, self.planilha, hash_,
                      link_absoluto=self.copia is not None)
        else:
            ci.escrever(ws_ignoradas, {"Enviado em": reg.quando.date(), "Remetente": reg.remetente,
                                       "Arquivo": reg.arquivo, "Hash (SHA-256)": hash_})
        ci.finalizar_abas(ws_resumo, ws_detalhe, ws_ignoradas)
        self.planilha.parent.mkdir(parents=True, exist_ok=True)
        wb.save(self.planilha)
        if self.copia is not None:
            self.copia_pendente = True
            self.copiar()
        return True

    def copiar(self) -> None:
        """Salva uma cópia da planilha na pasta de destino (ex.: OneDrive/SharePoint).

        Grava primeiro um arquivo temporário e depois troca, para quem lê a pasta (OneDrive,
        Power BI) nunca pegar a planilha pela metade. Se o arquivo de lá estiver aberto por
        alguém, tenta de novo a cada minuto; a planilha principal já está salva."""
        self.ultima_tentativa_copia = time.monotonic()
        if not self.planilha.exists():
            self.copia_pendente = False
            return
        temporario = self.copia.with_name(f"~tmp_{self.copia.name}")
        try:
            if not self.copia.parent.is_dir():
                raise FileNotFoundError(f"a pasta {self.copia.parent} não existe ou o OneDrive não está sincronizado")
            shutil.copyfile(self.planilha, temporario)
            os.replace(temporario, self.copia)
        except OSError as erro:
            if temporario.parent.is_dir():
                temporario.unlink(missing_ok=True)
            if not self.copia_pendente or self.ultima_tentativa_copia - getattr(self, "_aviso_copia", -1e9) > 1800:
                self._aviso_copia = self.ultima_tentativa_copia  # avisa no máximo a cada 30 min
                motivo = "o arquivo está aberto por alguém" if isinstance(erro, PermissionError) else erro
                log.warning(f"Não consegui salvar a cópia em {self.copia} ({motivo}). "
                            f"Tento de novo a cada {ESPERA_COPIA // 60} min.")
            self.copia_pendente = True
            return
        if self.copia_pendente and getattr(self, "_aviso_copia", None) is not None:
            log.info("Cópia da planilha atualizada no destino.")
            self._aviso_copia = None
        self.copia_pendente = False

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
    p.add_argument("--copiar-para", metavar="PASTA",
                   help="depois de cada lançamento, salva uma cópia da planilha nesta pasta (ex.: OneDrive)")
    p.add_argument("--sem-copia", action="store_true", help="para de salvar a cópia em outra pasta")
    p.add_argument("--visitas-contato", metavar="NUMERO_OU_NOME",
                   help="contato que manda as visitas (número com DDD, ex.: 67 99999-9999, ou o nome salvo)")
    p.add_argument("--visitas-pasta", metavar="PASTA", help="pasta onde criar uma pasta para cada visita")
    p.add_argument("--sem-visitas", action="store_true", help="para de coletar as visitas")
    p.add_argument("--sem-estoque", action="store_true",
                   help="esta pasta não lê os informes de estoque (ex.: um monitor só para as visitas)")
    p.add_argument("--com-estoque", action="store_true", help="volta a ler os informes de estoque")
    args = p.parse_args()

    configurar_log()

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
    if args.copiar_para:
        config["copiar_para"] = args.copiar_para.strip().strip('"')
    if args.sem_copia:
        config.pop("copiar_para", None)
    if args.visitas_contato:
        contato = args.visitas_contato.strip().strip('"')
        if len(re.sub(r"\D", "", contato)) in (10, 11):  # número sem o 55: assume Brasil
            contato = "55" + re.sub(r"\D", "", contato)
        config["visitas_contato"] = contato
    if args.visitas_pasta:
        config["visitas_pasta"] = args.visitas_pasta.strip().strip('"')
    if args.sem_visitas:
        config.pop("visitas_contato", None)
        config.pop("visitas_pasta", None)
    if args.sem_estoque:
        config["estoque"] = False
    if args.com_estoque:
        config.pop("estoque", None)
    salvar_config(config)
    if bool(config.get("visitas_contato")) != bool(config.get("visitas_pasta")):
        log.warning("Visitas: falta configurar " + ("--visitas-pasta" if config.get("visitas_contato")
                                                     else "--visitas-contato") + "; a coleta de visitas está desligada.")
    mudou_config = bool(args.copiar_para or args.sem_copia or args.planilha or args.pasta_imagens
                        or args.visitas_contato or args.visitas_pasta or args.sem_visitas
                        or args.sem_estoque or args.com_estoque)
    if config.get("estoque", True) is False and not (config.get("visitas_contato") and config.get("visitas_pasta")):
        sys.exit("Esta pasta está com o estoque desligado (--sem-estoque) e sem visitas configuradas: "
                 "não há nada para monitorar. Use --visitas-contato e --visitas-pasta.")

    # Duas cópias ao mesmo tempo brigariam pela mesma sessão do WhatsApp
    trava = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if processo_ativo(ARQUIVO_PID):  # monitor desta pasta rodando (inclusive de versão anterior)
            raise OSError("já rodando")
        trava.bind(("127.0.0.1", PORTA_TRAVA))
    except OSError:
        log.info("O monitor já está rodando (talvez escondido). Para parar: parar_monitor.bat")
        if mudou_config:
            log.info("A configuração foi salva; ela vale quando o monitor for reiniciado "
                     "(parar_monitor.bat e depois iniciar_oculto.vbs).")
        sys.exit(SAIDA_JA_RODANDO)
    ARQUIVO_PARAR.unlink(missing_ok=True)
    ARQUIVO_PID.write_text(str(os.getpid()))

    try:
        from neonize.client import NewClient
        from neonize.events import ConnectedEv, LoggedOutEv, MessageEv
    except ImportError:
        sys.exit("Falta a biblioteca neonize. Instale com:  py -m pip install -r requirements.txt")


    monitor = Monitor(planilha, pasta_imagens, config)
    os.chdir(PASTA)  # a sessão do WhatsApp fica salva nesta pasta
    cliente = NewClient(ARQUIVO_SESSAO)
    cliente.event.qr(monitor.ao_receber_qr)
    cliente.event(ConnectedEv)(monitor.ao_conectar)
    cliente.event(LoggedOutEv)(monitor.ao_desconectar_sessao)
    cliente.event(MessageEv)(monitor.ao_receber_mensagem)

    if monitor.estoque:
        log.info(f"Planilha: {planilha}")
    if monitor.copia:
        log.info(f"Cópia depois de cada lançamento: {monitor.copia}")
    if monitor.visitas:
        log.info(f"Visitas: mensagens de {config['visitas_contato']} vão para {monitor.visitas.destino}")
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

    def pediram_para_parar() -> bool:
        if ARQUIVO_PARAR.exists():
            log.info("Parando o monitor (pedido pelo parar_monitor.bat).")
            monitor.encerrar.set()
        return monitor.encerrar.is_set()

    try:
        while not monitor.conectado.wait(1):
            if pediram_para_parar():
                break
        if monitor.estoque and monitor.conectado.is_set() and monitor.alvo is None and not monitor.encerrar.is_set():
            monitor.escolher_grupo(cliente, args.grupo)
        if monitor.alvo and not monitor.encerrar.is_set():
            log.info(f'Monitorando o grupo "{monitor.nome_alvo}". Deixe esta janela aberta ou minimizada '
                     f'(Ctrl+C para sair).')
        elif not monitor.estoque and monitor.conectado.is_set() and not monitor.encerrar.is_set():
            log.info("Monitorando só as visitas (estoque desligado nesta pasta). "
                     "Deixe esta janela aberta ou minimizada (Ctrl+C para sair).")
        while not monitor.encerrar.wait(1):
            pediram_para_parar()
    except KeyboardInterrupt:
        log.info("Encerrando...")
    finally:
        monitor.encerrar.set()
        try:
            cliente.disconnect()
        except Exception:
            pass
        ARQUIVO_PID.unlink(missing_ok=True)
    sys.exit(0 if (monitor.alvo or not monitor.estoque) else 1)


if __name__ == "__main__":
    main()
