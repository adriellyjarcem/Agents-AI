#!/usr/bin/env python3
"""
Coleta as imagens de um grupo do WhatsApp e lança as informações numa planilha Excel.

Funciona a partir da exportação oficial da conversa (WhatsApp > grupo > Mais >
Exportar conversa > "Incluir mídia"), que gera um .zip com o _chat.txt/"Conversa do
WhatsApp com ....txt" e os arquivos de mídia. Aceita tanto o .zip quanto a pasta já
extraída, e exportações feitas no Android ou no iPhone, em português ou inglês.

Para cada imagem encontrada, a planilha recebe:
  Data | Hora | Remetente | Arquivo | Legenda | Largura | Altura | Tamanho (KB) |
  Hash (SHA-256) | Texto da imagem (OCR, opcional) | Link para o arquivo | Miniatura (opcional)

Rodar de novo com uma exportação mais nova só acrescenta as imagens que ainda não
estão na planilha (a comparação é pelo hash do arquivo).

Uso:
    python coletar_imagens.py "WhatsApp Chat - Grupo.zip"
    python coletar_imagens.py pasta_extraida --planilha imagens.xlsx --miniaturas
    python coletar_imagens.py export.zip --desde 01/10/2026 --remetente "Maria"
    python coletar_imagens.py export.zip --ocr        # requer pytesseract + Tesseract
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

try:
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
except ImportError:  # pragma: no cover
    sys.exit("Falta a biblioteca openpyxl. Instale com:  pip install -r requirements.txt")

try:
    from PIL import Image as PILImage
except ImportError:  # Pillow é opcional, mas sem ela não há dimensões nem miniaturas
    PILImage = None

EXTENSOES_IMAGEM = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".bmp"}

# Caracteres invisíveis que o WhatsApp coloca nas exportações (marcas de direção etc.)
INVISIVEIS = dict.fromkeys(map(ord, "‎‏‪‫‬‭‮﻿"), None)

# Android: "05/11/2026 14:32 - Fulano: mensagem"  (também "05/11/26, 2:32 PM - ...")
RE_ANDROID = re.compile(
    r"^(?P<data>\d{1,2}/\d{1,2}/\d{2,4}),?\s+(?P<hora>\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap]\.?\s?[Mm]\.?)?)"
    r"\s+-\s+(?P<resto>.*)$"
)
# iPhone: "[05/11/2026, 14:32:10] Fulano: mensagem"
RE_IOS = re.compile(
    r"^\[(?P<data>\d{1,2}/\d{1,2}/\d{2,4}),?\s+(?P<hora>\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap]\.?\s?[Mm]\.?)?)\]"
    r"\s+(?P<resto>.*)$"
)
# Referências a anexos dentro do texto da mensagem
RE_ANEXO_ANDROID = re.compile(
    r"(?P<arquivo>[^\s<>:]+\.\w{2,5})\s+\((?:arquivo anexado|file attached|archivo adjunto)\)",
    re.IGNORECASE,
)
RE_ANEXO_IOS = re.compile(r"<(?:anexado|attached|adjunto):\s*(?P<arquivo>[^>]+)>", re.IGNORECASE)

COLUNAS = [
    ("Data", 12),
    ("Hora", 9),
    ("Remetente", 24),
    ("Arquivo", 34),
    ("Legenda", 40),
    ("Largura", 9),
    ("Altura", 9),
    ("Tamanho (KB)", 12),
    ("Hash (SHA-256)", 20),
    ("Texto da imagem (OCR)", 45),
    ("Link", 14),
    ("Miniatura", 18),
]
COL = {nome: i + 1 for i, (nome, _) in enumerate(COLUNAS)}


@dataclass
class Mensagem:
    quando: datetime
    remetente: str
    linhas: list[str] = field(default_factory=list)

    @property
    def texto(self) -> str:
        return "\n".join(self.linhas).strip()


@dataclass
class RegistroImagem:
    quando: datetime
    remetente: str
    arquivo: str
    legenda: str
    caminho: Path


# --------------------------------------------------------------------------- leitura


def interpretar_data_hora(data: str, hora: str, mes_primeiro: bool) -> datetime | None:
    hora = hora.replace(".", "").replace(" ", " ").upper().strip()
    formatos_hora = ["%H:%M:%S", "%H:%M", "%I:%M:%S %p", "%I:%M %p", "%I:%M:%S%p", "%I:%M%p"]
    ordem = ["%m/%d", "%d/%m"] if mes_primeiro else ["%d/%m", "%m/%d"]
    for dm in ordem:
        for ano in ("%Y", "%y"):
            for fh in formatos_hora:
                try:
                    return datetime.strptime(f"{data} {hora}", f"{dm}/{ano} {fh}")
                except ValueError:
                    continue
    return None


def ler_mensagens(arquivo_txt: Path, mes_primeiro: bool) -> list[Mensagem]:
    mensagens: list[Mensagem] = []
    texto = arquivo_txt.read_text(encoding="utf-8", errors="replace")
    for linha_bruta in texto.splitlines():
        linha = linha_bruta.translate(INVISIVEIS)
        m = RE_IOS.match(linha) or RE_ANDROID.match(linha)
        quando = interpretar_data_hora(m["data"], m["hora"], mes_primeiro) if m else None
        if m and quando:
            resto = m["resto"]
            if ": " in resto:
                remetente, conteudo = resto.split(": ", 1)
            else:  # mensagem de sistema ("Fulano entrou usando o link...")
                remetente, conteudo = "", resto
            mensagens.append(Mensagem(quando, remetente.strip(), [conteudo]))
        elif mensagens:  # continuação da mensagem anterior (quebra de linha / legenda)
            mensagens[-1].linhas.append(linha)
    return mensagens


def extrair_imagens(mensagens: list[Mensagem], pasta: Path) -> list[RegistroImagem]:
    arquivos_por_nome = {p.name: p for p in pasta.rglob("*") if p.is_file()}
    registros: list[RegistroImagem] = []
    for msg in mensagens:
        texto = msg.texto
        achados = [(a, RE_ANEXO_ANDROID) for a in RE_ANEXO_ANDROID.findall(texto)]
        achados += [(a, RE_ANEXO_IOS) for a in RE_ANEXO_IOS.findall(texto)]
        for nome, regex in achados:
            nome = nome.strip()
            if Path(nome).suffix.lower() not in EXTENSOES_IMAGEM:
                continue
            caminho = arquivos_por_nome.get(nome)
            if caminho is None:
                print(f"  aviso: {nome} citado na conversa mas não está na exportação", file=sys.stderr)
                continue
            legenda = regex.sub("", texto).strip()
            registros.append(RegistroImagem(msg.quando, msg.remetente, nome, legenda, caminho))
    return registros


def encontrar_txt(pasta: Path) -> Path:
    candidatos = sorted(pasta.rglob("*.txt"), key=lambda p: p.stat().st_size, reverse=True)
    if not candidatos:
        sys.exit(f"Nenhum arquivo .txt de conversa encontrado em {pasta}")
    preferidos = [p for p in candidatos if p.name == "_chat.txt" or "whatsapp" in p.name.lower()]
    return (preferidos or candidatos)[0]


# --------------------------------------------------------------------------- imagens


def sha256(caminho: Path) -> str:
    h = hashlib.sha256()
    with caminho.open("rb") as f:
        for bloco in iter(lambda: f.read(1 << 16), b""):
            h.update(bloco)
    return h.hexdigest()


def dimensoes(caminho: Path) -> tuple[int | None, int | None]:
    if PILImage is None:
        return None, None
    try:
        with PILImage.open(caminho) as img:
            return img.size
    except Exception:
        return None, None


def ler_texto_ocr(caminho: Path, idioma: str) -> str:
    try:
        import pytesseract
    except ImportError:
        sys.exit("Para usar --ocr instale:  pip install pytesseract  (e o programa Tesseract-OCR)")
    try:
        with PILImage.open(caminho) as img:
            return pytesseract.image_to_string(img, lang=idioma).strip()
    except Exception as erro:
        return f"(erro no OCR: {erro})"


def criar_miniatura(origem: Path, destino: Path, lado: int = 120) -> Path | None:
    if PILImage is None:
        return None
    try:
        with PILImage.open(origem) as img:
            img = img.convert("RGB")
            img.thumbnail((lado, lado))
            destino.parent.mkdir(parents=True, exist_ok=True)
            img.save(destino, "JPEG", quality=80)
        return destino
    except Exception:
        return None


# --------------------------------------------------------------------------- planilha


def abrir_planilha(caminho: Path):
    if caminho.exists():
        wb = load_workbook(caminho)
        ws = wb["Imagens"] if "Imagens" in wb.sheetnames else wb.active
        return wb, ws
    wb = Workbook()
    ws = wb.active
    ws.title = "Imagens"
    cabecalho = Font(bold=True, color="FFFFFF")
    fundo = PatternFill("solid", fgColor="128C7E")
    for i, (nome, largura) in enumerate(COLUNAS, start=1):
        c = ws.cell(row=1, column=i, value=nome)
        c.font, c.fill = cabecalho, fundo
        c.alignment = Alignment(horizontal="center", vertical="center")
        ws.column_dimensions[get_column_letter(i)].width = largura
    ws.freeze_panes = "A2"
    return wb, ws


def hashes_existentes(ws) -> set[str]:
    return {
        str(v) for (v,) in ws.iter_rows(min_row=2, min_col=COL["Hash (SHA-256)"],
                                         max_col=COL["Hash (SHA-256)"], values_only=True) if v
    }


def adicionar_linha(ws, reg: RegistroImagem, arquivo_final: Path, planilha: Path,
                    hash_: str, ocr: str, miniatura: Path | None) -> None:
    largura, altura = dimensoes(arquivo_final)
    linha = ws.max_row + 1
    valores = {
        "Data": reg.quando.date(),
        "Hora": reg.quando.time(),
        "Remetente": reg.remetente,
        "Arquivo": reg.arquivo,
        "Legenda": reg.legenda,
        "Largura": largura,
        "Altura": altura,
        "Tamanho (KB)": round(arquivo_final.stat().st_size / 1024, 1),
        "Hash (SHA-256)": hash_,
        "Texto da imagem (OCR)": ocr,
    }
    for nome, valor in valores.items():
        c = ws.cell(row=linha, column=COL[nome], value=valor)
        c.alignment = Alignment(vertical="top", wrap_text=nome in ("Legenda", "Texto da imagem (OCR)"))
    ws.cell(row=linha, column=COL["Data"]).number_format = "DD/MM/YYYY"
    ws.cell(row=linha, column=COL["Hora"]).number_format = "HH:MM:SS"

    link = ws.cell(row=linha, column=COL["Link"], value="Abrir imagem")
    try:
        link.hyperlink = str(arquivo_final.resolve().relative_to(planilha.resolve().parent))
    except ValueError:
        link.hyperlink = arquivo_final.resolve().as_uri()
    link.font = Font(color="0563C1", underline="single")

    if miniatura is not None:
        from openpyxl.drawing.image import Image as XLImage
        img = XLImage(str(miniatura))
        ws.add_image(img, f"{get_column_letter(COL['Miniatura'])}{linha}")
        ws.row_dimensions[linha].height = max(img.height * 0.75 + 4, 15)


# --------------------------------------------------------------------------- principal


def preparar_origem(origem: Path, temp: Path) -> Path:
    if origem.is_dir():
        return origem
    if zipfile.is_zipfile(origem):
        with zipfile.ZipFile(origem) as z:
            raiz = temp.resolve()
            for membro in z.infolist():  # evita caminhos maliciosos ("../")
                destino = (raiz / membro.filename).resolve()
                if raiz not in destino.parents and destino != raiz:
                    sys.exit(f"Arquivo suspeito dentro do zip: {membro.filename}")
            z.extractall(raiz)
        return temp
    if origem.suffix.lower() == ".txt":
        return origem.parent
    sys.exit(f"Origem inválida: {origem} (use o .zip exportado, a pasta extraída ou o .txt)")


def data_br(texto: str) -> date:
    try:
        return datetime.strptime(texto, "%d/%m/%Y").date()
    except ValueError:
        raise argparse.ArgumentTypeError("use o formato DD/MM/AAAA")


def main() -> None:
    p = argparse.ArgumentParser(description="Coleta imagens de um grupo do WhatsApp para uma planilha.")
    p.add_argument("origem", type=Path, help="o .zip exportado do WhatsApp, a pasta extraída ou o .txt")
    p.add_argument("--planilha", type=Path, default=Path("imagens_whatsapp.xlsx"),
                   help="planilha de saída (é criada, ou atualizada se já existir)")
    p.add_argument("--pasta-imagens", type=Path, default=None,
                   help="para onde copiar as imagens (padrão: pasta 'imagens' ao lado da planilha)")
    p.add_argument("--desde", type=data_br, help="só imagens a partir desta data (DD/MM/AAAA)")
    p.add_argument("--ate", type=data_br, help="só imagens até esta data (DD/MM/AAAA)")
    p.add_argument("--remetente", help="só imagens de quem tem este texto no nome")
    p.add_argument("--miniaturas", action="store_true", help="insere uma miniatura de cada imagem na planilha")
    p.add_argument("--ocr", action="store_true", help="lê o texto das imagens (pytesseract + Tesseract)")
    p.add_argument("--idioma-ocr", default="por", help="idioma do Tesseract (padrão: por)")
    p.add_argument("--mes-primeiro", action="store_true",
                   help="datas da exportação no formato americano MM/DD/AAAA")
    args = p.parse_args()

    if not args.origem.exists():
        sys.exit(f"Não encontrei {args.origem}")
    if args.ocr and PILImage is None:
        sys.exit("Para usar --ocr instale também o Pillow:  pip install pillow")

    planilha: Path = args.planilha
    pasta_imagens: Path = args.pasta_imagens or planilha.resolve().parent / "imagens"
    pasta_imagens.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        pasta = preparar_origem(args.origem, Path(tmp))
        txt = encontrar_txt(pasta) if args.origem.suffix.lower() != ".txt" else args.origem
        print(f"Lendo conversa: {txt.name}")
        mensagens = ler_mensagens(txt, args.mes_primeiro)
        registros = extrair_imagens(mensagens, pasta)
        print(f"{len(mensagens)} mensagens, {len(registros)} imagens na exportação")

        if args.desde:
            registros = [r for r in registros if r.quando.date() >= args.desde]
        if args.ate:
            registros = [r for r in registros if r.quando.date() <= args.ate]
        if args.remetente:
            filtro = args.remetente.casefold()
            registros = [r for r in registros if filtro in r.remetente.casefold()]

        wb, ws = abrir_planilha(planilha)
        ja_lancadas = hashes_existentes(ws)
        novas = 0
        for reg in sorted(registros, key=lambda r: r.quando):
            hash_ = sha256(reg.caminho)
            if hash_ in ja_lancadas:
                continue
            destino = pasta_imagens / reg.arquivo
            if destino.exists() and sha256(destino) != hash_:
                destino = pasta_imagens / f"{destino.stem}_{hash_[:8]}{destino.suffix}"
            shutil.copy2(reg.caminho, destino)

            ocr = ler_texto_ocr(destino, args.idioma_ocr) if args.ocr else ""
            mini = None
            if args.miniaturas:
                mini = criar_miniatura(destino, pasta_imagens / ".miniaturas" / f"{hash_[:16]}.jpg")
            adicionar_linha(ws, reg, destino, planilha, hash_, ocr, mini)
            ja_lancadas.add(hash_)
            novas += 1
            print(f"  + {reg.quando:%d/%m/%Y %H:%M}  {reg.remetente or '-':<20}  {reg.arquivo}")

        if ws.max_row > 1:
            ws.auto_filter.ref = f"A1:{get_column_letter(len(COLUNAS))}{ws.max_row}"
        planilha.parent.mkdir(parents=True, exist_ok=True)
        try:
            wb.save(planilha)
        except PermissionError:
            sys.exit(f"Não consegui salvar {planilha}. Ela está aberta no Excel? Feche e rode de novo.")

    print(f"\n{novas} imagens novas lançadas em {planilha} (imagens copiadas para {pasta_imagens})")


if __name__ == "__main__":
    main()
