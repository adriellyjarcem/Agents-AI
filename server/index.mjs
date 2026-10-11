// Servidor do escritório virtual.
// Recebe eventos dos hooks do Claude Code em POST /event, mantém o estado
// de cada agente e transmite tudo para o navegador via WebSocket.

import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatWriter } from './chat.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// PORT é a porta que provedores como o Render definem.
const PORT = Number(process.env.OFFICE_PORT || process.env.PORT || 4321);
// Com OFFICE_TOKEN definido (versão online), tudo exige essa senha.
const TOKEN = process.env.OFFICE_TOKEN || '';

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
/** Limites de uso do plano, vindos do status line do Claude Code. */
let usage = {};

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

// Sessões principais ficam com os coordenadores (personas sem subagente);
// os outros personagens são reservados para quando o subagente deles trabalha.
function pickPersona({ forSubagent = null } = {}) {
  const used = new Set([...agents.values()].map((a) => a.persona.id));
  const named = forSubagent && personas.find((p) => p.id === forSubagent);
  if (named) return { persona: named, suffix: used.has(named.id) ? ' 2' : '' };

  const pool = forSubagent
    ? personas.filter((p) => !p.coordenador)
    : [...personas.filter((p) => p.coordenador), ...personas.filter((p) => !p.coordenador)];
  const free = pool.find((p) => !used.has(p.id));
  if (free) return { persona: free, suffix: '' };
  // Mais agentes que personas: reaproveita com um número no nome.
  const p = pool[agents.size % pool.length];
  return { persona: p, suffix: ` ${Math.floor(agents.size / pool.length) + 1}` };
}

function newAgent(id, persona, nome, project, extra = {}) {
  const agent = {
    id,
    nome,
    persona,
    project,
    status: 'idle',
    activity: '',
    lastEventAt: Date.now(),
    startedAt: Date.now(),
    busyUntil: 0,
    recentWork: [], // últimas ações, viram assunto nas conversas
    ...extra,
  };
  agents.set(id, agent);
  if (!projects.includes(project)) projects.push(project);
  return agent;
}

function getAgent(sessionId, cwd) {
  let agent = agents.get(sessionId);
  if (!agent) {
    const { persona, suffix } = pickPersona();
    agent = newAgent(sessionId, persona, persona.nome + suffix, cwd ? basename(cwd) : 'sem-projeto');
  }
  agent.lastEventAt = Date.now();
  return agent;
}

// Subagente: um personagem à parte, na mesma sala da sessão que o chamou.
// Se existir uma persona com o mesmo nome do subagente (ex.: "igor"), é ela.
function getSubagent(payload) {
  const id = `${payload.session_id}:${payload.agent_id}`;
  let agent = agents.get(id);
  if (!agent) {
    const type = payload.agent_type || 'ajudante';
    const { persona, suffix } = pickPersona({ forSubagent: type });
    const isPersona = persona.id === type;
    const parent = getAgent(payload.session_id, payload.cwd);
    agent = newAgent(id, persona, isPersona ? persona.nome + suffix : type, parent.project, {
      parent: payload.session_id,
      status: 'working',
    });
  }
  agent.lastEventAt = Date.now();
  return agent;
}

// Quem já saiu, e quando: eventos atrasados não podem trazê-lo de volta.
const ended = new Map();

function removeAgent(id, ts = Date.now()) {
  ended.set(id, ts);
  agents.delete(id);
  // Quando a sessão acaba, os subagentes dela vão junto.
  for (const a of [...agents.values()]) if (a.parent === id) agents.delete(a.id);
  const active = new Set([...agents.values()].map((a) => a.project));
  projects = projects.filter((p) => active.has(p));
}

