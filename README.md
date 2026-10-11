# Escritório Virtual 🏢

Um escritório em pixel art onde cada sessão do **Claude Code** vira um personagem.
Cada projeto ganha uma sala, cada agente senta numa mesa e mostra num balão o que
está fazendo ("Buscando \"description\"", "Editando index.tsx"...). Quando termina,
o agente fica livre, passeia pelo escritório (café, sofá, bebedouro, estante, jardim) e
conversa com os amigos, cada um com sua personalidade.

## Como rodar

Requer Node 18+ e o Claude Code instalado.

**No Windows:** dê dois cliques em `iniciar.bat`. Ele instala o que falta na primeira vez, sobe o
escritório e abre o navegador. Deixe a janela preta aberta enquanto estiver usando.

**Pelo terminal (qualquer sistema):**

```bash
npm install
npm run abrir        # sobe o escritório e abre http://localhost:4321
```

(`npm start` faz o mesmo sem abrir o navegador.)

Para ver funcionando sem o Claude Code, em outro terminal:

```bash
npm run demo         # simula 7 agentes em 3 projetos
```

## Ligar no Claude Code de verdade

```bash
npm run install-hooks
```

Isso adiciona hooks no `~/.claude/settings.json` (global, para todos os projetos aparecerem)
e cria os subagentes do time em `~/.claude/agents/` (veja abaixo).
Os hooks que você já tinha são mantidos, e o arquivo original fica salvo em `settings.json.bak`.
Depois é só abrir sessões do Claude Code normalmente com o escritório rodando.
Rode de novo sempre que atualizar o projeto (`git pull`), para pegar hooks e subagentes novos.

- Só em um projeto: `node scripts/install-hooks.mjs --project caminho/do/projeto`
- Remover: `npm run remove-hooks`

Se o servidor estiver desligado, o hook simplesmente não faz nada, e o Claude Code não é afetado.
A porta pode ser trocada com a variável `OFFICE_PORT` (vale para o servidor e para o hook).

## Versão online (abrir de qualquer lugar, até do celular)

O escritório pode rodar num servidor na internet, protegido por senha. Assim você abre de qualquer
lugar, e sessões do Claude Code de várias máquinas (inclusive na nuvem, em claude.ai/code) aparecem
juntas.

**1. Publicar no Render (gratuito)**

1. Crie uma conta em [render.com](https://render.com) entrando com o GitHub.
2. **New → Blueprint**, escolha este repositório e confirme. O `render.yaml` já configura tudo.
3. Quando terminar, copie o endereço do serviço (algo como `https://escritorio-virtual-xxxx.onrender.com`)
   e, em **Environment**, o valor de `OFFICE_TOKEN`: é a senha do escritório.
4. Abra o endereço e digite a senha. Dica: salve nos favoritos o link
   `https://SEU-ENDERECO.onrender.com/#senha=SUA_SENHA` e ele entra direto.

No plano gratuito o servidor "dorme" depois de 15 minutos sem uso e leva até 1 minuto para
acordar. Os hooks mandam os eventos em segundo plano, então o Claude Code nunca fica esperando.

**2. Ligar o seu computador no escritório online**

Na pasta do projeto:

```bash
npm run install-hooks -- --url https://SEU-ENDERECO.onrender.com --token SUA_SENHA
```

Para voltar ao escritório local: `npm run install-hooks -- --local`.

**3. Sessões na nuvem (claude.ai/code)**

Para um repositório aparecer quando você trabalha nele pela nuvem, embuta o hook nele e faça commit:

```bash
npm run install-hooks -- --project CAMINHO/DO/REPOSITORIO --embutir
cd CAMINHO/DO/REPOSITORIO
git add .claude && git commit -m "Hooks do escritório virtual" && git push
```

Depois, no ambiente da nuvem (configurações do ambiente em claude.ai/code), adicione as variáveis
`OFFICE_URL` (o endereço do Render) e `OFFICE_TOKEN` (a senha). A senha nunca vai para o repositório.

**Privacidade:** online, os hooks mandam só o nome da pasta, nomes de arquivo, padrões de busca, a
descrição dos comandos e só o *nome do programa* rodado (`git`, `npm`), nunca o comando completo nem o
conteúdo de arquivos.

## O time: coordenadores e subagentes

Cada sessão do Claude Code que você abre aparece como um **coordenador** (Ana, Bruno, Júlia, Tiago).
Os outros personagens são **subagentes de verdade** do Claude Code, cada um com um papel:

| Personagem | Papel | Mexe nos arquivos? |
| ---------- | ----- | ------------------ |
| Ícaro | Prototipador: protótipos, scripts e automações | sim |
| Igor | Testador: escreve e roda testes | sim |
| Maitê | Front-end e UX: telas, CSS, acessibilidade | sim |
| Camila | Planejadora: quebra tarefas grandes em passos | não |
| Wagner | Depurador: investiga bugs e logs | sim |
| Vitória | Performance: mede e otimiza | sim |
| Ricardo | Segurança: revisa vulnerabilidades | não |
| Nicolas | Explorador: explica como o código funciona | não |
| Luan | Refatorador: simplifica sem mudar comportamento | sim |
| Helena | Documentadora: README, guias e comentários | sim |

O Claude Code delega sozinho quando a tarefa combina com um papel, ou você pode pedir direto:
*"peça ao Igor para escrever testes para o carrinho"*, *"chama o Ricardo para revisar o login"*.
Quando isso acontece, o personagem entra pela porta da sala, senta numa mesa, mostra o que está
fazendo e sai quando termina.

Os papéis ficam no `config/personas.json` (`papel`, `quandoUsar`, `instrucoes`, `ferramentas`).
Depois de editar, rode `npm run install-hooks` de novo. O instalador só sobrescreve os arquivos de
subagente que ele mesmo criou; um `~/.claude/agents/igor.md` feito por você nunca é tocado.
Para não criar subagentes, use `node scripts/install-hooks.mjs --no-subagents`.

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
| `SubagentStart`/`Stop`| O subagente entra na sala, trabalha e sai         |
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

## Visual (tileset)

O escritório usa um tileset de pixel art próprio, desenhado pixel a pixel em
[`scripts/build-tileset.mjs`](scripts/build-tileset.mjs) e salvo em `public/assets/`:

- `office.png` + `office.json`: móveis, pisos, paredes, plantas e jardim (atlas do Phaser, 16 px por tile, desenhado em 2x).
- `chars.png`: personagens-modelo com animação de andar em 3 direções, sentado de costas (mesa) e de frente (sofá),
  em dois estilos de cabelo. As cores-chave são trocadas no navegador pelas cores de cada persona
  (`pele`, `cabelo`, `camisa`, `calca` e `cabeloLongo` no `personas.json`).

Para mudar algum sprite, edite o script e rode `npm run build-tileset`. Para usar um tileset comprado
(por exemplo o *Modern Interiors* da LimeZu), gere um atlas com os mesmos nomes de frame
(`desk`, `chair`, `monitor_on`, `sofa`...) e substitua `office.png`/`office.json`. Os nomes estão no `office.json`.

Controles: arraste para mover a câmera e use a roda do mouse para zoom.

## Próximos passos

- [x] Conversas geradas pelo Claude Haiku, no estilo de cada personalidade
- [x] Barras de uso (limite de 5 h e semanal) no topo
- [x] Tileset de pixel art com personagens animados
- [x] Subagentes com papéis de verdade, aparecendo no escritório
