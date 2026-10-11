#!/usr/bin/env node
// Simula várias sessões do Claude Code mandando eventos para o escritório,
// para ver tudo funcionando sem precisar abrir o Claude Code.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const statusLineScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'office-statusline.mjs');
const url = `http://localhost:${process.env.OFFICE_PORT || 4321}/event`;

const sessions = [
  { id: 'demo-1', cwd: '/projetos/site-institucional' },
  { id: 'demo-2', cwd: '/projetos/site-institucional' },
  { id: 'demo-3', cwd: '/projetos/site-institucional' },
  { id: 'demo-4', cwd: '/projetos/GE21' },
  { id: 'demo-5', cwd: '/projetos/GE21' },
  { id: 'demo-6', cwd: '/projetos/app-mobile' },
  { id: 'demo-7', cwd: '/projetos/app-mobile' },
];

const tools = [
  ['Grep', { pattern: 'description' }],
  ['Read', { file_path: 'src/components/Header.tsx' }],
  ['Edit', { file_path: 'src/pages/index.tsx' }],
  ['Bash', { description: 'Rodar testes', command: 'npm test' }],
  ['Bash', { command: 'git status' }],
  ['Glob', { pattern: '**/*.css' }],
  ['WebSearch', { query: 'phaser tilemap tutorial' }],
  ['Task', { description: 'Analisar logs de erro' }],
  ['Write', { file_path: 'docs/README.md' }],
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(session, hook_event_name, extra = {}) {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: session.id, cwd: session.cwd, hook_event_name, ...extra }),
  });
}

async function runSession(session) {
  await send(session, 'SessionStart');
  await sleep(1000 + Math.random() * 4000);
  for (;;) {
    await send(session, 'UserPromptSubmit', { prompt: 'faz uma coisa aí' });
    const steps = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < steps; i++) {
      await sleep(1500 + Math.random() * 2500);
      const [tool_name, tool_input] = pick(tools);
      await send(session, 'PreToolUse', { tool_name, tool_input });
    }
    if (Math.random() < 0.2) {
      await send(session, 'Notification', { message: 'Claude precisa da sua permissão' });
      await sleep(6000);
    }
    await send(session, 'Stop');
    // Fica um tempo ocioso: é quando vai passear e conversar.
    await sleep(15000 + Math.random() * 30000);
  }
}

try {
  await fetch(url.replace('/event', '/api/state'));
} catch {
  console.error(`Não achei o servidor em ${url}. Rode "npm start" antes.`);
  process.exit(1);
}

console.log(`Simulando ${sessions.length} agentes. Ctrl+C para parar.`);
process.on('SIGINT', async () => {
  await Promise.all(sessions.map((s) => send(s, 'SessionEnd').catch(() => {})));
  process.exit(0);
});
sessions.forEach(runSession);

// Uso do plano subindo aos poucos, enviado pelo mesmo status line que o
// Claude Code usa de verdade.
const startedAt = Date.now() / 1000;
function sendUsage() {
  const minutes = (Date.now() / 1000 - startedAt) / 60;
  const rate_limits = {
    five_hour: { used_percentage: Math.min(100, 32 + minutes * 4), resets_at: Math.round(startedAt + 85 * 60) },
    seven_day: { used_percentage: Math.min(100, 36 + minutes), resets_at: Math.round(startedAt + 4 * 24 * 3600) },
  };
  spawnSync(process.execPath, [statusLineScript], {
    input: JSON.stringify({ model: { display_name: 'Demo' }, rate_limits }),
  });
}
sendUsage();
setInterval(sendUsage, 15000);
