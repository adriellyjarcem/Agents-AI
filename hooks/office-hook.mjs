#!/usr/bin/env node
// Hook do Claude Code: repassa o evento recebido no stdin para o escritório.
// Nunca pode atrapalhar o Claude Code: não imprime nada e sempre sai com 0,
// mesmo se o servidor estiver desligado.

const url = `http://localhost:${process.env.OFFICE_PORT || 4321}/event`;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: input || '{}',
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // servidor desligado: ignora
  }
  process.exit(0);
});