export function handleEvent(payload) {
  const event = payload.hook_event_name;
  const sessionId = payload.session_id;
  if (!event || !sessionId) return false;

  // Online os eventos vão em paralelo e podem chegar fora de ordem: cada um
  // traz a hora em que aconteceu, e os atrasados são ignorados.
  const ts = Number(payload.ts) || Date.now();
  const id = payload.agent_id ? `${sessionId}:${payload.agent_id}` : sessionId;
  if (ts <= (ended.get(id) ?? -1) || ts <= (ended.get(sessionId) ?? -1)) return false;
  if (ts < (agents.get(id)?.lastTs ?? 0)) return false;

  if (event === 'SessionEnd' || event === 'SubagentStop') {
    if (event === 'SessionEnd' || payload.agent_id) removeAgent(id, ts);
    return true;
  }

  // Eventos de dentro de um subagente vêm com agent_id: vão para o personagem dele.
  const agent = payload.agent_id ? getSubagent(payload) : getAgent(sessionId, payload.cwd);
  agent.lastTs = ts;
  switch (event) {
    case 'SubagentStart':
      agent.status = 'working';
      agent.activity = 'Chegando para ajudar';
      break;
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
    parent: a.parent ?? null,
    persona: {
      id: a.persona.id,
      pele: a.persona.pele,
      cabelo: a.persona.cabelo,
      camisa: a.persona.camisa,
      calca: a.persona.calca,
      cabeloLongo: Boolean(a.persona.cabeloLongo),
      personalidade: a.persona.personalidade,
    },
  };
}

// Guarda só janelas válidas (com porcentagem e que ainda não reiniciaram).
export function readUsage(rateLimits = {}, now = Date.now()) {
  const out = {};
  for (const key of ['five_hour', 'seven_day']) {
    const w = rateLimits[key];
    if (typeof w?.used_percentage !== 'number') continue;
    if (typeof w.resets_at === 'number' && w.resets_at * 1000 < now) continue;
    out[key] = { used_percentage: w.used_percentage, resets_at: w.resets_at ?? null };
  }
  return out;
}

function currentUsage() {
  usage = readUsage(usage);
  return usage;
}

function snapshot() {
  return { type: 'state', projects, usage: currentUsage(), agents: [...agents.values()].map(publicAgent) };
}

function validToken(given) {
  if (!TOKEN) return true;
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireToken(req, res, next) {
  const header = req.headers.authorization ?? '';
  if (validToken(header.startsWith('Bearer ') ? header.slice(7) : undefined)) return next();
  res.status(401).json({ erro: 'senha inválida' });
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(join(ROOT, 'public')));
app.get('/saude', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({ protegido: Boolean(TOKEN) }));
app.get('/vendor/phaser.min.js', (_req, res) =>
  res.sendFile(join(ROOT, 'node_modules/phaser/dist/phaser.min.js')),
);

app.post('/event', requireToken, (req, res) => {
  if (handleEvent(req.body ?? {})) broadcast(snapshot());
  res.json({ ok: true });
});

app.post('/usage', requireToken, (req, res) => {
  // Mescla por janela: um relatório sem a semanal não apaga a semanal anterior.
  const next = readUsage({ ...currentUsage(), ...req.body?.rate_limits });
  if (JSON.stringify(next) !== JSON.stringify(currentUsage())) {
    usage = next;
    broadcast(snapshot());
  }
  res.json({ ok: true });
});

app.get('/api/state', requireToken, (_req, res) => res.json(snapshot()));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  if (!validToken(token)) {
    ws.close(4401, 'senha inválida');
    return;
  }
  ws.send(JSON.stringify(snapshot()));
});

// ---------------------------------------------------------------------------
// Vida social: agentes ociosos passeiam e conversam com os amigos
// ---------------------------------------------------------------------------

const pick = (list) => list[Math.floor(Math.random() * list.length)];

function socialTick() {
  const now = Date.now();
  for (const [id, at] of ended) if (now - at > 10 * 60 * 1000) ended.delete(id);
  // Uma janela de uso que reiniciou some das barras.
  const usageBefore = JSON.stringify(usage);
  let changed = JSON.stringify(currentUsage()) !== usageBefore;

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

// Abre o navegador no escritório (com --abrir).
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = `http://localhost:${PORT}`;
  const open = process.argv.includes('--abrir');
  server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') throw error;
    // Já tem um escritório rodando nessa porta: só abre o navegador.
    console.log(`O escritório já está rodando em ${url}`);
    if (open) openBrowser(url);
    process.exit(0);
  });
  setInterval(socialTick, 5000);
  server.listen(PORT, () => {
    console.log(`Escritório virtual rodando em ${url}`);
    console.log('Deixe esta janela aberta. Para desligar, feche-a ou aperte Ctrl+C.');
    if (open) openBrowser(url);
  });
}
