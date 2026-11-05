#!/usr/bin/env python3
"""
Lê os "Informe Estoque Visual" enviados como imagem num grupo do WhatsApp e lança
os números numa planilha Excel.

Entrada: a exportação oficial do grupo (WhatsApp > grupo > Mais > Exportar conversa >
"Incluir mídia"). Aceita o .zip, a pasta extraída, ou uma pasta com várias exportações
(de vários grupos): use --grupo para escolher qual grupo processar.

Cada imagem é lida no próprio computador, com OCR (ver leitor_informe.py): sem API, sem
internet, sem custo. Imagens que não são um informe de estoque (fotos, prints etc.) são ignoradas.

A planilha recebe as abas:
  Resumo   uma linha por informe: data, unidade, totais, D-1, expedição, sucatas,
           conferência das somas, e quem enviou / quando / link da imagem
  Detalhe  uma linha por item das tabelas "Tamborado/Grelhado" e "A Tamborar"
           (os itens variam de unidade para unidade)
  Ignoradas imagens do grupo que não eram informe (para não lê-las de novo)

Rodar de novo só acrescenta as imagens que ainda não estão na planilha.

Uso:
    python coletar_imagens.py exportacoes/ --grupo "Estoque Gusa"
    python coletar_imagens.py "WhatsApp Chat - Estoque Gusa.zip" --planilha estoque.xlsx
    python coletar_imagens.py export.zip --desde 01/11/2026
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
import tempfile
import unicodedata
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

from leitor_informe import ErroLeitura, LeitorInforme

EXTENSOES_IMAGEM = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".bmp"}

INVISIVEIS = dict.fromkeys(map(ord, "‎‏‪‫‬‭‮﻿"), None)

RE_ANDROID = re.compile(
    r"^(?P<data>\d{1,2}/\d{1,2}/\d{2,4}),?\s+(?P<hora>\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap]\.?\s?[Mm]\.?)?)"
    r"\s+-\s+(?P<resto>.*)$"
)
RE_IOS = re.compile(
    r"^\[(?P<data>\d{1,2}/\d{1,2}/\d{2,4}),?\s+(?P<hora>\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap]\.?\s?[Mm]\.?)?)\]"
    r"\s+(?P<resto>.*)$"
)
RE_ANEXO_ANDROID = re.compile(
    r"(?P<arquivo>[^\s<>:]+\.\w{2,5})\s+\((?:arquivo anexado|file attached|archivo adjunto)\)",
    re.IGNORECASE,
)
RE_ANEXO_IOS = re.compile(r"<(?:anexado|attached|adjunto):\s*(?P<arquivo>[^>]+)>", re.IGNORECASE)
# Nome do grupo no nome do arquivo exportado
RE_NOME_GRUPO = re.compile(
    r"^(?:Conversa do WhatsApp com|WhatsApp Chat with|WhatsApp Chat -|Chat de WhatsApp con)\s*(?P<nome>.+?)"
    r"(?:\s*\(\d+\))?(?:\.zip|\.txt)?$",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------- planilha: colunas

ABA_RESUMO = "Resumo"
ABA_DETALHE = "Detalhe"
ABA_IGNORADAS = "Ignoradas"
COLUNAS_RESUMO = [
    ("Data do informe", 13), ("Unidade", 22),
    ("Tamborado/Grelhado (total)", 15), ("A tamborar (total)", 13),
    ("Aguardando reanálise/fora de faixa", 15), ("Estoque total visual", 13),
    ("Carregamento D-1", 13), ("Produção D-1", 12), ("Expedição volume (t)", 13),
    ("TT veículos", 10), ("Veículos em fila", 10), ("Gusa irregular", 11), ("Cargas de lingoteira", 12),
    ("Conferência", 30), ("Grupo", 20), ("Enviado em", 12), ("Hora", 9), ("Remetente", 20),
    ("Arquivo", 30), ("Legenda", 25), ("Link", 13), ("Hash (SHA-256)", 18),
]
COLUNAS_DETALHE = [
    ("Data do informe", 13), ("Unidade", 22), ("Seção", 20), ("Item", 32), ("Quantidade", 12),
    ("Arquivo", 30), ("Hash (SHA-256)", 18),
]
COLUNAS_IGNORADAS = [("Enviado em", 12), ("Remetente", 20), ("Arquivo", 30), ("Hash (SHA-256)", 18)]
CAMPOS_NUMERICOS = {
    "Tamborado/Grelhado (total)": "tamborado_grelhado_total",
    "A tamborar (total)": "a_tamborar_total",
    "Aguardando reanálise/fora de faixa": "aguardando_reanalise_fora_de_faixa",
    "Estoque total visual": "estoque_total_visual",
    "Carregamento D-1": "carregamento_d1",
    "Produção D-1": "producao_d1",
    "Expedição volume (t)": "expedicao_volume_t",
    "TT veículos": "tt_veiculos",
    "Veículos em fila": "veiculos_em_fila",
    "Gusa irregular": "gusa_irregular",
    "Cargas de lingoteira": "cargas_de_lingoteira",
}

# --------------------------------------------------------------------------- conferência


def conferir(informe: dict) -> str:
    """Confere as somas do próprio informe; divergência costuma indicar erro de leitura."""
    problemas = []

    def soma(itens):
        valores = [i["quantidade"] for i in itens if i["quantidade"] is not None]
        return round(sum(valores), 2) if valores else None

    for secao, chave in (("Tamborado", "tamborado_grelhado"), ("A tamborar", "a_tamborar")):
        s, total = soma(informe[chave]), informe[f"{chave}_total"]
        if s is not None and total is not None and abs(s - total) > 0.01:
            problemas.append(f"{secao}: itens somam {s:g}, total {total:g}")
    t1, t2, est = informe["tamborado_grelhado_total"], informe["a_tamborar_total"], informe["estoque_total_visual"]
    if None not in (t1, t2, est) and abs(t1 + t2 - est) > 0.01:
        problemas.append(f"Estoque total {est:g} ≠ {t1:g} + {t2:g}")
    vazios = [nome for nome, campo in CAMPOS_NUMERICOS.items() if informe[campo] is None]
    if vazios:
        problemas.append("sem valor: " + ", ".join(vazios))
    if informe.get("observacoes"):
        problemas.append(informe["observacoes"])
    return "; ".join(problemas) or "OK"


def data_do_informe(texto: str):
    try:
        return datetime.strptime(texto.strip(), "%d/%m/%Y").date()
    except ValueError:
        return texto or None


# --------------------------------------------------------------------------- conversa exportada


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
            remetente, conteudo = resto.split(": ", 1) if ": " in resto else ("", resto)
            mensagens.append(Mensagem(quando, remetente.strip(), [conteudo]))
        elif mensagens:
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


# --------------------------------------------------------------------------- escolha do grupo


def normalizar(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", sem_acento).strip().casefold()


def nome_do_grupo(caminho: Path) -> str | None:
    """Nome do grupo a partir do nome da exportação (.zip, pasta ou .txt)."""
    for candidato in [caminho, *(caminho.glob("*.txt") if caminho.is_dir() else [])]:
        m = RE_NOME_GRUPO.match(candidato.name)
        if m:
            return m["nome"].strip()
    return None


def listar_exportacoes(pasta: Path) -> list[Path]:
    """Numa pasta com várias exportações, cada .zip ou subpasta com .txt é uma exportação."""
    achadas = [p for p in sorted(pasta.iterdir()) if p.suffix.lower() == ".zip" and zipfile.is_zipfile(p)]
    achadas += [p for p in sorted(pasta.iterdir()) if p.is_dir() and any(p.glob("*.txt"))]
    return achadas


def escolher_exportacao(origem: Path, grupo: str | None) -> tuple[Path, str]:
    eh_uma_exportacao = origem.is_file() or any(origem.glob("*.txt"))
    if eh_uma_exportacao:
        nome = nome_do_grupo(origem) or ""
        if grupo and nome and normalizar(grupo) not in normalizar(nome):
            sys.exit(f'Esta exportação é do grupo "{nome}", não de "{grupo}".')
        return origem, nome or (grupo or "")

    exportacoes = [(p, nome_do_grupo(p) or p.stem) for p in listar_exportacoes(origem)]
    if not exportacoes:
        sys.exit(f"Nenhuma exportação do WhatsApp (.zip ou pasta com .txt) em {origem}")
    if not grupo:
        if len(exportacoes) == 1:
            return exportacoes[0]
        nomes = "\n  ".join(n for _, n in exportacoes)
        sys.exit(f"Há exportações de vários grupos nesta pasta. Escolha um com --grupo:\n  {nomes}")

    alvo = normalizar(grupo)
    exatos = [e for e in exportacoes if normalizar(e[1]) == alvo]
    parecidos = exatos or [e for e in exportacoes if alvo in normalizar(e[1])]
    if not parecidos:
        nomes = "\n  ".join(n for _, n in exportacoes)
        sys.exit(f'Nenhuma exportação do grupo "{grupo}". Grupos encontrados:\n  {nomes}')
    if len({normalizar(n) for _, n in parecidos}) > 1:
        nomes = "\n  ".join(n for _, n in parecidos)
        sys.exit(f'"{grupo}" combina com mais de um grupo; seja mais específico:\n  {nomes}')
    # Mesmo grupo exportado mais de uma vez: usa a exportação mais recente
    return max(parecidos, key=lambda e: e[0].stat().st_mtime)


def preparar_origem(origem: Path, temp: Path) -> Path:
    if origem.is_dir():
        return origem
    if zipfile.is_zipfile(origem):
        with zipfile.ZipFile(origem) as z:
            raiz = temp.resolve()
            for membro in z.infolist():
                destino = (raiz / membro.filename).resolve()
                if raiz not in destino.parents and destino != raiz:
                    sys.exit(f"Arquivo suspeito dentro do zip: {membro.filename}")
            z.extractall(raiz)
        return temp
    if origem.suffix.lower() == ".txt":
        return origem.parent
    sys.exit(f"Origem inválida: {origem} (use o .zip exportado, a pasta extraída ou o .txt)")


# --------------------------------------------------------------------------- planilha


def sha256(caminho: Path) -> str:
    h = hashlib.sha256()
    with caminho.open("rb") as f:
        for bloco in iter(lambda: f.read(1 << 16), b""):
            h.update(bloco)
    return h.hexdigest()


def preparar_aba(wb, nome: str, colunas: list[tuple[str, int]]):
    if nome in wb.sheetnames:
        return wb[nome]
    ws = wb.create_sheet(nome)
    for i, (titulo, largura) in enumerate(colunas, start=1):
        c = ws.cell(row=1, column=i, value=titulo)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="2F5D3A")
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = largura
    ws.row_dimensions[1].height = 45
    ws.freeze_panes = "A2"
    return ws


def abrir_planilha(caminho: Path):
    if caminho.exists():
        wb = load_workbook(caminho)
    else:
        wb = Workbook()
        wb.remove(wb.active)
    return (wb, preparar_aba(wb, ABA_RESUMO, COLUNAS_RESUMO), preparar_aba(wb, ABA_DETALHE, COLUNAS_DETALHE),
            preparar_aba(wb, ABA_IGNORADAS, COLUNAS_IGNORADAS))


def indice_colunas(ws) -> dict[str, int]:
    return {c.value: c.column for c in ws[1] if c.value}


def hashes_existentes(ws) -> set[str]:
    col = indice_colunas(ws)["Hash (SHA-256)"]
    return {str(v) for (v,) in ws.iter_rows(min_row=2, min_col=col, max_col=col, values_only=True) if v}


def escrever(ws, valores: dict) -> int:
    col = indice_colunas(ws)
    linha = ws.max_row + 1
    for nome, valor in valores.items():
        c = ws.cell(row=linha, column=col[nome], value=valor)
        if isinstance(valor, date):
            c.number_format = "DD/MM/YYYY"
        elif isinstance(valor, (int, float)) and not isinstance(valor, bool):
            c.number_format = "#,##0.##"
    return linha


def lancar(ws_resumo, ws_detalhe, reg: RegistroImagem, informe: dict, grupo: str,
           arquivo_final: Path, planilha: Path, hash_: str) -> None:
    data_inf = data_do_informe(informe["data_informe"])
    unidade = informe["unidade"]
    conferencia = conferir(informe)
    valores = {
        "Data do informe": data_inf, "Unidade": unidade,
        **{nome: informe[campo] for nome, campo in CAMPOS_NUMERICOS.items()},
        "Conferência": conferencia, "Grupo": grupo,
        "Enviado em": reg.quando.date(), "Hora": reg.quando.time(), "Remetente": reg.remetente,
        "Arquivo": reg.arquivo, "Legenda": reg.legenda or None, "Link": "Abrir imagem",
        "Hash (SHA-256)": hash_,
    }
    linha = escrever(ws_resumo, valores)
    col = indice_colunas(ws_resumo)
    ws_resumo.cell(row=linha, column=col["Hora"]).number_format = "HH:MM"
    link = ws_resumo.cell(row=linha, column=col["Link"])
    try:
        link.hyperlink = str(arquivo_final.resolve().relative_to(planilha.resolve().parent))
    except ValueError:
        link.hyperlink = arquivo_final.resolve().as_uri()
    link.font = Font(color="0563C1", underline="single")
    if conferencia != "OK":
        ws_resumo.cell(row=linha, column=col["Conferência"]).fill = PatternFill("solid", fgColor="FFE699")

    for secao, chave in (("Tamborado/Grelhado", "tamborado_grelhado"), ("A tamborar", "a_tamborar")):
        for item in informe[chave]:
            escrever(ws_detalhe, {
                "Data do informe": data_inf, "Unidade": unidade, "Seção": secao,
                "Item": item["item"], "Quantidade": item["quantidade"],
                "Arquivo": reg.arquivo, "Hash (SHA-256)": hash_,
            })


def finalizar_abas(*abas) -> None:
    for ws in abas:
        if ws.max_row > 1:
            ws.auto_filter.ref = f"A1:{get_column_letter(ws.max_column)}{ws.max_row}"


# --------------------------------------------------------------------------- principal


def data_br(texto: str) -> date:
    try:
        return datetime.strptime(texto, "%d/%m/%Y").date()
    except ValueError:
        raise argparse.ArgumentTypeError("use o formato DD/MM/AAAA")


def main() -> None:
    p = argparse.ArgumentParser(description="Lê os informes de estoque enviados num grupo do WhatsApp para uma planilha.")
    p.add_argument("origem", type=Path,
                   help="o .zip exportado, a pasta extraída, ou uma pasta com exportações de vários grupos")
    p.add_argument("--grupo", help="nome (ou parte do nome) do grupo a processar")
    p.add_argument("--planilha", type=Path, default=Path("estoque_visual.xlsx"),
                   help="planilha de saída (é criada, ou atualizada se já existir)")
    p.add_argument("--pasta-imagens", type=Path, default=None,
                   help="para onde copiar as imagens (padrão: pasta 'imagens' ao lado da planilha)")
    p.add_argument("--desde", type=data_br, help="só imagens enviadas a partir desta data (DD/MM/AAAA)")
    p.add_argument("--ate", type=data_br, help="só imagens enviadas até esta data (DD/MM/AAAA)")
    p.add_argument("--remetente", help="só imagens de quem tem este texto no nome")
    p.add_argument("--mes-primeiro", action="store_true",
                   help="datas da exportação no formato americano MM/DD/AAAA")
    args = p.parse_args()

    if not args.origem.exists():
        sys.exit(f"Não encontrei {args.origem}")
    leitor = LeitorInforme()

    exportacao, grupo = escolher_exportacao(args.origem, args.grupo)
    print(f"Grupo: {grupo or '(nome não identificado)'}  ←  {exportacao.name}")

    planilha: Path = args.planilha
    pasta_imagens: Path = args.pasta_imagens or planilha.resolve().parent / "imagens"
    pasta_imagens.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        pasta = preparar_origem(exportacao, Path(tmp))
        txt = exportacao if exportacao.suffix.lower() == ".txt" else encontrar_txt(pasta)
        mensagens = ler_mensagens(txt, args.mes_primeiro)
        registros = extrair_imagens(mensagens, pasta)
        print(f"{len(mensagens)} mensagens, {len(registros)} imagens na conversa")

        if args.desde:
            registros = [r for r in registros if r.quando.date() >= args.desde]
        if args.ate:
            registros = [r for r in registros if r.quando.date() <= args.ate]
        if args.remetente:
            filtro = args.remetente.casefold()
            registros = [r for r in registros if filtro in r.remetente.casefold()]

        wb, ws_resumo, ws_detalhe, ws_ignoradas = abrir_planilha(planilha)
        ja_lancadas = hashes_existentes(ws_resumo) | hashes_existentes(ws_ignoradas)
        novas = ignoradas = falhas = 0
        try:
            for reg in sorted(registros, key=lambda r: r.quando):
                hash_ = sha256(reg.caminho)
                if hash_ in ja_lancadas:
                    continue
                print(f"  {reg.quando:%d/%m/%Y %H:%M}  {reg.arquivo} ... ", end="", flush=True)
                try:
                    informe = leitor.ler(reg.caminho)
                except ErroLeitura as erro:
                    print(f"FALHOU ({erro})")
                    falhas += 1
                    continue
                if not informe["eh_informe_estoque"]:
                    print("não é informe de estoque, ignorada")
                    ignoradas += 1
                    ja_lancadas.add(hash_)
                    escrever(ws_ignoradas, {"Enviado em": reg.quando.date(), "Remetente": reg.remetente,
                                            "Arquivo": reg.arquivo, "Hash (SHA-256)": hash_})
                    continue

                destino = pasta_imagens / reg.arquivo
                if destino.exists() and sha256(destino) != hash_:
                    destino = pasta_imagens / f"{destino.stem}_{hash_[:8]}{destino.suffix}"
                shutil.copy2(reg.caminho, destino)
                lancar(ws_resumo, ws_detalhe, reg, informe, grupo, destino, planilha, hash_)
                ja_lancadas.add(hash_)
                novas += 1
                print(f"{informe['unidade']} {informe['data_informe']} "
                      f"estoque {informe['estoque_total_visual']}  [{conferir(informe)}]")
        finally:  # salva o que já foi lido mesmo se algo der errado no meio
            finalizar_abas(ws_resumo, ws_detalhe, ws_ignoradas)
            planilha.parent.mkdir(parents=True, exist_ok=True)
            try:
                wb.save(planilha)
            except PermissionError:
                sys.exit(f"Não consegui salvar {planilha}. Ela está aberta no Excel? Feche e rode de novo.")

    print(f"\n{novas} informes lançados em {planilha}; {ignoradas} imagens não eram informe; {falhas} falharam.")
    if falhas:
        print("Rode de novo para tentar as que falharam (as já lançadas não são repetidas).")


if __name__ == "__main__":
    main()
