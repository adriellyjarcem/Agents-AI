#!/usr/bin/env python3
"""
Importa as visitas antigas (recebidas antes de ligar o monitor) a partir da exportação da conversa.

No celular: abra a conversa com a pessoa > ⋮ > Mais > Exportar conversa > "Incluir mídia".
Salve o .zip no computador e rode, NA PASTA DO MONITOR DAS VISITAS:

    py importar_visitas.py "Conversa do WhatsApp com Fulano.zip"

O importador:
  - usa a mesma configuração do monitor (config.json: contato e pasta das visitas);
  - separa as visitas pelas linhas de traços, como o monitor, e cria/atualiza as mesmas pastas;
  - pula o que o monitor já coletou (mesmo texto ou mesma foto no mesmo horário), então pode rodar com
    o monitor ligado e pode rodar de novo com uma exportação mais nova sem duplicar nada;
  - ignora mensagens apagadas e as enviadas por você (só entram as da pessoa).

Opções:
    --remetente "Nome"     nome da pessoa como aparece na exportação (se houver dúvida, ele pergunta)
    --desde / --ate        só mensagens neste período (DD/MM/AAAA)
    --visitas-pasta PASTA  outra pasta de destino (padrão: a do config.json)
    --mes-primeiro         datas da exportação no formato americano (MM/DD)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import shutil
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

PASTA = Path(__file__).resolve().parent
sys.path.insert(0, str(PASTA))

try:
    import coletar_imagens as ci  # noqa: E402  (leitura da exportação do WhatsApp)
    import visitas as vs  # noqa: E402
except ModuleNotFoundError as erro:
    sys.exit(f"Falta a biblioteca '{erro.name}'. Rode o instalar.bat, ou: py -m pip install -r requirements.txt")

FOTOS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".bmp"}
VIDEOS = {".mp4", ".3gp", ".mov", ".avi", ".mkv"}
AUDIOS = {".opus", ".ogg", ".m4a", ".mp3", ".aac", ".amr", ".wav"}
RE_EDITADA = re.compile(r"\s*<(?:Esta mensagem foi editada|Mensagem editada|This message was edited|"
                        r"Este mensaje fue editado|Editada)\.?>\s*$", re.IGNORECASE)
RE_APAGADA = re.compile(r"^(?:Esta mensagem foi (?:apagada|exclu[ií]da)|Mensagem apagada|Voc[eê] apagou esta mensagem|"
                        r"This message was deleted|You deleted this message|Se elimin[oó] este mensaje)\.?$",
                        re.IGNORECASE)
RE_MIDIA_OCULTA = re.compile(r"^<(?:M[ií]dia oculta|Media omitted|Multimedia omitido)>$", re.IGNORECASE)
JANELA_DUPLICADA = timedelta(minutes=2)


def data_br(texto: str) -> date:
    try:
        return datetime.strptime(texto, "%d/%m/%Y").date()
    except ValueError:
        raise argparse.ArgumentTypeError("use o formato DD/MM/AAAA")


def sha256(caminho: Path) -> str:
    h = hashlib.sha256()
    with caminho.open("rb") as f:
        for bloco in iter(lambda: f.read(1 << 16), b""):
            h.update(bloco)
    return h.hexdigest()


def tipo_do_arquivo(nome: str) -> str | None:
    ext = Path(nome).suffix.lower()
    if nome.upper().startswith("STK-"):
        return None  # figurinha
    if ext in FOTOS:
        return "foto"
    if ext in VIDEOS:
        return "video"
    if ext in AUDIOS:
        return "audio"
    return "documento"


def texto_normal(texto: str) -> str:
    return re.sub(r"\s+", " ", texto or "").strip().casefold()


def escolher_remetente(mensagens, pedido: str | None, contato_config: str) -> str:
    contagem: dict[str, int] = {}
    for m in mensagens:
        if m.remetente:
            contagem[m.remetente] = contagem.get(m.remetente, 0) + 1
    if not contagem:
        sys.exit("Não encontrei mensagens com remetente nesta exportação.")
    if pedido:
        achados = [r for r in contagem if vs.normalizar(pedido) in vs.normalizar(r)]
        if len(achados) == 1:
            return achados[0]
        sys.exit(f'"{pedido}" {"combina com mais de um" if achados else "não combina com nenhum"} remetente: '
                 + ", ".join(contagem))
    # Contato salvo só como número: a exportação mostra o número
    chave = vs.chave_numero(contato_config) if contato_config else ""
    if chave:
        por_numero = [r for r in contagem if len(re.sub(r"\D", "", r)) >= 10 and vs.chave_numero(r) == chave]
        if len(por_numero) == 1:
            return por_numero[0]
    if len(contagem) == 1:
        return next(iter(contagem))
    print("\nQuem envia as visitas nesta conversa?")
    nomes = sorted(contagem, key=lambda r: -contagem[r])
    for i, r in enumerate(nomes, 1):
        print(f"  {i}. {r}  ({contagem[r]} mensagens)")
    while True:
        resposta = input("Número: ").strip()
        if resposta.isdigit() and 1 <= int(resposta) <= len(nomes):
            return nomes[int(resposta) - 1]
        print("Digite um dos números da lista.")


def main() -> None:
    p = argparse.ArgumentParser(description="Importa visitas antigas da exportação da conversa do WhatsApp.")
    p.add_argument("origem", type=Path, help="o .zip exportado (com mídia), a pasta extraída ou o .txt")
    p.add_argument("--remetente", help="nome da pessoa que manda as visitas, como aparece na exportação")
    p.add_argument("--desde", type=data_br, help="só mensagens a partir desta data (DD/MM/AAAA)")
    p.add_argument("--ate", type=data_br, help="só mensagens até esta data (DD/MM/AAAA)")
    p.add_argument("--visitas-pasta", help="pasta de destino das visitas (padrão: a configurada no monitor)")
    p.add_argument("--mes-primeiro", action="store_true", help="datas no formato americano MM/DD/AAAA")
    args = p.parse_args()

    if not args.origem.exists():
        sys.exit(f"Não encontrei {args.origem}")
    tela = logging.StreamHandler(sys.stdout)
    tela.setFormatter(logging.Formatter("%(message)s"))
    logging.getLogger("monitor").addHandler(tela)
    logging.getLogger("monitor").setLevel(logging.INFO)
    logging.getLogger("monitor").propagate = False
    try:
        config = json.loads((PASTA / "config.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        config = {}
    destino = args.visitas_pasta or config.get("visitas_pasta")
    if not destino:
        sys.exit("Não sei para onde mandar as visitas. Rode na pasta do monitor das visitas, ou use "
                 '--visitas-pasta "C:\\...\\Relatórios de visita".')
    contato = config.get("visitas_contato", "")
    coletor = vs.ColetorVisitas(PASTA / "visitas", Path(destino.strip('"')), contato)

    with tempfile.TemporaryDirectory() as tmp:
        pasta = ci.preparar_origem(args.origem, Path(tmp))
        txt = args.origem if args.origem.suffix.lower() == ".txt" else ci.encontrar_txt(pasta)
        mensagens = ci.ler_mensagens(txt, args.mes_primeiro)
        print(f"Exportação: {txt.name} ({len(mensagens)} mensagens)")
        remetente = escolher_remetente(mensagens, args.remetente, contato)
        print(f"Importando as mensagens de: {remetente}")
        arquivos = {a.name: a for a in pasta.rglob("*") if a.is_file()}

        # O que o monitor (ou uma importação anterior) já tem
        atuais = coletor.mensagens()
        ids = {m["id"] for m in atuais}
        textos = [(datetime.fromisoformat(m["quando"]), texto_normal(m["texto"])) for m in atuais if "texto" in m]
        midias = {}
        for m in atuais:
            if m.get("midia") and (coletor.midia / m["midia"]).exists():
                caminho = coletor.midia / m["midia"]
                midias.setdefault(sha256(caminho), []).append(datetime.fromisoformat(m["quando"]))

        novos, contagem = [], {"texto": 0, "foto": 0, "video": 0, "audio": 0, "documento": 0}
        ja_tinha = apagadas = ocultas = faltando = 0
        for indice, msg in enumerate(mensagens):
            if msg.remetente != remetente:
                continue
            if (args.desde and msg.quando.date() < args.desde) or (args.ate and msg.quando.date() > args.ate):
                continue
            texto = msg.texto
            editada = bool(RE_EDITADA.search(texto))
            texto = RE_EDITADA.sub("", texto).strip()
            if RE_APAGADA.match(texto) or texto == "null":
                apagadas += 1
                continue
            if RE_MIDIA_OCULTA.match(texto):
                ocultas += 1
                continue
            base = {"quando": msg.quando.isoformat(), "remetente": remetente, "importada": True}
            if editada:
                base["editada"] = True
            anexos = ci.RE_ANEXO_ANDROID.findall(texto) + ci.RE_ANEXO_IOS.findall(texto)
            if anexos:
                nome = anexos[0].strip()
                legenda = ci.RE_ANEXO_IOS.sub("", ci.RE_ANEXO_ANDROID.sub("", texto)).strip()
                tipo = tipo_do_arquivo(nome)
                if tipo is None:
                    continue
                arquivo = arquivos.get(nome)
                ident = "exp-" + hashlib.sha1(f"{msg.quando}|{remetente}|{nome}|{indice}".encode()).hexdigest()[:16]
                if ident in ids:
                    ja_tinha += 1
                    continue
                if arquivo is None:
                    faltando += 1
                    registro = {**base, "id": ident, "tipo": "msg", "faltando": nome}
                else:
                    h = sha256(arquivo)
                    if h in midias:  # o monitor já tem esta foto
                        ja_tinha += 1
                        continue
                    ext = arquivo.suffix.lower()
                    shutil.copyfile(arquivo, coletor.midia / f"{ident}{ext}")
                    registro = {**base, "id": ident, "tipo": "msg", "midia_tipo": tipo, "legenda": legenda,
                                "ext": ext, "nome_original": nome if tipo == "documento" else "",
                                "midia": f"{ident}{ext}"}
                    midias.setdefault(h, []).append(msg.quando)
                    contagem[tipo] += 1
            else:
                if not texto:
                    continue
                ident = "exp-" + hashlib.sha1(f"{msg.quando}|{remetente}|{texto}|{indice}".encode()).hexdigest()[:16]
                normal = texto_normal(texto)
                if ident in ids or any(t == normal and abs(q - msg.quando) <= JANELA_DUPLICADA for q, t in textos):
                    ja_tinha += 1
                    continue
                registro = {**base, "id": ident, "tipo": "msg", "texto": texto}
                textos.append((msg.quando, normal))
                contagem["texto"] += 1
            novos.append(registro)
            ids.add(registro["id"])

    if novos:
        coletor.adicionar(novos)
    print(f"\nNovas: {contagem['texto']} textos, {contagem['foto']} fotos, {contagem['video']} vídeos, "
          f"{contagem['audio']} áudios, {contagem['documento']} documentos.")
    if ja_tinha:
        print(f"Já estavam coletadas (puladas): {ja_tinha}")
    if apagadas:
        print(f"Mensagens apagadas ignoradas: {apagadas}")
    if ocultas:
        print(f"ATENÇÃO: {ocultas} mídias vieram como '<Mídia oculta>'. Exporte de novo escolhendo 'Incluir mídia'.")
    if faltando:
        print(f"ATENÇÃO: {faltando} arquivos citados na conversa não vieram na exportação "
              "(o WhatsApp limita a quantidade de mídia exportada; exporte de novo ou por período).")
    try:
        atualizadas = coletor.publicar()
    except OSError as erro:
        sys.exit(f"As mensagens foram guardadas, mas não consegui montar as pastas ({erro}). "
                 "O monitor monta quando o destino estiver disponível, ou rode este importador de novo.")
    print(f"Pastas de visita criadas/atualizadas: {atualizadas}  ->  {coletor.destino}")


if __name__ == "__main__":
    main()
