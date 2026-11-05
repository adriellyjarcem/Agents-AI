# Informe Estoque Visual: WhatsApp → planilha

Script em Python que pega as imagens do **Informe Estoque Visual** enviadas num grupo
do WhatsApp, **lê cada imagem** e lança os números numa planilha Excel.

A leitura é feita **no próprio computador**, com OCR (biblioteca RapidOCR): sem API, sem
internet e sem custo por imagem. Leva cerca de 1 segundo por imagem.

## O que vai para a planilha

- **Resumo**: uma linha por informe: data, unidade, total Tamborado/Grelhado, total A Tamborar,
  Aguardando reanálise, Estoque total visual, Carregamento D-1, Produção D-1, Expedição (t),
  TT veículos, Veículos em fila, Gusa irregular, Cargas de lingoteira, **Conferência**, e
  quem enviou, quando, e um link para a imagem.
- **Detalhe**: uma linha por item das tabelas Tamborado/Grelhado e A Tamborar (os itens
  mudam de unidade para unidade, ex.: "Aciária" em Ribas, "(P) Média de 0,130" em Corumbá).
- **Ignoradas**: imagens do grupo que não eram informe (fotos, prints), para não serem lidas de novo.

A coluna **Conferência** fica amarela quando algo precisa de um olhar humano:
- as contas do próprio informe não batem (itens não somam o total, ou Tamborado + A Tamborar ≠ Estoque total);
- algum campo ficou sem valor;
- o OCR leu um número com baixa confiança ("leitura incerta").

## Instalar (uma vez)

Requer Python 3.10 ou mais novo ([python.org](https://www.python.org/downloads/); na instalação,
marque **"Add python.exe to PATH"**).

**No Windows:** dê dois cliques em `instalar.bat`. Ele acha o Python, instala as bibliotecas e
testa; se algo der errado, diz o que fazer.

**Pelo cmd:** dentro da pasta `whatsapp-imagens`:

```bash
py -m pip install -r requirements.txt
```

Os modelos de OCR vêm junto com a biblioteca; a leitura das imagens funciona sem internet.

## Modo automático (tempo real), recomendado

O monitor fica conectado ao WhatsApp e lança cada informe na planilha **assim que ele chega no grupo**.

1. Dê dois cliques em `iniciar_monitor.bat`.
2. Na primeira vez aparece um **QR code** (na janela e numa imagem que abre sozinha). No celular do
   número que está no grupo: **WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho**
   e leia o QR code.
3. O monitor lista os grupos do número: digite o número do grupo dos informes.
4. Pronto. A sessão e o grupo ficam salvos; das próximas vezes ele já conecta sozinho.

Depois dessa primeira vez, dá para rodar **sem janela nenhuma**:

| Arquivo | O que faz |
|---|---|
| `iniciar_oculto.vbs` | inicia o monitor escondido, em segundo plano |
| `parar_monitor.bat` | para o monitor (escondido ou com janela) |
| `ativar_inicio_automatico.bat` | inicia escondido sempre que você entra no Windows (rodar de novo desativa) |
| `monitor.log` | tudo o que o monitor fez: conexões, imagens recebidas, informes lançados, erros |

Só roda um monitor por vez: se tentar abrir outro, ele avisa e não abre. Se o WhatsApp pedir um
QR code novo com o monitor escondido, a imagem do QR code abre sozinha na tela.

O que é bom saber:
- **O PC precisa estar ligado** (e sem entrar em suspensão: Configurações → Sistema → Energia).
  Mensagens que chegam com o PC desligado são entregues quando o monitor volta a conectar.
- Se a planilha estiver **aberta no Excel**, o lançamento espera e tenta de novo a cada minuto;
  feche a planilha para os dados entrarem. Nada se perde: cada imagem é salva em `imagens/`
  (com um `.json` de quem enviou e quando) antes de ser lançada, e o que ficou pendente é lançado
  quando o monitor abre de novo.
- O histórico do que aconteceu fica em `monitor.log`.
- Para trocar de grupo: `py monitorar_grupo.py --trocar-grupo`.
- Se o celular desconectar o aparelho, o monitor pede um QR code novo.
- Imagens enviadas **antes** de conectar o monitor não são pegas: para essas, use o modo manual abaixo.

> ⚠️ O monitor usa a biblioteca **neonize**, um cliente **não oficial** do WhatsApp (o WhatsApp não
> oferece API para ler grupos comuns). Ele só lê mensagens, o que é de baixo risco, mas o WhatsApp
> pode bloquear números que usam clientes não oficiais. O mais seguro é usar um **número dedicado**
> (um chip só para isso) adicionado ao grupo.

## Modo manual (exportação da conversa)

Útil para lançar o histórico antigo. No celular: abra o grupo → ⋮ → **Mais** → **Exportar conversa**
→ **Incluir mídia**. Salve o `.zip` numa pasta e rode:

```bash
py coletar_imagens.py pasta_das_exportacoes --grupo "Estoque Gusa"
```

`--grupo` aceita parte do nome, sem diferenciar maiúsculas e acentos. Se a pasta tiver vários
grupos e você não disser qual, o script lista os grupos encontrados. Também dá para apontar
direto para um `.zip`. Rodar de novo com uma exportação mais nova só acrescenta os informes novos.

| Opção | O que faz |
|---|---|
| `--planilha estoque.xlsx` | planilha de saída (padrão `estoque_visual.xlsx`) |
| `--pasta-imagens pasta` | onde guardar as cópias das imagens (padrão `imagens/` ao lado da planilha) |
| `--desde 01/11/2026` / `--ate 30/11/2026` | filtra pela data de envio |
| `--remetente "Maria"` | só imagens de quem tem esse nome |
| `--mes-primeiro` | se o celular exporta datas no formato americano (MM/DD) |

## Testar a leitura de uma imagem

```bash
py leitor_informe.py imagem.jpg
py leitor_informe.py imagem.jpg --caixas   # mostra tudo o que o OCR enxergou
```

Útil se um informe novo vier com um layout diferente e algum campo não for lido.

## Como a leitura funciona

1. A imagem é padronizada no tamanho e endireitada se estiver levemente torta (foto da tela).
2. O OCR acha cada texto da imagem e a sua posição.
3. Cada campo é localizado pelo **rótulo** ("Carregamento D-1:", "TT Veículos:", "Total:"...) e o
   valor é o número à direita, alinhado na mesma linha e no mesmo painel. Por isso o script não
   depende de posições fixas e aceita as diferenças entre as unidades.
4. Se o número não foi encontrado, a célula é recortada, limpa das linhas da tabela e lida sozinha.

Testado com os informes de Ribas do Rio Pardo e Corumbá, inclusive em versões degradadas
(JPEG muito comprimido, imagem pequena, grande, desfocada e girada 1,5°): todos os campos corretos.
