#!/usr/bin/env node
// Hook do Claude Code: avisa o escritório do que a sessão está fazendo.
// Nunca pode atrapalhar o Claude Code: não imprime nada e sempre sai com 0,
// mesmo se o escritório estiver desligado.
//
// Só vai o resumo que o escritório mostra (nome de arquivo, padrão de busca,
// descrição do comando), nunca o conteúdo de arquivos.

import { connection, deliver } from './conexao.mjs';

// Último pedaço do caminho, aceitando / e \ (caminhos do Windows).
const basename = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

const TEXT_FIELDS = ['description', 'pattern', 'query', 'subagent_type'];
const PATH_FIELDS = ['file_path', 'notebook_path'];

function summarize(p) {
  const raw = p.tool_input ?? {};
  const input = {};
  for (const k of TEXT_FIELDS) if (typeof raw[k] === 'string') input[k] = raw[k].slice(0, 200);
  for (const k of PATH_FIELDS) if (typeof raw[k] === 'string') input[k] = basename(raw[k]);
  if (typeof raw.command === 'string') {
    // Online, só o nome do programa: o comando completo pode ter senhas.
    input.command = connection().remote ? raw.command.trim().split(/\s+/)[0] : raw.command.slice(0, 200);
  }
  return {
    session_id: p.session_id,
    hook_event_name: p.hook_event_name,
    cwd: p.cwd ? basename(p.cwd) : undefined, // só o nome da pasta do projeto
    tool_name: p.tool_name,
    tool_input: input,
    agent_id: p.agent_id,
    agent_type: p.agent_type,
    ts: Date.now(), // ordem real dos eventos, caso cheguem fora de ordem
  };
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', async () => {
  try {
    await deliver('/event', summarize(JSON.parse(stdin)));
  } catch {
    // entrada inesperada: ignora
  }
  process.exit(0);
});
