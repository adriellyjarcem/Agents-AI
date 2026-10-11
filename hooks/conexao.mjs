// Para onde os hooks mandam os eventos, e como.
//
// Endereço e senha vêm, nesta ordem, de OFFICE_URL/OFFICE_TOKEN no ambiente
// ou de config/conexao.json (criado pelo instalador com --url/--token). Sem
// nada configurado, vai para o escritório local (http://localhost:4321).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function connection() {
  let cfg = {};
  const file = join(here, '..', 'config', 'conexao.json');
  try {
    if (existsSync(file)) cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // arquivo inválido: segue com o padrão
  }
  const url = (process.env.OFFICE_URL || cfg.url || `http://localhost:${process.env.OFFICE_PORT || 4321}`).replace(/\/+$/, '');
  const token = process.env.OFFICE_TOKEN || cfg.token || '';
  const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
  return { url, token, remote };
}

async function post(path, body, timeout) {
  const { url, token } = connection();
  await fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
}

// Entrega um evento sem nunca atrapalhar o Claude Code. Online, o servidor
// pode demorar (o plano gratuito "dorme"), então o envio vai para um processo
// em segundo plano e o hook termina na hora.
export async function deliver(path, body) {
  if (!connection().remote) {
    await post(path, body, 1500).catch(() => {});
    return;
  }
  const data = Buffer.from(JSON.stringify(body)).toString('base64');
  spawn(process.execPath, [fileURLToPath(import.meta.url), path, data], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

// Processo em segundo plano criado por deliver().
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[3]) {
  const body = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
  post(process.argv[2], body, 90_000)
    .catch(() => {})
    .finally(() => process.exit(0));
}
