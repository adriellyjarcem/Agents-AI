// Conversas entre agentes geradas pelo Claude Haiku, no estilo de cada
// personalidade. Sem credencial da API (ou com OFFICE_LLM=off), cai nas
// falas fixas do personas.json, e o escritório continua funcionando.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const MODEL = process.env.OFFICE_LLM_MODEL || 'claude-haiku-5-5';
const MAX_PER_HOUR = Number(process.env.OFFICE_LLM_MAX_PER_HOUR || 120);

const SPOT_NAMES = {
  cafe: 'na máquina de café',
  bebedouro: 'no bebedouro',
  sofa: 'no sofá',
  estante: 'na estante de livros',
  jardim: 'no jardim',
};

const SYSTEM = `Você escreve diálogos curtos entre colegas de um escritório virtual em pixel art.
Os colegas são agentes de IA que programam; cada um tem nome, personalidade e um histórico do que fez hoje.
Escreva em português do Brasil, num tom leve e natural de conversa de corredor, fiel à personalidade de cada um.
Eles podem comentar o trabalho que fizeram (use o histórico, sem inventar detalhes técnicos que não estão nele), fazer piadas, combinar algo ou só jogar conversa fora.
Cada fala tem no máximo 90 caracteres. Não use emojis em excesso (no máximo um por fala). Não repita assuntos da conversa anterior deles.`;

const Dialogue = z.object({
  falas: z
    .array(
      z.object({
        quem: z.enum(['A', 'B']),
        texto: z.string(),
      }),
    )
    .min(2)
    .max(5),
});

const pick = (list) => list[Math.floor(Math.random() * list.length)];

function cannedLines(a, b) {
  return [
    { from: a.id, text: pick(a.persona.falas) },
    { from: b.id, text: pick(b.persona.falas) },
    { from: a.id, text: pick(a.persona.falas) },
  ];
}

function describe(label, agent) {
  const work = agent.recentWork?.length ? agent.recentWork.join('; ') : 'ainda não fez nada hoje';
  return `${label}: ${agent.nome}, trabalha no projeto "${agent.project}".
Personalidade: ${agent.persona.personalidade}
Jeito de falar (exemplos): ${agent.persona.falas.map((f) => `"${f}"`).join(' ')}
O que fez hoje: ${work}`;
}

export class ChatWriter {
  constructor({ client } = {}) {
    this.enabled = process.env.OFFICE_LLM !== 'off';
    this.client = client ?? null;
    this.calls = [];
    this.memory = new Map(); // dupla -> últimas falas, para não repetir assunto
  }

  getClient() {
    if (!this.client) this.client = new Anthropic();
    return this.client;
  }

  withinBudget() {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    this.calls = this.calls.filter((t) => t > hourAgo);
    return this.calls.length < MAX_PER_HOUR;
  }

  /** Gera as falas da conversa entre `a` e `b`. Nunca lança erro. */
  async write(a, b, spot) {
    const pairKey = [a.persona.id, b.persona.id].sort().join('+');
    if (!this.enabled || !this.withinBudget()) return cannedLines(a, b);

    const previous = this.memory.get(pairKey);
    const prompt = `${describe('A', a)}

${describe('B', b)}

A e B são amigos e se encontraram ${SPOT_NAMES[spot] ?? 'no corredor'}. A puxa assunto.
${previous ? `Conversa anterior deles (não repita):\n${previous}\n` : ''}Escreva de 3 a 5 falas alternando entre A e B.`;

    try {
      this.calls.push(Date.now());
      const response = await this.getClient().messages.parse({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        output_config: { effort: 'low', format: zodOutputFormat(Dialogue) },
      });
      const falas = response.parsed_output?.falas;
      if (response.stop_reason !== 'end_turn' || !falas?.length) return cannedLines(a, b);

      const lines = falas.map((f) => ({
        from: f.quem === 'A' ? a.id : b.id,
        text: f.texto.slice(0, 120),
      }));
      this.memory.set(
        pairKey,
        lines.map((l) => `${l.from === a.id ? a.nome : b.nome}: ${l.text}`).join('\n'),
      );
      return lines;
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || /authentication method|api key/i.test(error.message)) {
        // Sem credencial: desliga o Haiku e segue com as falas fixas.
        console.warn('Conversas com IA desligadas: nenhuma credencial da API da Anthropic encontrada.');
        this.enabled = false;
      } else if (error instanceof Anthropic.RateLimitError) {
        console.warn('Limite de uso da API atingido; usando falas fixas por enquanto.');
      } else {
        console.warn('Falha ao gerar conversa:', error.message);
      }
      return cannedLines(a, b);
    }
  }
}
