#!/usr/bin/env node
// Status line do Claude Code: repassa os limites de uso (5 h e semanal) para
// o escritório e imprime a linha de status. Se você já tinha um status line,
// o instalador guarda o comando dele e este script continua rodando-o, então
// nada muda na sua tela.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliver } from './conexao.mjs';

const previousFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'statusline-anterior.json');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  let data = {};
  try {
    data = JSON.parse(input);
  } catch {
    // entrada inesperada: segue só com a linha padrão
  }

  if (data.rate_limits) await deliver('/usage', { rate_limits: data.rate_limits });

  process.stdout.write(statusLine(data));
  process.exit(0);
});

function statusLine(data) {
  const previous = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
  if (previous?.command) {
    const result = spawnSync(previous.command, { input, shell: true, encoding: 'utf8', timeout: 5000 });
    return result.stdout ?? '';
  }
  const parts = [data.model?.display_name].filter(Boolean);
  const five = data.rate_limits?.five_hour?.used_percentage;
  const week = data.rate_limits?.seven_day?.used_percentage;
  if (five != null) parts.push(`5h ${Math.round(five)}%`);
  if (week != null) parts.push(`semana ${Math.round(week)}%`);
  return parts.join(' · ');
}
