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

Controles: arraste para mover a câmera e use a roda do mouse para zoom.

## Próximos passos

- [ ] Conversas geradas pelo Claude Haiku, no estilo de cada personalidade
- [ ] Barras de uso (limite de 5 h e semanal) no topo
- [ ] Trocar os sprites desenhados por código por um tileset de verdade (ex.: Tiled + LimeZu)
- [ ] Mostrar subagentes como "estagiários" ao lado do agente principal
