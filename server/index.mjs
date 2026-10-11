// Servidor do escritório virtual.
// Recebe eventos dos hooks do Claude Code em POST /event, mantém o estado
// de cada agente e transmite tudo para o navegador via WebSocket.

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatWriter } from './chat.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.OFFICE_PORT || 4321);

// Depois de quanto tempo sem eventos um agente "trabalhando" vira ocioso,
// e depois de quanto tempo sem eventos ele sai do escritório.
const IDLE_AFTER_MS = 5 * 60 * 1000;
const LEAVE_AFTER_MS = 2 * 60 * 60 * 1000;

const chat = new ChatWriter();
let hangoutSeq = 0;

const personas = JSON.parse(readFileSync(join(ROOT, 'config/personas.json'), 'utf8'));

/** @type {Map<string, any>} session_id -> agente */
const agents = new Map();
/** Projetos na ordem em que apareceram (define a posição das salas). */
let projects = [];

// ---------------------------------------------------------------------------
// Tradução dos eventos do Claude Code em "o que o agente está fazendo"
// ---------------------------------------------------------------------------

function short(text, max = 30) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function file(p) {
  return p ? basename(String(p)) : 'arquivo';
}

export function describeTool(name, input = {}) {
  switch (name) {
    case 'Bash': return `Rodando: ${short(input.description || input.command, 30)}`;
    case 'Grep': return `Buscando "${short(input.pattern, 24)}"`;
    case 'Glob': return `Procurando ${short(input.pattern, 26)}`;
    case 'Read': return `Lendo ${file(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit': return `Editando ${file(input.file_path)}`;
    case 'Write': return `Escrevendo ${file(input.file_path)}`;
    case 'NotebookEdit': return `Editando ${file(input.notebook_path)}`;
    case 'WebFetch': return 'Lendo um site';
    case 'WebSearch': return `Pesquisando "${short(input.query, 24)}"`;
    case 'Task':
    case 'Agent': return `Delegando: ${short(input.description, 28)}`;
    case 'TodoWrite': return 'Organizando tarefas';
    default:
      if (name?.startsWith('mcp__')) return `Usando ${name.split('__')[1]}`;
      return `Usando ${name ?? 'ferramenta'}`;
  }
}

function pickPersona() {
  const used = new Set([...agents.values()].map((a) => a.persona.id));
  const free = personas.filter((p) => !used.has(p.id));
  if (free.length) return { persona: free[0], suffix: '' };
  // Mais sessões que personas: reaproveita com um número no nome.
  const p = personas[agents.size % personas.length];
  return { persona: p, suffix: ` ${Math.floor(agents.size / personas.length) + 1}` };
}

function getAgent(sessionId, cwd) {
  let agent = agents.get(sessionId);
  if (!agent) {
    const { persona, suffix } = pickPersona();
    const project = cwd ? basename(cwd) : 'sem-projeto';
    agent = {
      id: sessionId,
      nome: persona.nome + suffix,
      persona,
      project,
      status: 'idle',
      activity: '',
      lastEventAt: Date.now(),
      startedAt: Date.now(),
      busyUntil: 0,
      recentWork: [], // últimas ações, viram assunto nas conversas
    };
    agents.set(sessionId, agent);
    if (!projects.includes(project)) projects.push(project);
  }
  agent.lastEventAt = Date.now();
  return agent;
}

function removeAgent(sessionId) {
  agents.delete(sessionId);
  const active = new Set([...agents.values()].map((a) => a.project));
  projects = projects.filter((p) => active.has(p));
}

export function handleEvent(payload) {
  const event = payload.hook_event_name;
  const sessionId = payload.session_id;
  if (!event || !sessionId) return false;

  if (event === 'SessionEnd') {
    removeAgent(sessionId);
    return true;
  }

  const agent = getAgent(sessionId, payload.cwd);
  switch (event) {
    case 'SessionStart':
      agent.status = 'idle';
      agent.activity = 'Chegou no escritório';
      break;
    case 'UserPromptSubmit':
      agent.status = 'working';
      agent.activity = 'Pensando…';
      break;
    case 'PreToolUse':
      agent.status = 'working';
      agent.activity = describeTool(payload.tool_name, payload.tool_input);
      if (agent.recentWork.at(-1) !== agent.activity) {
        agent.recentWork.push(agent.activity);
        if (agent.recentWork.length > 6) agent.recentWork.shift();
      }
      break;
    case 'PostToolUse':
      agent.status = 'working';
      break;
    case 'Notification':
      agent.status = 'waiting';
      agent.activity = 'Precisa de você!';
      break;
    case 'Stop':
      agent.status = 'idle';
      agent.activity = 'Entregue ✓';
      break;
    default:
      return false;
  }
  // Agente que voltou a trabalhar larga o que estava fazendo no ócio.
  if (agent.status !== 'idle') agent.busyUntil = 0;
  return true;
}

// ---------------------------------------------------------------------------
// Estado e broadcast
// ---------------------------------------------------------------------------

function publicAgent(a) {
  return {
    id: a.id,
    nome: a.nome,
    project: a.project,
    status: a.status,
    activity: a.activity,
    persona: {
      id: a.persona.id,
      pele: a.persona.pele,
      cabelo: a.persona.cabelo,
      camisa: a.persona.camisa,
      calca: a.persona.calca,
      personalidade: a.persona.personalidade,
    },
  };
}

function snapshot() {
  return { type: 'state', projects, agents: [...agents.values()].map(publicAgent) };
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(ROOT, 'public')));
app.get('/vendor/phaser.min.js', (_req, res) =>
  res.sendFile(join(ROOT, 'node_modules/phaser/dist/phaser.min.js')),
);

app.post('/event', (req, res) => {
  if (handleEvent(req.body ?? {})) broadcast(snapshot());
  res.json({ ok: true });
});

app.get('/api/state', (_req, res) => res.json(snapshot()));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}

wss.on('connection', (ws) => ws.send(JSON.stringify(snapshot())));

// ---------------------------------------------------------------------------
// Vida social: agentes ociosos passeiam e conversam com os amigos
// ---------------------------------------------------------------------------

const pick = (list) => list[Math.floor(Math.random() * list.length)];

function socialTick() {
  const now = Date.now();
  let changed = false;

  for (const agent of [...agents.values()]) {
    const quiet = now - agent.lastEventAt;
    if (quiet > LEAVE_AFTER_MS) {
      removeAgent(agent.id);
      changed = true;
    } else if (agent.status === 'working' && quiet > IDLE_AFTER_MS) {
      agent.status = 'idle';
      agent.activity = '';
      changed = true;
    } else if (agent.status === 'idle' && agent.activity && quiet > 8000) {
      agent.activity = '';
      changed = true;
    }
  }
  if (changed) broadcast(snapshot());

  const free = [...agents.values()].filter((a) => a.status === 'idle' && a.busyUntil < now);
  for (const agent of free) {
    if (agent.busyUntil > now || Math.random() > 0.35) continue;

    const friend = free.find(
      (b) => b !== agent && b.busyUntil < now && agent.persona.amigos.includes(b.persona.id),
    );
    if (friend && Math.random() < 0.6) {
      const shared = agent.persona.gosta.filter((s) => friend.persona.gosta.includes(s));
      const spot = pick(shared.length ? shared : agent.persona.gosta);
      const id = ++hangoutSeq;
      agent.busyUntil = friend.busyUntil = now + 35000;
      // Eles já começam a andar; as falas chegam depois, enquanto caminham.
      broadcast({ type: 'hangout', id, spot, agents: [agent.id, friend.id] });
      chat.write(agent, friend, spot).then((lines) => broadcast({ type: 'chat', hangout: id, lines }));
    } else {
      // Às vezes volta para a mesa, senão vai a um lugar que gosta.
      const spot = Math.random() < 0.25 ? 'mesa' : pick(agent.persona.gosta);
      agent.busyUntil = now + 14000;
      broadcast({ type: 'wander', agent: agent.id, spot });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setInterval(socialTick, 5000);
  server.listen(PORT, () => {
    console.log(`Escritório virtual rodando em http://localhost:${PORT}`);
  });
}
