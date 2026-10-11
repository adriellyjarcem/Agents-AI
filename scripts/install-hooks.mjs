#!/usr/bin/env node
// Adiciona (ou remove, com --remove) os hooks do escritório no settings.json
// do Claude Code. Por padrão usa o settings global (~/.claude/settings.json),
// assim todas as sessões de todos os projetos aparecem no escritório.
//
//   node scripts/install-hooks.mjs                 instala no global
//   node scripts/install-hooks.mjs --project DIR   instala só no projeto DIR
//   node scripts/install-hooks.mjs --remove        remove
//   node scripts/install-hooks.mjs --no-statusline não mexe no status line
//   node scripts/install-hooks.mjs --no-subagents  não cria os subagentes
//
// Também configura o status line, que é por onde o Claude Code informa os
// limites de uso (5 h e semanal). Se já houver um status line, ele é guardado
// em config/statusline-anterior.json e continua sendo exibido.
//
// E cria um subagente do Claude Code para cada persona com papel (Igor testa,
// Ricardo revisa segurança...) em .claude/agents/. Quando o Claude Code delega
// para um deles, o personagem aparece no escritório.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARK = 'office-hook.mjs';
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
];
const WITH_MATCHER = new Set(['PreToolUse', 'PostToolUse']);

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const withStatusLine = !args.includes('--no-statusline');
const withSubagents = !args.includes('--no-subagents');
const projectIdx = args.indexOf('--project');
const settingsPath =
  projectIdx >= 0
    ? join(resolve(args[projectIdx + 1] ?? '.'), '.claude', 'settings.json')
    : join(homedir(), '.claude', 'settings.json');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Barras normais funcionam em qualquer shell, inclusive no Windows.
const nodeCommand = (file) => `node "${join(ROOT, 'hooks', file).replace(/\\/g, '/')}"`;
const command = nodeCommand(MARK);
const STATUS_MARK = 'office-statusline.mjs';
const previousStatusFile = join(ROOT, 'config', 'statusline-anterior.json');

let settings = {};
if (existsSync(settingsPath)) {
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  // Guarda o arquivo original só na primeira vez, para não sobrescrever o backup.
  if (!existsSync(settingsPath + '.bak')) copyFileSync(settingsPath, settingsPath + '.bak');
} else {
  mkdirSync(dirname(settingsPath), { recursive: true });
}
settings.hooks ??= {};

for (const event of EVENTS) {
  // Tira qualquer versão anterior dos nossos hooks, preservando os outros.
  const groups = (settings.hooks[event] ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !h.command?.includes(MARK)) }))
    .filter((g) => g.hooks.length > 0);

  if (!remove) {
    const group = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (WITH_MATCHER.has(event)) group.matcher = '*';
    groups.push(group);
  }

  if (groups.length) settings.hooks[event] = groups;
  else delete settings.hooks[event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

if (withStatusLine) {
  const current = settings.statusLine;
  const isOurs = current?.command?.includes(STATUS_MARK);
  if (!remove && !isOurs) {
    if (current) writeFileSync(previousStatusFile, JSON.stringify(current, null, 2) + '\n');
    settings.statusLine = { type: 'command', command: nodeCommand(STATUS_MARK), padding: current?.padding ?? 0 };
  } else if (remove && isOurs) {
    if (existsSync(previousStatusFile)) {
      settings.statusLine = JSON.parse(readFileSync(previousStatusFile, 'utf8'));
      rmSync(previousStatusFile);
    } else {
      delete settings.statusLine;
    }
  }
}

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

if (withSubagents) {
  // Só mexe em arquivos criados por este script (marcados), nunca nos seus.
  const SUB_MARK = '<!-- criado pelo escritório virtual -->';
  const agentsDir = join(dirname(settingsPath), 'agents');
  const personas = JSON.parse(readFileSync(join(ROOT, 'config', 'personas.json'), 'utf8')).filter((p) => p.papel);
  const done = [];
  for (const p of personas) {
    const file = join(agentsDir, `${p.id}.md`);
    const exists = existsSync(file);
    if (exists && !readFileSync(file, 'utf8').includes(SUB_MARK)) {
      console.log(`Pulando ${file}: já existe e não foi criado por este script.`);
      continue;
    }
    if (remove) {
      if (exists) rmSync(file);
      continue;
    }
    mkdirSync(agentsDir, { recursive: true });
    const lines = [
      '---',
      `name: ${p.id}`,
      `description: ${p.nome} (${p.papel.toLowerCase()}). ${p.quandoUsar}`,
      ...(p.ferramentas ? [`tools: ${p.ferramentas}`] : []),
      '---',
      SUB_MARK,
      '',
      `Você é ${p.nome}, do time. Seu papel: ${p.papel.toLowerCase()}. ${p.personalidade}`,
      '',
      p.instrucoes,
      '',
      'Ao terminar, responda com um resumo curto do que fez e do que encontrou.',
      '',
    ];
    writeFileSync(file, lines.join('\n'));
    done.push(p.nome);
  }
  if (remove) console.log(`Subagentes removidos de ${agentsDir}`);
  else console.log(`Subagentes criados em ${agentsDir}: ${done.join(', ')}`);
}

console.log(`${remove ? 'Hooks removidos de' : 'Hooks instalados em'} ${settingsPath}`);
if (existsSync(settingsPath + '.bak')) console.log(`Backup do arquivo anterior: ${settingsPath}.bak`);
