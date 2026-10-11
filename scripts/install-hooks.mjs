#!/usr/bin/env node
// Adiciona (ou remove, com --remove) os hooks do escritório no settings.json
// do Claude Code. Por padrão usa o settings global (~/.claude/settings.json),
// assim todas as sessões de todos os projetos aparecem no escritório.
//
//   node scripts/install-hooks.mjs                 instala no global
//   node scripts/install-hooks.mjs --project DIR   instala só no projeto DIR
//   node scripts/install-hooks.mjs --remove        remove

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
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
  'SessionEnd',
];
const WITH_MATCHER = new Set(['PreToolUse', 'PostToolUse']);

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const projectIdx = args.indexOf('--project');
const settingsPath =
  projectIdx >= 0
    ? join(resolve(args[projectIdx + 1] ?? '.'), '.claude', 'settings.json')
    : join(homedir(), '.claude', 'settings.json');

const hookScript = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', MARK);
// Barras normais funcionam em qualquer shell, inclusive no Windows.
const command = `node "${hookScript.replace(/\\/g, '/')}"`;

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

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? 'Hooks removidos de' : 'Hooks instalados em'} ${settingsPath}`);
if (existsSync(settingsPath + '.bak')) console.log(`Backup do arquivo anterior: ${settingsPath}.bak`);
