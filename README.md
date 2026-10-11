# Escritório Virtual 🏢

Um escritório em pixel art onde cada sessão do **Claude Code** vira um personagem.
Cada projeto ganha uma sala, cada agente senta numa mesa e mostra num balão o que
está fazendo ("Buscando \"description\"", "Editando index.tsx"...). Quando termina,
o agente fica livre, passeia pelo escritório (café, sofá, bebedouro, estante, jardim) e
conversa com os amigos, cada um com sua personalidade.

## Como rodar

Requer Node 18+.

```bash
npm install
npm start            # abre o escritório em http://localhost:4321
```

Para ver funcionando sem o Claude Code, em outro terminal:

```bash
npm run demo         # simula 7 agentes em 3 projetos
```

## Ligar no Claude Code de verdade

```bash
npm run install-hooks
```

Isso adiciona hooks no `~/.claude/settings.json` (global, para todos os projetos aparecerem).
Os hooks que você já tinha são mantidos, e o arquivo original fica salvo em `settings.json.bak`.
Depois é só abrir sessões do Claude Code normalmente com o `npm start` rodando.

- Só em um projeto: `node scripts/install-hooks.mjs --project caminho/do/projeto`
- Remover: `npm run remove-hooks`

Se o servidor estiver desligado, o hook simplesmente não faz nada, e o Claude Code não é afetado.
A porta pode ser trocada com a variável `OFFICE_PORT` (vale para o servidor e para o hook).

## Como funciona

```
Claude Code ──hooks──▶ hooks/office-hook.mjs ──POST /event──▶ server/index.mjs ──WebSocket──▶ public/office.js (Phaser)
Claude Code ──status line──▶ hooks/office-statusline.mjs ──POST /usage──▶ server/index.mjs
```

| Evento do Claude Code | O que acontece no escritório                      |
| --------------------- | ------------------------------------------------- |
| `SessionStart`        | Um personagem entra e vai para a sala do projeto  |
| `UserPromptSubmit`    | Senta na mesa: "Pensando…"                        |
| `PreToolUse`          | Balão com a ação (buscar, ler, editar, rodar…)    |
| `Notification`        | Balão laranja "Precisa de você!"                  |
| `Stop`                | "Entregue ✓" e fica livre para passear            |
| `SessionEnd`          | Diz tchau e sai do escritório                     |

- **Salas**: uma por projeto (nome da pasta da sessão), 3 por fileira, 6 mesas cada.
- **Personalidades**: em [`config/personas.json`](config/personas.json). Edite nomes, cores,
  lugares favoritos (`cafe`, `bebedouro`, `sofa`, `estante`, `jardim`), amigos e falas.
- **Vida social**: a cada 5 s o servidor sorteia agentes livres para passear ou se juntar
  com um amigo num lugar que os dois gostam e trocar algumas falas.

## Barras de uso (limite de 5 h e semanal)

No topo aparecem duas barras com quanto do plano você já usou na janela de 5 horas e na semana,
e quando cada uma reinicia. Elas ficam verdes, amarelas a partir de 60% e vermelhas a partir de 85%.

O Claude Code só informa esses limites para o **status line**, então o `npm run install-hooks`
também configura um status line (`hooks/office-statusline.mjs`) que repassa os números ao escritório.
Se você já tinha um status line, ele é guardado em `config/statusline-anterior.json` e continua
aparecendo igual no terminal; o `npm run remove-hooks` coloca ele de volta. Para não mexer no status
line, instale com `node scripts/install-hooks.mjs --no-statusline` (aí as barras não aparecem).

Os números só existem para quem usa o Claude Code com assinatura do Claude (Pro/Max) e aparecem
depois da primeira resposta da sessão. Com várias contas, as barras mostram a que falou por último.

## Conversas com IA (Claude Haiku)

Quando dois amigos se encontram, as falas são escritas pelo **Claude Haiku 5.5**, no jeito de
cada personalidade e comentando o que cada um fez no dia (as últimas ações que apareceram nos
balões). Cada dupla lembra da última conversa para não repetir assunto.

Para ligar, basta ter uma credencial da API da Anthropic no ambiente em que roda o `npm start`:

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # ou faça login com `ant auth login`
npm start
```

Sem credencial, o escritório usa as falas fixas do `personas.json` e avisa isso uma vez no terminal.

| Variável                   | Padrão             | Para que serve                         |
| -------------------------- | ------------------ | -------------------------------------- |
| `OFFICE_LLM`               | ligado             | `off` desliga as conversas com IA      |
| `OFFICE_LLM_MODEL`         | `claude-haiku-5-5` | Modelo usado nas conversas             |
| `OFFICE_LLM_MAX_PER_HOUR`  | `120`              | Limite de conversas geradas por hora   |

Custo: cada conversa é uma chamada curta ao Haiku, então mesmo no limite de 120 por hora o
gasto fica em centavos de dólar por hora. Vale saber que o resumo das ações (nomes de arquivos,
padrões de busca, descrições de comandos) vai no pedido para a API.

Controles: arraste para mover a câmera e use a roda do mouse para zoom.

## Próximos passos

- [x] Conversas geradas pelo Claude Haiku, no estilo de cada personalidade
- [x] Barras de uso (limite de 5 h e semanal) no topo
- [ ] Trocar os sprites desenhados por código por um tileset de verdade (ex.: Tiled + LimeZu)
- [ ] Mostrar subagentes como "estagiários" ao lado do agente principal
