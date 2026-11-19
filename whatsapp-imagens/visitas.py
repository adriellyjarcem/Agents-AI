"""
Coleta das visitas: mensagens e fotos que UMA pessoa manda numa conversa individual.

Cada visita é o que vem entre duas linhas de traços ("-----------"). Para cada visita é criada
uma pasta (na pasta configurada, ex.: OneDrive) com:
  - as fotos, vídeos, áudios e documentos, numerados e com o horário ("Foto 01 - 10h42.jpg");
  - "Informações da visita.txt": data, quem enviou, situação e todas as mensagens em ordem;
  - "visita.json": as mesmas informações em formato estruturado (para gerar relatórios depois).

Como funciona por dentro:
  - Cada mensagem recebida é guardada primeiro num registro local (pasta "visitas" do monitor):
    registro.jsonl (uma linha por mensagem, edição ou exclusão) e a mídia em visitas/midia.
  - As pastas das visitas são (re)montadas a partir desse registro. Assim, edições e mensagens
    apagadas atualizam a pasta certa, e se o OneDrive estiver indisponível nada se perde: as pastas
    são montadas quando ele voltar.
  - O nome da pasta é "AAAA-MM-DD HHhMM - <primeira linha do texto>", ex.:
    "2026-11-19 10h41 - Terminal do Breja".
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import threading
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

log = logging.getLogger("monitor")

# Linha só de traços (5 ou mais). Aceita os traços longos que alguns celulares colocam no lugar de "--".
RE_SEPARADOR = re.compile(r"^\s*[-‐‑‒–—―─_]{5,}\s*$")
ARQUIVO_INFO = "Informações da visita.txt"
ARQUIVO_JSON = "visita.json"
PASTA_DESCARTADAS = "_descartadas"
TAMANHO_TITULO = 50

TIPOS_MIDIA = {  # campo da mensagem -> (tipo, prefixo do arquivo, extensão padrão)
    "imageMessage": ("foto", "Foto", ".jpg"),
    "videoMessage": ("video", "Vídeo", ".mp4"),
    "audioMessage": ("audio", "Áudio", ".ogg"),
    "documentMessage": ("documento", "Documento", ""),
}
EXTENSOES = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "video/mp4": ".mp4", "video/3gpp": ".3gp", "audio/ogg": ".ogg", "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a", "application/pdf": ".pdf",
}
TIPO_REVOGAR = 0       # ProtocolMessage.REVOKE: mensagem apagada para todos
TIPO_EDICAO = 14       # ProtocolMessage.MESSAGE_EDIT


# --------------------------------------------------------------------------- contato


def chave_numero(texto: str) -> str:
    """Número só com dígitos; celulares do Brasil com e sem o 9º dígito viram a mesma chave."""
    digitos = re.sub(r"\D", "", texto or "")
    if digitos.startswith("55") and len(digitos) == 13 and digitos[4] == "9":
        digitos = digitos[:4] + digitos[5:]
    return digitos


def normalizar(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", sem_acento).strip().casefold()


# --------------------------------------------------------------------------- leitura das mensagens


def _texto(m) -> str:
    if m.conversation:
        return m.conversation
    if m.HasField("extendedTextMessage"):
        return m.extendedTextMessage.text
    return ""


def _encaminhada(sub) -> bool:
    try:
        return bool(sub.contextInfo.isForwarded)
    except AttributeError:
        return False


def interpretar(evento) -> dict | None:
    """Transforma uma mensagem do WhatsApp num registro simples (ou None se não interessa)."""
    info = evento.Info
    m = evento.Message
    base = {"id": info.ID, "quando": _datahora(info.Timestamp).isoformat(), "remetente": info.Pushname}

    if m.HasField("editedMessage"):  # edição embrulhada (formatos mais novos)
        m = m.editedMessage.message
    if m.HasField("protocolMessage"):
        pm = m.protocolMessage
        if pm.type == TIPO_EDICAO:
            novo = pm.editedMessage
            for campo in TIPOS_MIDIA:  # legenda de foto/vídeo editada
                if novo.HasField(campo):
                    return {**base, "tipo": "edicao", "alvo": pm.key.ID, "legenda": getattr(novo, campo).caption}
            return {**base, "tipo": "edicao", "alvo": pm.key.ID, "texto": _texto(novo)}
        if pm.type == TIPO_REVOGAR:
            return {**base, "tipo": "apagada", "alvo": pm.key.ID}
        return None

    if m.HasField("documentWithCaptionMessage"):
        m = m.documentWithCaptionMessage.message
    for campo, (tipo, _, ext_padrao) in TIPOS_MIDIA.items():
        if m.HasField(campo):
            sub = getattr(m, campo)
            nome_original = getattr(sub, "fileName", "") if campo == "documentMessage" else ""
            ext = Path(nome_original).suffix or EXTENSOES.get(sub.mimetype.split(";")[0], ext_padrao) or ".bin"
            return {**base, "tipo": "msg", "midia_tipo": tipo, "legenda": getattr(sub, "caption", ""),
                    "ext": ext, "nome_original": nome_original, "encaminhada": _encaminhada(sub),
                    "_baixar": m}
    if m.HasField("locationMessage") or m.HasField("liveLocationMessage"):
        loc = m.locationMessage if m.HasField("locationMessage") else m.liveLocationMessage
        return {**base, "tipo": "msg", "local": {
            "lat": loc.degreesLatitude, "lon": loc.degreesLongitude,
            "nome": getattr(loc, "name", ""), "endereco": getattr(loc, "address", "")}}
    texto = _texto(m)
    if texto:
        sub = m.extendedTextMessage if m.HasField("extendedTextMessage") else None
        return {**base, "tipo": "msg", "texto": texto, "encaminhada": _encaminhada(sub) if sub else False}
    return None  # figurinhas, reações, enquetes etc.


def _datahora(timestamp: int) -> datetime:
    return datetime.fromtimestamp(timestamp / 1000 if timestamp > 10**11 else timestamp)


# --------------------------------------------------------------------------- agrupamento em visitas


@dataclass
class Item:
    msg: dict
    texto: str = ""          # trecho do texto que pertence a esta visita
    arquivo: str = ""        # nome do arquivo na pasta da visita (mídia)

    @property
    def quando(self) -> datetime:
        return datetime.fromisoformat(self.msg["quando"])


@dataclass
class Visita:
    chave: str = ""
    itens: list[Item] = field(default_factory=list)
    concluida: bool = False

    @property
    def inicio(self) -> datetime:
        return self.itens[0].quando

    @property
    def fim(self) -> datetime:
        return self.itens[-1].quando

    @property
    def titulo(self) -> str:
        for item in self.itens:
            for linha in item.texto.splitlines():
                if linha.strip():
                    return linha.strip()
        return "Visita"


def dividir_texto(texto: str) -> list:
    """Divide o texto pelos separadores: ["antes", None, "depois"] (None = separador)."""
    partes, atual = [], []
    for linha in texto.splitlines():
        if RE_SEPARADOR.match(linha):
            partes += ["\n".join(atual), None]
            atual = []
        else:
            atual.append(linha)
    partes.append("\n".join(atual))
    return partes


def agrupar(mensagens: list[dict]) -> list[Visita]:
    visitas: list[Visita] = []
    atual = Visita()
    for msg in sorted(mensagens, key=lambda m: (m["quando"], m["ordem"])):
        if "texto" in msg:
            for i, parte in enumerate(dividir_texto(msg["texto"])):
                if parte is None:
                    if atual.itens:
                        atual.concluida = True
                        visitas.append(atual)
                    atual = Visita()
                elif parte.strip():
                    if not atual.itens:
                        atual.chave = f"{msg['id']}:{i}"
                    atual.itens.append(Item(msg, texto=parte.strip()))
        else:
            if not atual.itens:
                atual.chave = f"{msg['id']}:0"
            atual.itens.append(Item(msg))
    if atual.itens:
        visitas.append(atual)
    return visitas


def nome_seguro(texto: str, limite: int = TAMANHO_TITULO) -> str:
    """Nome que o Windows aceita como pasta."""
    texto = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", texto)
    texto = re.sub(r"\s+", " ", texto).strip()
    if len(texto) > limite:
        texto = texto[:limite].rsplit(" ", 1)[0] or texto[:limite]
    return texto.strip(" .") or "Visita"


# --------------------------------------------------------------------------- coletor


class ColetorVisitas:
    def __init__(self, pasta_local: Path, destino: Path, contato: str):
        self.pasta_local = pasta_local
        self.midia = pasta_local / "midia"
        self.registro = pasta_local / "registro.jsonl"
        self.arquivo_estado = pasta_local / "estado_pastas.json"
        self.destino = destino
        self.contato = contato
        self.chave_contato = chave_numero(contato) if len(re.sub(r"\D", "", contato)) >= 10 else ""
        self.nome_contato = "" if self.chave_contato else normalizar(contato)
        self.midia.mkdir(parents=True, exist_ok=True)
        self._lid_para_numero: dict[str, str] = {}
        self._trava = threading.Lock()

    # ---------------------------------------------------------------- de quem é a mensagem

    def eh_do_contato(self, cliente, evento) -> bool:
        origem = evento.Info.MessageSource
        if origem.IsGroup or origem.IsFromMe:
            return False
        if self.nome_contato:  # configurado por nome: compara com o nome salvo/perfil
            nomes = [evento.Info.Pushname]
            try:
                c = cliente.get_contact(origem.Chat)
                nomes += [c.FullName, c.FirstName, c.PushName, c.BusinessName]
            except Exception:
                pass
            return any(self.nome_contato in normalizar(n) for n in nomes if n)
        return self.chave_contato in self._numeros(cliente, origem)

    def _numeros(self, cliente, origem) -> set[str]:
        numeros = set()
        for jid in (origem.Chat, origem.Sender, origem.SenderAlt):
            if jid.User and jid.Server == "s.whatsapp.net":
                numeros.add(chave_numero(jid.User))
            elif jid.User and jid.Server == "lid":  # identificador interno do WhatsApp: converte em número
                if jid.User not in self._lid_para_numero:
                    try:
                        self._lid_para_numero[jid.User] = chave_numero(cliente.get_pn_from_lid(jid).User)
                    except Exception:
                        self._lid_para_numero[jid.User] = ""
                if self._lid_para_numero[jid.User]:
                    numeros.add(self._lid_para_numero[jid.User])
        return numeros

    # ---------------------------------------------------------------- registro local

    def registrar(self, cliente, evento) -> bool:
        """Guarda a mensagem no registro local. Devolve True se algo mudou."""
        dado = interpretar(evento)
        if dado is None:
            return False
        with self._trava:
            existentes = {r.get("id") for r in self._ler_registro() if r["tipo"] == "msg"}
            if dado["tipo"] == "msg" and dado["id"] in existentes:
                return False  # o WhatsApp às vezes entrega a mesma mensagem de novo
            mensagem = dado.pop("_baixar", None)
            if mensagem is not None:
                arquivo = self.midia / f"{dado['id']}{dado['ext']}"
                if not arquivo.exists():
                    try:
                        arquivo.write_bytes(cliente.download_any(mensagem))
                    except Exception as erro:
                        log.error(f"Visitas: não consegui baixar a mídia de {dado['remetente']} ({erro})")
                        dado["erro_download"] = str(erro)
                dado["midia"] = arquivo.name
            with self.registro.open("a", encoding="utf-8") as f:
                f.write(json.dumps(dado, ensure_ascii=False) + "\n")
        resumo = {"msg": dado.get("midia_tipo") or ("localização" if "local" in dado else "texto"),
                  "edicao": "edição", "apagada": "mensagem apagada"}[dado["tipo"]]
        log.info(f"Visitas: {resumo} de {dado['remetente'] or 'contato'} "
                 f"({datetime.fromisoformat(dado['quando']):%d/%m %H:%M})")
        return True

    def _ler_registro(self) -> list[dict]:
        if not self.registro.exists():
            return []
        registros = []
        for linha in self.registro.read_text(encoding="utf-8").splitlines():
            try:
                registros.append(json.loads(linha))
            except json.JSONDecodeError:
                continue  # linha cortada (PC desligou no meio da gravação)
        return registros

    def mensagens(self) -> list[dict]:
        """Estado atual das mensagens, já com edições e exclusões aplicadas."""
        msgs: dict[str, dict] = {}
        registros = self._ler_registro()
        for ordem, r in enumerate(registros):
            if r["tipo"] == "msg":
                msgs.setdefault(r["id"], {**r, "ordem": ordem})
        # Edições e exclusões depois: podem chegar antes da mensagem original (PC estava desligado)
        for r in registros:
            if r["tipo"] == "edicao" and r["alvo"] in msgs:
                alvo = msgs[r["alvo"]]
                if "texto" in r and "texto" in alvo:
                    alvo["texto"], alvo["editada"] = r["texto"], True
                elif "legenda" in r:
                    alvo["legenda"], alvo["editada"] = r["legenda"], True
            elif r["tipo"] == "apagada":
                msgs.pop(r["alvo"], None)
        return list(msgs.values())

    # ---------------------------------------------------------------- pastas das visitas

    def publicar(self) -> int:
        """(Re)monta as pastas das visitas que mudaram. Devolve quantas foram atualizadas.

        Levanta OSError se a pasta de destino não estiver disponível (o monitor tenta de novo)."""
        with self._trava:
            if not self.destino.is_dir() and self.destino.parent.is_dir():
                self.destino.mkdir()  # "Relatórios de visita" ainda não existe: cria dentro da pasta que existe
            if not self.destino.is_dir():
                raise FileNotFoundError(f"a pasta {self.destino} não existe ou o OneDrive não está sincronizado")
            visitas = agrupar(self.mensagens())
            estado = self._ler_estado()
            por_pasta = {dados["pasta"].casefold(): dados for dados in estado.values()}
            novo_estado, usados, atualizadas = {}, set(), 0
            for visita in visitas:
                nome = f"{visita.inicio:%Y-%m-%d %Hh%M} - {nome_seguro(visita.titulo)}"
                base, n = nome, 2
                while nome.casefold() in usados:
                    nome, n = f"{base} ({n})", n + 1
                usados.add(nome.casefold())
                self._nomear_arquivos(visita)
                assinatura = self._assinatura(visita, nome)
                # A chave muda se a 1ª mensagem da visita for apagada: reaproveita pela pasta
                anterior = estado.get(visita.chave) or por_pasta.get(nome.casefold(), {})
                pasta = self.destino / nome
                if anterior.get("assinatura") == assinatura and pasta.is_dir():
                    novo_estado[visita.chave] = anterior
                    continue
                pasta_antiga = self.destino / anterior["pasta"] if anterior.get("pasta") else None
                if pasta_antiga and pasta_antiga != pasta and pasta_antiga.is_dir() and not pasta.exists():
                    pasta_antiga.rename(pasta)  # o título ou o horário de início mudou
                arquivos = self._escrever_pasta(visita, pasta, anterior.get("arquivos", {}))
                novo_estado[visita.chave] = {"pasta": nome, "assinatura": assinatura, "arquivos": arquivos}
                atualizadas += 1
                n_arquivos = sum(1 for i in visita.itens if i.arquivo)
                log.info(f'Visitas: pasta "{nome}" atualizada ({n_arquivos} '
                         f'{"arquivo" if n_arquivos == 1 else "arquivos"}, '
                         f'{"concluída" if visita.concluida else "em andamento"}).')
            # Visitas que deixaram de existir (separador apagado, por exemplo): move, não apaga
            for chave, dados in estado.items():
                if chave not in novo_estado and (self.destino / dados["pasta"]).is_dir() \
                        and dados["pasta"].casefold() not in usados:
                    descartadas = self.destino / PASTA_DESCARTADAS
                    descartadas.mkdir(exist_ok=True)
                    alvo = descartadas / dados["pasta"]
                    if alvo.exists():
                        alvo = descartadas / f"{dados['pasta']} {datetime.now():%Y%m%d%H%M%S}"
                    shutil.move(str(self.destino / dados["pasta"]), str(alvo))
                    log.info(f'Visitas: "{dados["pasta"]}" não é mais uma visita separada; movida para {PASTA_DESCARTADAS}.')
            self._salvar_estado(novo_estado)
            return atualizadas

    @staticmethod
    def _nomear_arquivos(visita: Visita) -> None:
        contagem: dict[str, int] = {}
        for item in visita.itens:
            msg = item.msg
            if not msg.get("midia"):
                continue
            tipo = msg["midia_tipo"]
            contagem[tipo] = contagem.get(tipo, 0) + 1
            prefixo = next(p for t, p, _ in TIPOS_MIDIA.values() if t == tipo)
            if tipo == "documento" and msg.get("nome_original"):
                nome = f"{prefixo} {contagem[tipo]:02d} - {nome_seguro(Path(msg['nome_original']).stem, 60)}"
            else:
                nome = f"{prefixo} {contagem[tipo]:02d} - {item.quando:%Hh%M}"
            item.arquivo = nome + msg["ext"]

    @staticmethod
    def _assinatura(visita: Visita, nome: str) -> str:
        conteudo = [nome, visita.concluida] + [
            [i.msg["id"], i.texto, i.arquivo, i.msg.get("legenda", ""), i.msg.get("local")] for i in visita.itens]
        return hashlib.sha256(json.dumps(conteudo, ensure_ascii=False, default=str).encode()).hexdigest()

    def _escrever_pasta(self, visita: Visita, pasta: Path, arquivos_anteriores) -> dict[str, str]:
        """Escreve a pasta; devolve {nome do arquivo: mídia de origem} para a próxima comparação."""
        if isinstance(arquivos_anteriores, list):  # formato antigo do estado
            arquivos_anteriores = dict.fromkeys(arquivos_anteriores, "")
        pasta.mkdir(parents=True, exist_ok=True)
        arquivos = {}
        for item in visita.itens:
            if not item.arquivo:
                continue
            origem = self.midia / item.msg["midia"]
            destino = pasta / item.arquivo
            # Copia se não existe ou se o nome passou a ser de outra foto (renumeração após exclusão)
            if origem.exists() and (not destino.exists() or arquivos_anteriores.get(item.arquivo) != item.msg["midia"]
                                    or destino.stat().st_size != origem.stat().st_size):
                shutil.copyfile(origem, destino)
            arquivos[item.arquivo] = item.msg["midia"]
        # Mídias que saíram desta visita (apagadas ou renumeradas): remove só arquivos criados por aqui
        for antigo in set(arquivos_anteriores) - set(arquivos):
            (pasta / antigo).unlink(missing_ok=True)
        (pasta / ARQUIVO_INFO).write_text(self._texto_info(visita), encoding="utf-8-sig")
        (pasta / ARQUIVO_JSON).write_text(json.dumps(self._dados_json(visita), ensure_ascii=False, indent=2),
                                          encoding="utf-8")
        return arquivos

    def _texto_info(self, visita: Visita) -> str:
        contagem = {}
        for item in visita.itens:
            if item.msg.get("midia_tipo"):
                contagem[item.msg["midia_tipo"]] = contagem.get(item.msg["midia_tipo"], 0) + 1
        locais = sum(1 for i in visita.itens if i.msg.get("local"))
        remetentes = sorted({i.msg.get("remetente") or "" for i in visita.itens} - {""})
        linhas = [
            f"VISITA: {visita.titulo}",
            f"Data: {visita.inicio:%d/%m/%Y}",
            f"Mensagens das {visita.inicio:%H:%M} às {visita.fim:%H:%M}"
            + (f" (até {visita.fim:%d/%m/%Y})" if visita.fim.date() != visita.inicio.date() else ""),
            f"Enviado por: {', '.join(remetentes) or self.contato}",
            "Situação: " + ("concluída" if visita.concluida
                            else "em andamento (a visita fecha quando chegar o próximo separador)"),
            f"Fotos: {contagem.get('foto', 0)} | Vídeos: {contagem.get('video', 0)} | "
            f"Áudios: {contagem.get('audio', 0)} | Documentos: {contagem.get('documento', 0)} | "
            f"Localizações: {locais}",
            "",
            "=" * 60,
            "MENSAGENS",
            "=" * 60,
        ]
        for item in visita.itens:
            msg = item.msg
            marcas = [m for m, ok in (("encaminhada", msg.get("encaminhada")), ("editada", msg.get("editada"))) if ok]
            sufixo = f" ({', '.join(marcas)})" if marcas else ""
            hora = f"[{item.quando:%H:%M}]"
            linhas.append("")
            if item.arquivo:
                linhas.append(f"{hora} {item.arquivo}{sufixo}")
                if msg.get("legenda"):
                    linhas.append(f"    Legenda: {msg['legenda']}")
                if msg.get("erro_download"):
                    linhas.append("    (não foi possível baixar este arquivo do WhatsApp)")
            elif msg.get("local"):
                loc = msg["local"]
                descricao = " - ".join(x for x in (loc.get("nome"), loc.get("endereco")) if x)
                linhas.append(f"{hora} Localização{sufixo}: {descricao}".rstrip(": "))
                linhas.append(f"    https://maps.google.com/?q={loc['lat']},{loc['lon']}")
            else:
                linhas.append(f"{hora}{sufixo}")
                linhas.append(item.texto)
        return "\n".join(linhas) + "\n"

    def _dados_json(self, visita: Visita) -> dict:
        itens = []
        for item in visita.itens:
            msg = item.msg
            itens.append({k: v for k, v in {
                "quando": msg["quando"], "remetente": msg.get("remetente"),
                "tipo": msg.get("midia_tipo") or ("localizacao" if msg.get("local") else "texto"),
                "texto": item.texto or None, "arquivo": item.arquivo or None, "legenda": msg.get("legenda") or None,
                "local": msg.get("local"), "encaminhada": msg.get("encaminhada") or None,
                "editada": msg.get("editada") or None,
            }.items() if v is not None})
        return {"titulo": visita.titulo, "inicio": visita.inicio.isoformat(), "fim": visita.fim.isoformat(),
                "concluida": visita.concluida, "itens": itens}

    def _ler_estado(self) -> dict:
        try:
            return json.loads(self.arquivo_estado.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _salvar_estado(self, estado: dict) -> None:
        temporario = self.arquivo_estado.with_suffix(".tmp")
        temporario.write_text(json.dumps(estado, ensure_ascii=False, indent=2), encoding="utf-8")
        temporario.replace(self.arquivo_estado)
