# Coleta de imagens de grupo do WhatsApp → planilha

Script em Python que pega todas as imagens enviadas num grupo do WhatsApp e lança
numa planilha Excel (`.xlsx`): data, hora, quem enviou, nome do arquivo, legenda,
dimensões, tamanho, hash, link para abrir a imagem e, se quiser, miniatura e o texto
lido da imagem (OCR).

## 1. Exportar o grupo

No celular: abra o grupo → ⋮ (ou nome do grupo no iPhone) → **Mais** → **Exportar conversa**
→ **Incluir mídia**. Mande o `.zip` para o computador (e-mail, Drive etc.).

## 2. Instalar

```bash
pip install -r requirements.txt
```

## 3. Rodar

```bash
python coletar_imagens.py "Conversa do WhatsApp com Grupo.zip"
```

Gera `imagens_whatsapp.xlsx` e copia as fotos para a pasta `imagens/` ao lado dela.
Rodar de novo com uma exportação mais nova **só acrescenta as imagens novas**.

Opções úteis:

| Opção | O que faz |
|---|---|
| `--planilha caminho.xlsx` | escolhe a planilha de saída |
| `--pasta-imagens pasta` | onde guardar as cópias das imagens |
| `--desde 01/10/2026` / `--ate 31/10/2026` | filtra por período |
| `--remetente "Maria"` | só imagens de quem tem esse nome |
| `--miniaturas` | coloca uma miniatura de cada foto na planilha |
| `--ocr` | lê o texto das imagens (notas, comprovantes); precisa de `pip install pytesseract` e do [Tesseract](https://github.com/UB-Mannheim/tesseract/wiki) com o idioma português |
| `--mes-primeiro` | se o celular exporta datas no formato americano (MM/DD) |

Aceita o `.zip`, a pasta já extraída ou o `.txt`; exportações do Android e do iPhone, em português ou inglês.
