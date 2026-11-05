#!/usr/bin/env python3
"""
Leitura local (sem API, sem internet) da imagem do "Informe Estoque Visual", com OCR (RapidOCR).

Como funciona:
  1. A imagem é padronizada (tamanho) e endireitada, se estiver levemente torta.
  2. O OCR devolve cada trecho de texto da imagem com a sua posição.
  3. Cada campo é achado pelo rótulo ("Carregamento D-1:", "Total:", "TT Veículos:"...) e o
     valor é o número logo à direita, alinhado na mesma linha e dentro do mesmo painel.
  4. Se o OCR não detectou o número, a célula é recortada, limpa das linhas da tabela e lida sozinha.
  5. As tabelas "Tamborado/Grelhado" e "A Tamborar" são lidas linha a linha, entre o cabeçalho e
     a linha "Total:", então funcionam com qualquer quantidade e nome de itens.

Para testar numa imagem:
    python leitor_informe.py imagem.jpg            # mostra os campos lidos
    python leitor_informe.py imagem.jpg --caixas   # mostra também tudo o que o OCR viu
"""

from __future__ import annotations

import json
import math
import re
import sys
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
from PIL import Image

# Rótulos dos campos simples: chave -> início do rótulo (sem acento, sem espaço, minúsculo)
ROTULOS = {
    "aguardando_reanalise_fora_de_faixa": ("aguardandoreanalise",),
    "estoque_total_visual": ("estoquetotal", "visual"),  # rótulo em duas linhas
    "carregamento_d1": ("carregamentod-1",),
    "producao_d1": ("producaod-1",),
    "expedicao_volume_t": ("volume(t)",),
    "tt_veiculos": ("ttveiculos",),
    "veiculos_em_fila": ("veiculosem", "fila"),  # rótulo em duas linhas
    "gusa_irregular": ("gusairregular",),
    "cargas_de_lingoteira": ("cargasdelingoteira",),
}
PALAVRAS_MINUSCULAS = {"de", "do", "da", "dos", "das", "e"}
LARGURA_PADRAO = 1000  # largura em que o OCR rendeu melhor nos testes com os informes
CONFIANCA_MINIMA = 0.8

RE_NUMERO = re.compile(r"-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?|-?\d+\.\d{1,2}")
RE_NUMERO_NO_FIM = re.compile(r"[\s:]\s*(-?[\d.,]+)\s*$")
RE_DATA = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")


class ErroLeitura(Exception):
    pass


def normalizar(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", "", sem_acento).casefold()


def para_numero(texto: str) -> float | int | None:
    """Converte número no padrão brasileiro: '1.080' -> 1080, '71,66' -> 71.66, '300,00' -> 300."""
    t = texto.strip().replace(" ", "").rstrip(".:")
    if not RE_NUMERO.fullmatch(t):
        return None
    if "," in t:
        t = t.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"-?\d{1,3}(?:\.\d{3})+", t):
        t = t.replace(".", "")
    valor = float(t)
    return int(valor) if valor.is_integer() else valor


@dataclass(eq=False)
class Caixa:
    texto: str
    x0: float
    x1: float
    y0: float
    y1: float
    confianca: float
    angulo: float = 0.0  # inclinação do texto, em graus

    @property
    def norm(self) -> str:
        return normalizar(self.texto)

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def altura(self) -> float:
        return self.y1 - self.y0

    @property
    def numero(self):
        return para_numero(self.texto)


def comeca_com(texto_norm: str, prefixo: str) -> bool:
    """startswith tolerante a pequenos erros do OCR em rótulos longos ("produgaod-1")."""
    if texto_norm.startswith(prefixo):
        return True
    if len(prefixo) < 8:
        return False
    return SequenceMatcher(None, texto_norm[:len(prefixo)], prefixo).ratio() >= 0.85


def unir(caixas: list[Caixa]) -> Caixa:
    return Caixa(" ".join(c.texto for c in caixas), min(c.x0 for c in caixas), max(c.x1 for c in caixas),
                 min(c.y0 for c in caixas), max(c.y1 for c in caixas), min(c.confianca for c in caixas))


def sobreposicao_vertical(a: Caixa, b: Caixa) -> float:
    """Fração da altura da menor caixa que se sobrepõe à outra na vertical."""
    return (min(a.y1, b.y1) - max(a.y0, b.y0)) / max(min(a.altura, b.altura), 1)


