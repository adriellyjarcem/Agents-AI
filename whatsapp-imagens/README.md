# Informe Estoque Visual: WhatsApp → planilha

Script em Python que pega as imagens do **Informe Estoque Visual** enviadas num grupo
do WhatsApp, **lê cada imagem** e lança os números numa planilha Excel.

## O que vai para a planilha

- **Resumo**: uma linha por informe: data, unidade, total Tamborado/Grelhado, total A Tamborar,
  Aguardando reanálise, Estoque total visual, Carregamento D-1, Produção D-1, Expedição (t),
  TT veículos, Veículos em fila, Gusa irregular, Cargas de lingoteira, **Conferência**, e
  quem enviou, quando, e um link para a imagem.
- **Detalhe**: uma linha por item das tabelas Tamborado/Grelhado e A Tamborar (os itens
  mudam de unidade para unidade, ex.: "Aciária" em Ribas, "(P) Média de 0,130" em Corumbá).
- **Ignoradas**: imagens do grupo que não eram informe (fotos, prints), para não serem lidas de novo.

A coluna **Conferência** refaz as contas do próprio informe (itens somam o total? Tamborado + A Tamborar
= Estoque total?) e fica amarela quando algo não bate, o que geralmente indica erro de leitura.

Rodar de novo com uma exportação mais nova **só acrescenta os informes novos**.

## 1. Exportar o grupo

No celular: abra o grupo → ⋮ → **Mais** → **Exportar conversa** → **Incluir mídia**.
Salve o `.zip` numa pasta no computador (pode juntar exportações de vários grupos na mesma pasta).

## 2. Instalar

```bash
pip install -r requirements.txt
```

A leitura das imagens usa a API do Claude (Anthropic). Crie uma chave em
https://console.anthropic.com e defina a variável de ambiente:

```bash
set ANTHROPIC_API_KEY=sua-chave        # Windows (cmd)
export ANTHROPIC_API_KEY=sua-chave     # Linux / Mac
```

## 3. Rodar

```bash
python coletar_imagens.py pasta_das_exportacoes --grupo "Estoque Gusa"
```

`--grupo` aceita parte do nome, sem diferenciar maiúsculas e acentos. Se a pasta tiver vários
grupos e você não disser qual, o script lista os grupos encontrados. Também dá para apontar
direto para um `.zip`.

| Opção | O que faz |
|---|---|
| `--planilha estoque.xlsx` | planilha de saída (padrão `estoque_visual.xlsx`) |
| `--pasta-imagens pasta` | onde guardar as cópias das imagens (padrão `imagens/` ao lado da planilha) |
| `--desde 01/11/2026` / `--ate 30/11/2026` | filtra pela data de envio |
| `--remetente "Maria"` | só imagens de quem tem esse nome |
| `--modelo` | modelo do Claude usado na leitura |
| `--mes-primeiro` | se o celular exporta datas no formato americano (MM/DD) |
