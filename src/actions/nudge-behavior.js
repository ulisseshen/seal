/**
 * Action: nudge-behavior — SEAL cobra uma promessa de gestão e sugere o próximo passo.
 *
 * Diferente de um reminder seco, esta action:
 *   - lê uma nota de comportamento (task type=person com follow-up),
 *   - chama o LLM (via circuit breaker) para escrever uma COBRANÇA curta + 1 SUGESTÃO
 *     concreta de comportamento, a partir do sinal da nota,
 *   - cai num fallback determinístico se o breaker estiver aberto / LLM indisponível.
 *
 * A confirmação vai pro gateway (Telegram) com dois botões:
 *   ✅ Approve = "Feito"  → marca a nota done.
 *   ❌ Deny    = "Não vou / depois" → registra; a insistência (runner) re-cobra.
 *
 * Não responder = nota fica pending/firing e o runner re-cobra a cada 2 dias,
 * até 3 tentativas (cap). Gestão não é emergência — sem loop apertado.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BaseAction } from './base.js';
import { getProvider } from '../providers/index.js';
import { getBreaker } from '../circuit-breaker.js';

const SEAL_DIR = process.env.SEAL_DIR || join(process.env.HOME, '.config', 'seal');
const CHAT_CONFIG = join(SEAL_DIR, 'chat-config.json');

const NUDGE_SYSTEM_PROMPT =
  'Você é o copiloto de Tech Lead do SEAL. O TL registrou uma observação sobre uma ' +
  'pessoa do time e prometeu (ou precisa de) um próximo passo. Sua tarefa: escrever uma ' +
  'COBRANÇA curta e direta (1-2 frases, em pt-BR, sem rodeios) e UMA sugestão concreta de ' +
  'comportamento que o TL pode tomar agora. Seja específico ao sinal (ex: burnout → checar ' +
  'carga e propor pausa; isolamento → marcar pair/1:1; PDI → reagendar). NÃO invente fatos ' +
  'além do que está na nota. Responda SOMENTE com JSON: {"nudge":"...","suggestion":"..."}';

function readChatConfig() {
  if (!existsSync(CHAT_CONFIG)) return { provider: 'claude' };
  try { return JSON.parse(readFileSync(CHAT_CONFIG, 'utf-8')); }
  catch { return { provider: 'claude' }; }
}

function tryParseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw.trim()); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} }
  return null;
}

function daysSince(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / 86_400_000));
}

/**
 * Deterministic fallback when the LLM is unavailable. Picks a suggestion by
 * keyword in the note, so a cobrança still goes out (degraded, not silent).
 */
export function fallbackNudge(task) {
  const text = `${task.summary || ''} ${task.detail || ''}`.toLowerCase();
  let suggestion = 'Defina o próximo passo concreto e bloqueie 15min na agenda.';
  if (/burnout|sobrecarga|ansiedade|carga/.test(text)) {
    suggestion = 'Cheque a carga da pessoa num 1:1 rápido e proponha uma pausa se houver sinal.';
  } else if (/isolad|isolamento|sozinho|afast|pair/.test(text)) {
    suggestion = 'Marque uma sessão de pair ou um 1:1 curto para reaproximar.';
  } else if (/pdi/.test(text)) {
    suggestion = 'Reagende o PDI e bloqueie o horário agora.';
  } else if (/backend|treinamento|sessao|sessão/.test(text)) {
    suggestion = 'Agende a sessão/treinamento e convide o time.';
  } else if (/retro/.test(text)) {
    suggestion = 'Marque a retro e defina a pauta.';
  }
  return {
    nudge: `Pendente: ${task.summary}.`,
    suggestion,
    source: 'fallback',
  };
}

/**
 * Ask the LLM for a nudge + suggestion. Wrapped in the provider's circuit
 * breaker exactly like the proposer. Throws on failure so the caller falls
 * back deterministically (and records the breaker failure).
 */
export async function llmNudge(task) {
  const cfg = readChatConfig();
  const providerName = cfg.provider || 'claude';
  const model = cfg.model || undefined;
  const breaker = getBreaker(providerName, { threshold: 3, cooldownMs: 30 * 60 * 1000 });

  if (!breaker.canExecute()) {
    throw new Error(`circuit breaker open for ${providerName}`);
  }

  const provider = getProvider(providerName, { model });
  if (!provider.available()) {
    throw new Error(`provider ${providerName} not available`);
  }

  const n = daysSince(task.execute_at || task.next_run);
  const userPrompt = [
    `Nota sobre: ${(JSON.parse(task.people || '[]')[0]) || 'time'}`,
    `Resumo: ${task.summary}`,
    task.detail ? `Detalhe:\n${task.detail}` : '',
    n != null ? `Esta cobrança está marcada para hoje (${n} dia(s) desde que foi registrada).` : '',
  ].filter(Boolean).join('\n');

  let raw = '';
  try {
    for await (const chunk of provider.stream([{ role: 'user', content: userPrompt }], NUDGE_SYSTEM_PROMPT)) {
      raw += chunk;
    }
    breaker.recordSuccess();
  } catch (err) {
    breaker.recordFailure();
    throw err;
  }

  const parsed = tryParseJson(raw);
  if (!parsed || !parsed.nudge) {
    // Parseable-output failure is a soft failure, not a breaker failure
    // (the CLI ran fine). Surface it so the caller uses the fallback.
    throw new Error(`nudge LLM returned unparseable output: ${raw.slice(0, 160)}`);
  }
  return { nudge: parsed.nudge, suggestion: parsed.suggestion || '', source: 'llm' };
}

export class NudgeBehaviorAction extends BaseAction {
  /**
   * @param {object} db - SEAL db wrapper (run/get/all)
   */
  constructor(db) {
    super('nudge-behavior', 'Cobra uma promessa de gestão e sugere o próximo passo');
    this.db = db;
  }

  async preview(context) {
    const task = context.task || {};
    let result;
    try {
      result = await llmNudge(task);
    } catch (err) {
      console.warn(`[seal:actions:nudge] LLM nudge failed, using fallback: ${err.message}`);
      result = fallbackNudge(task);
    }

    const person = (() => {
      try { return JSON.parse(task.people || '[]')[0] || ''; } catch { return ''; }
    })();

    const tag = result.source === 'fallback' ? ' (sugestão básica — LLM indisponível)' : '';
    return {
      summary: person ? `🔔 ${person}: ${result.nudge}` : `🔔 ${result.nudge}`,
      details: [
        result.suggestion ? `💡 Sugestão: ${result.suggestion}${tag}` : null,
        '',
        'Botões: ✅ = Feito · ❌ = Não vou / depois (SEAL re-cobra)',
      ].filter(Boolean).join('\n'),
      impact: 'Marca a promessa como resolvida ou re-agenda a cobrança.',
    };
  }

  async execute(context) {
    // Reached only on ✅ Approve = "Feito". Mark the note done.
    const task = context.task || {};
    if (!task.id) return { success: false, message: 'nudge sem task associada' };
    try {
      await this.db.run(
        `UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ?`,
        [task.id],
      );
      return { success: true, message: `Promessa marcada como feita: ${task.summary}` };
    } catch (err) {
      return { success: false, message: `falha ao marcar feito: ${err.message}` };
    }
  }
}