class LeitorInforme:
    def __init__(self):
        try:
            from rapidocr import RapidOCR
        except ImportError:
            sys.exit("Falta a biblioteca de OCR. Instale com:  pip install -r requirements.txt")
        self.ocr = RapidOCR(params={"Global.log_level": "error"})

    # ------------------------------------------------------------------ OCR

    def caixas(self, img: np.ndarray) -> list[Caixa]:
        # O modo vai sempre explícito: o RapidOCR guarda o último modo usado entre chamadas.
        # use_cls=False: o classificador de orientação às vezes vira um trecho de cabeça para
        # baixo ("600" vira "009"), e os informes nunca vêm invertidos.
        r = self.ocr(img, use_det=True, use_cls=False, use_rec=True)
        if r.boxes is None:
            return []
        saida = []
        for b, t, s in zip(r.boxes, r.txts, r.scores):
            (xa, ya), (xb, yb) = b[0], b[1]  # canto superior esquerdo e direito
            saida.append(Caixa(t, float(b[:, 0].min()), float(b[:, 0].max()), float(b[:, 1].min()),
                               float(b[:, 1].max()), float(s), math.degrees(math.atan2(yb - ya, xb - xa))))
        return saida

    def _carregar(self, caminho: Path) -> tuple[np.ndarray, list[Caixa]]:
        try:
            with Image.open(caminho) as img:
                img = img.convert("RGB")
        except Exception as erro:
            raise ErroLeitura(f"não consegui abrir a imagem ({erro})")
        if not 700 <= img.width <= 1300:
            fator = LARGURA_PADRAO / img.width
            img = img.resize((LARGURA_PADRAO, round(img.height * fator)), Image.LANCZOS)
        caixas = self.caixas(np.array(img))

        # Imagem torta (foto da tela, por exemplo): endireita pela inclinação dos textos e lê de novo
        angulos = [c.angulo for c in caixas if c.x1 - c.x0 > 3 * c.altura]
        if angulos:
            inclinacao = float(np.median(angulos))
            if 0.3 < abs(inclinacao) < 15:
                img = img.rotate(inclinacao, resample=Image.BICUBIC, expand=True, fillcolor="white")
                caixas = self.caixas(np.array(img))
        return np.array(img), caixas

    def _ler_recorte(self, img: np.ndarray, x0, x1, y0, y1):
        """Lê o número de uma célula que o OCR da página inteira não pegou."""
        h, w = img.shape[:2]
        x0, x1 = max(int(x0), 0), min(int(x1), w)
        y0, y1 = max(int(y0), 0), min(int(y1), h)
        if x1 - x0 < 5 or y1 - y0 < 5:
            return None, 0.0
        recorte = img[y0:y1, x0:x1].copy()
        # Apaga as linhas da tabela, que confundem o OCR (viram "1" ou escondem o número)
        tinta = recorte.mean(axis=2) < 160
        recorte[:, tinta.mean(axis=0) > 0.6] = 255
        recorte[tinta.mean(axis=1) > 0.5, :] = 255
        if (recorte.mean(axis=2) < 160).sum() < 6:
            return None, 0.0  # célula vazia

        melhores = []
        base = Image.fromarray(recorte)
        for escala in (1, 2):
            im = base.resize((base.width * escala, base.height * escala), Image.LANCZOS) if escala > 1 else base
            fundo = Image.new("RGB", (im.width + 20, im.height + 20), "white")
            fundo.paste(im, (10, 10))
            melhores += [c for c in self.caixas(np.array(fundo)) if c.numero is not None]
            if melhores:
                break
        if not melhores:
            # Último recurso: um dígito sozinho às vezes não é "detectado", mas é reconhecido
            # se entregamos ao OCR só a área com tinta
            tinta = recorte.mean(axis=2) < 160
            ys, xs = np.nonzero(tinta)
            p = 4
            area = recorte[max(ys.min() - p, 0):ys.max() + p + 1, max(xs.min() - p, 0):xs.max() + p + 1]
            r = self.ocr(area, use_det=False, use_cls=False, use_rec=True)
            if r.txts and para_numero(r.txts[0]) is not None:
                return para_numero(r.txts[0]), float(r.scores[0])
            return None, 0.0
        # Prefere leituras confiáveis e, entre elas, a mais completa (mais dígitos)
        c = max(melhores, key=lambda c: (c.confianca >= 0.7, len(re.sub(r"\D", "", c.texto)), c.confianca))
        return c.numero, c.confianca

    # ------------------------------------------------------------------ localização

    def _achar(self, caixas: list[Caixa], prefixo: str, painel=None, abaixo_de: float = -1):
        """Acha o rótulo pelo começo do texto; junta dois pedaços se o OCR separou o rótulo."""
        candidatas = [c for c in caixas if (painel is None or painel(c)) and c.y0 > abaixo_de]
        achadas = [c for c in candidatas if comeca_com(c.norm, prefixo)]
        for a in candidatas:
            if achadas or not prefixo.startswith(a.norm) or not a.norm:
                continue
            vizinhas = [b for b in candidatas if b is not a and b.x0 > a.x1 - 2
                        and b.x0 - a.x1 < 1.5 * a.altura and sobreposicao_vertical(a, b) > 0.5]
            for b in sorted(vizinhas, key=lambda b: b.x0)[:1]:
                if comeca_com(a.norm + b.norm, prefixo):
                    achadas.append(unir([a, b]))
        return min(achadas, key=lambda c: c.y0) if achadas else None

    def _valor_a_direita(self, img, caixas, rotulos: list[Caixa], limite_direita: float, no_painel,
                         numero_no_rotulo: bool = True):
        rotulo = unir(rotulos)
        # Valor grudado no rótulo pelo OCR ("Total: 780")
        if numero_no_rotulo:
            m = RE_NUMERO_NO_FIM.search(rotulos[-1].texto)
            if m and para_numero(m.group(1)) is not None:
                return para_numero(m.group(1)), rotulos[-1].confianca

        # O valor fica antes do próximo rótulo da mesma linha
        for c in sorted(caixas, key=lambda c: c.x0):
            if c.x0 > rotulo.x1 and c.numero is None and no_painel(c) and sobreposicao_vertical(c, rotulo) > 0.3:
                limite_direita = min(limite_direita, c.x0)
                break

        candidatos = [c for c in caixas if c.numero is not None and c not in self._usadas
                      and c.x0 >= rotulo.x1 - 2 and c.x1 <= limite_direita + 2
                      and sobreposicao_vertical(c, rotulo) > 0.5
                      and abs(c.cy - rotulo.cy) < 0.6 * max(c.altura, min(r.altura for r in rotulos))]
        if candidatos:
            c = min(candidatos, key=lambda c: (abs(c.cy - rotulo.cy) > 0.25 * c.altura, c.x0))
            self._usadas.add(c)
            return c.numero, c.confianca

        margem = min(r.altura for r in rotulos) * 0.25
        return self._ler_recorte(img, rotulo.x1 + 3, limite_direita - 3, rotulo.y0 - margem, rotulo.y1 + margem)

    def _tabela(self, img, caixas, cabecalho: Caixa, painel, limite_direita, avisos, nome):
        total = self._achar(caixas, "total", painel, abaixo_de=cabecalho.y1 - 1)
        if total is None:
            avisos.append(f"{nome}: linha Total não encontrada")
            return [], None
        dentro = sorted([c for c in caixas if painel(c) and cabecalho.y1 < c.cy < total.y0],
                        key=lambda c: (c.cy, c.x0))

        itens, usadas = [], set()
        for c in dentro:
            if c in usadas or c.numero is not None:
                continue
            # Junta pedaços do nome do item que o OCR separou ("(P) Média de" + "0,130 Quente").
            # Só junta o que está colado; o valor fica bem mais à direita, na outra coluna.
            partes = [c]
            for d in sorted(dentro, key=lambda d: d.x0):
                if d not in usadas and d.x0 > partes[-1].x1 and sobreposicao_vertical(d, c) > 0.5 \
                        and d.x0 - partes[-1].x1 < 1.2 * c.altura:
                    partes.append(d)
            usadas.update(partes)
            nome_item = " ".join(p.texto for p in partes).strip().rstrip(":").strip()
            valor, conf = self._valor_a_direita(img, caixas, partes, limite_direita, painel,
                                                numero_no_rotulo=False)
            if valor is None:
                avisos.append(f"{nome}: sem valor para '{nome_item}'")
            elif conf < CONFIANCA_MINIMA:
                avisos.append(f"{nome}: leitura incerta em '{nome_item}' ({valor:g})")
            itens.append({"item": nome_item, "quantidade": valor})

        valor_total, conf = self._valor_a_direita(img, caixas, [total], limite_direita, painel)
        if valor_total is None:
            avisos.append(f"{nome}: sem valor no Total")
        elif conf < CONFIANCA_MINIMA:
            avisos.append(f"{nome}: leitura incerta no Total ({valor_total:g})")
        return itens, valor_total

    # ------------------------------------------------------------------ principal

    def ler(self, caminho: Path, caixas_lidas: list | None = None) -> dict:
        img, caixas = self._carregar(caminho)
        self._usadas: set = set()
        if caixas_lidas is not None:
            caixas_lidas.extend(caixas)
        largura = img.shape[1]
        normas = " ".join(c.norm for c in caixas)

        cab_esq = self._achar(caixas, "tamborado")
        cab_dir = self._achar(caixas, "atamborar")
        eh_informe = ("estoquevisual" in normas or "estoquetotal" in normas) and cab_esq and cab_dir
        if not eh_informe:
            return {"eh_informe_estoque": False}

        resultado = {"eh_informe_estoque": True}
        avisos: list[str] = []
        divisao = (cab_esq.cx + cab_dir.cx) / 2

        def esquerda(c):
            return c.cx < divisao

        def direita(c):
            return c.cx >= divisao

        # Data e unidade (cabeçalho)
        datas = [m for c in caixas for m in [RE_DATA.search(c.texto)] if m]
        resultado["data_informe"] = "{:0>2}/{:0>2}/{}".format(*datas[0].groups()) if datas else ""
        titulo = self._achar(caixas, "informe")
        topo_gusa = min((c.y0 for c in caixas if c.norm.startswith("gestaodegusa")), default=cab_esq.y0)
        x_titulo = titulo.x1 if titulo else largura * 0.75
        partes = sorted([c for c in caixas if c.cy < topo_gusa and c.x0 > x_titulo
                         and c.norm not in ("vs", "v5") and not RE_DATA.search(c.texto)], key=lambda c: c.y0)
        unidade = re.sub(r"^\s*V[S5]\s+", "", " ".join(c.texto for c in partes).strip(), flags=re.IGNORECASE)
        resultado["unidade"] = " ".join(p.lower() if p.lower() in PALAVRAS_MINUSCULAS and i else p.capitalize()
                                        for i, p in enumerate(unidade.split()))
        if not resultado["unidade"]:
            avisos.append("unidade não encontrada")
        if not resultado["data_informe"]:
            avisos.append("data não encontrada")

        # Tabelas
        resultado["tamborado_grelhado"], resultado["tamborado_grelhado_total"] = self._tabela(
            img, caixas, cab_esq, esquerda, divisao, avisos, "Tamborado")
        resultado["a_tamborar"], resultado["a_tamborar_total"] = self._tabela(
            img, caixas, cab_dir, direita, largura, avisos, "A tamborar")

        # Campos simples
        for chave, prefixos in ROTULOS.items():
            primeiro = self._achar(caixas, prefixos[0])
            if primeiro is None:
                resultado[chave] = None
                avisos.append(f"rótulo de '{chave}' não encontrado")
                continue
            painel = esquerda if esquerda(primeiro) else direita
            rotulos = [primeiro]
            if len(prefixos) > 1:
                segundo = self._achar(caixas, prefixos[1], painel, abaixo_de=primeiro.y0 + primeiro.altura * 0.5)
                if segundo is not None and segundo.y0 - primeiro.y1 < 2 * primeiro.altura:
                    rotulos.append(segundo)
            limite = divisao if painel is esquerda else largura
            valor, conf = self._valor_a_direita(img, caixas, rotulos, limite, painel)
            resultado[chave] = valor
            if valor is None:
                avisos.append(f"sem valor para '{chave}'")
            elif conf < CONFIANCA_MINIMA:
                avisos.append(f"leitura incerta em '{chave}' ({valor:g})")

        resultado["observacoes"] = "; ".join(avisos)
        return resultado


def main():
    import argparse
    p = argparse.ArgumentParser(description="Lê um Informe Estoque Visual e mostra os campos.")
    p.add_argument("imagens", nargs="+", type=Path)
    p.add_argument("--caixas", action="store_true", help="mostra todos os textos que o OCR encontrou")
    args = p.parse_args()
    leitor = LeitorInforme()
    for caminho in args.imagens:
        caixas = []
        r = leitor.ler(caminho, caixas)
        print(f"== {caminho}")
        if args.caixas:
            for c in sorted(caixas, key=lambda c: (c.y0, c.x0)):
                print(f"   y {c.y0:5.0f}-{c.y1:<5.0f} x {c.x0:5.0f}-{c.x1:<5.0f} {c.confianca:.2f}  {c.texto}")
        print(json.dumps(r, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
