/**
 * Daily — captura o que cada pessoa falou na daily, estrutura via IA, e usa esse
 * histórico pra sugerir um check-in CONTEXTUAL (que mostra que o TL prestou atenção).
 *
 * O loop (ideia do TL): TL cola a fala → IA estrutura (Fez/Vai fazer/Bloqueios/
 * Compromissos/Humor) → grava type='daily' → na hora de perguntar, a IA cruza a
 * última daily + a última resposta da pessoa (teams.db) + promessas abertas e
 * SUGERE uma pergunta personalizada que o TL aprova antes de enviar.
 *
 * Toda chamada IA passa pelo circuit breaker (provider codex/gpt-5 — o do incidente).
 * Nada é enviado ao time aqui; esta engine só estrutura e sugere.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, insertTask } from '../db.js';
import { getProvider } from '../providers/index.js';
import { getBreaker } from '../circuit-breaker.js';

const SEAL_DIR = process.env.SEAL_DIR || join(process.env.HOME, '.config', 'seal');
const CHAT_CONFIG = join(SEAL_DIR, 'chat-config.json');
// O sync do Teams grava as mensagens recebidas aqui (outro projeto, mesmo Mac).
const TEAMS_DB = process.env.SEAL_TEAMS_DB ||
  join(process.env.HOME, 'projects', 'teamsbot', 'playwright_sender', 'data', 'teams.db');

function readChatConfig() {
  if (!existsSync(CHAT_CONFIG)) return { provider: 'claude' };
  try { return JSON.parse(readFileSync(CHAT_CONFIG, 'utf-8')); }
  catch { return { provider: 'claude' }; }
}

function extractJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw.trim()); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} }
  const aa = raw.indexOf('['); const bb = raw.lastIndexOf(']');
  if (aa >= 0 && bb > aa) { try { return JSON.parse(raw.slice(aa, bb + 1)); } catch {} }
  return null;
}

async function askLLM(systemPrompt, userPrompt) {
  const cfg = readChatConfig();
  const providerName = cfg.provider || 'claude';
  const model = cfg.model || undefined;
  const breaker = getBreaker(providerName, { threshold: 3, cooldownMs: 30 * 60 * 1000 });
  if (!breaker.canExecute()) throw new Error(`circuit breaker open for ${providerName}`);

  const provider = getProvider(providerName, { model });
  if (!provider.available()) throw new Error(`provider ${providerName} not available`);

  let raw = '';
  try {
    for await (const chunk of provider.stream([{ role: 'user', content: userPrompt }], systemPrompt)) {
      raw += chunk;
    }
    breaker.recordSuccess();
  } catch (err) {
    breaker.recordFailure();
    throw err;
  }
  return raw;
}

const INGEST_SYSTEM =
  'Você estrutura falas de daily standup de um time de devs. Recebe texto livre que ' +
  'pode conter UMA pessoa ou VÁRIAS (separadas por nome). Para cada pessoa, extraia em ' +
  'pt-BR, fiel ao que foi dito (NÃO invente): o que fez, o que vai fazer, bloqueios, ' +
  'compromissos (algo que ela disse que faria, pra acompanhar depois) e humor/energia se ' +
  'aparecer. Responda SOMENTE com JSON array: ' +
  '[{"person":"Nome","fez":"...","vai_fazer":"...","bloqueios":"...","compromissos":"...","humor":"..."}]. ' +
  'Campos sem informação ficam como "". O nome da pessoa é o que vier no texto (ex: Gus, Carla).';

/**
 * Estrutura uma fala de daily (uma ou várias pessoas) e grava uma linha
 * type='daily' por pessoa. Retorna os registros gravados.
 * @param {string} rawText - o que o TL colou
 * @param {{date?: string}} opts - data da daily (ISO, default hoje)
 */
export async function ingestDaily(rawText, { date } = {}) {
  if (!rawText || !rawText.trim()) throw new Error('daily vazia');
  const when = date || new Date().toISOString();

  const raw = await askLLM(INGEST_SYSTEM, `Daily de ${when.slice(0, 10)}:\n\n${rawText.trim()}`);
  let parsed = extractJson(raw);
  if (parsed && !Array.isArray(parsed)) parsed = [parsed]; // tolera objeto único
  if (!parsed || parsed.length === 0) {
    throw new Error(`IA não conseguiu estruturar a daily: ${raw.slice(0, 160)}`);
  }

  const saved = [];
  for (const p of parsed) {
    if (!p.person) continue;
    const id = randomBytes(4).toString('hex');
    const detail = [
      `FEZ: ${p.fez || '—'}`,
      `VAI FAZER: ${p.vai_fazer || '—'}`,
      `BLOQUEIOS: ${p.bloqueios || '—'}`,
      `COMPROMISSOS: ${p.compromissos || '—'}`,
      `HUMOR: ${p.humor || '—'}`,
    ].join('\n');
    const summary = `Daily ${p.person} ${when.slice(0, 10)}: ${(p.fez || p.vai_fazer || '').slice(0, 60)}`.trim();

    await insertTask({
      id, type: 'daily', summary, detail,
      execute_at: when, recurrence: null, next_run: null,
      prompt: null, project: null, allowed_tools: '[]', permission_mode: 'auto',
      notify_type: 'silent', notify_channel: null, notify_target: null,
      people: JSON.stringify([p.person]), priority: 'low', status: 'done',
      created: new Date().toISOString(), max_runs: null, executor: 'claude',
    });
    saved.push({ id, person: p.person, summary, detail });
  }
  if (saved.length === 0) throw new Error('nenhuma pessoa reconhecida na daily');
  return saved;
}

/**
 * Lê as últimas dailies de uma pessoa (mais recente primeiro).
 */
export async function recentDailies(person, limit = 5) {
  return db.all(
    `SELECT summary, detail, execute_at FROM tasks
     WHERE type = 'daily' AND json_extract(people, '$[0]') = ?
     ORDER BY datetime(execute_at) DESC LIMIT ?`,
    [person, limit],
  );
}

/**
 * Última resposta da pessoa no Teams (do teams.db do sync). Best-effort: se o
 * banco não existir ou o schema não bater, retorna null sem quebrar.
 */
export async function lastTeamsReply(personHint) {
  if (!existsSync(TEAMS_DB)) return null;
  try {
    const Database = (await import('better-sqlite3')).default;
    const tdb = new Database(TEAMS_DB, { readonly: true });
    // Busca a mensagem mais recente cujo autor casa o hint (nome). Schema do
    // teams.db: messages(from_name/sender, content/text, created_at/timestamp).
    const cols = tdb.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
    const authorCol = ['from_name', 'sender', 'author', 'from'].find((c) => cols.includes(c));
    const textCol = ['content', 'text', 'body', 'message'].find((c) => cols.includes(c));
    const timeCol = ['created_at', 'timestamp', 'ts', 'created'].find((c) => cols.includes(c));
    if (!authorCol || !textCol) { tdb.close(); return null; }
    const order = timeCol ? `ORDER BY ${timeCol} DESC` : '';
    const row = tdb.prepare(
      `SELECT ${textCol} AS text${timeCol ? `, ${timeCol} AS at` : ''}
       FROM messages WHERE ${authorCol} LIKE ? ${order} LIMIT 1`,
    ).get(`%${personHint}%`);
    tdb.close();
    return row ? { text: row.text, at: row.at || null } : null;
  } catch {
    return null;
  }
}

/**
 * Promessas/follow-ups abertos da pessoa (notas person pending).
 */
async function openPromises(person) {
  return db.all(
    `SELECT summary FROM tasks
     WHERE type = 'person' AND status IN ('pending','firing')
       AND json_extract(people, '$[0]') = ?`,
    [person],
  );
}

const SUGGEST_SYSTEM = [
  'Você escreve UMA pergunta curta de check-in para uma pessoa do time, COMO SE FOSSE O TL.',
  '',
  'TOM DO TL (imite fielmente — é seco e direto, NÃO é coach animado):',
  '- Curto e direto. Frases curtas. Ex de como ele fala: "como tá indo? travou em algo?", "e aí, no que tá mexendo?", "daquele jeito né".',
  '- PROIBIDO: travessão (—), exclamação animada, "Opa", "Bora", "bora pra semana", "como tá o pique", "que eu possa ajudar a planejar". Nada de jargão de coach.',
  '- "kkk" só se couber natural, sem forçar. Pode usar o nome ("Gus", nunca "Gustavo") ou nem usar.',
  '- minúsculas no começo é ok (ele escreve informal).',
  '',
  'CONTEÚDO: a pergunta DEVE ser específica ao contexto DELA — referencie 1-2 pontos CONCRETOS',
  'do que a pessoa disse nas dailies ou na última resposta. Se algo que ela disse que ia fazer',
  'sumiu nas dailies seguintes, pergunte sobre isso. NÃO invente fatos. Cada pessoa recebe uma',
  'pergunta diferente, baseada no contexto dela.',
  '',
  'Responda SOMENTE com JSON: {"suggestion":"a pergunta","basedOn":["fato 1","fato 2"]}.',
  'Sem contexto suficiente, retorne {"suggestion":"","basedOn":[]}.',
].join('\n');

/**
 * Monta uma sugestão de check-in personalizada pra `person`, cruzando dailies +
 * última resposta no Teams + promessas abertas. NÃO envia nada.
 * @returns {Promise<{person, suggestion, basedOn: string[], hasContext: boolean}>}
 */
export async function buildCheckinSuggestion(person) {
  const [dailies, reply, promises] = await Promise.all([
    recentDailies(person, 5),
    lastTeamsReply(person),
    openPromises(person),
  ]);

  // Sem nenhum contexto → não chama a IA, devolve vazio (check-in cai no genérico).
  if (dailies.length === 0 && !reply && promises.length === 0) {
    return { person, suggestion: '', basedOn: [], hasContext: false };
  }

  const ctx = [
    `Pessoa: ${person}`,
    dailies.length ? `Dailies recentes (mais nova primeiro):\n${dailies.map((d) => `- ${d.execute_at.slice(0, 10)}: ${d.detail}`).join('\n')}` : 'Sem dailies registradas.',
    reply ? `Última resposta dela no Teams: "${String(reply.text).slice(0, 400)}"` : 'Sem resposta recente no Teams.',
    promises.length ? `Promessas/follow-ups abertos: ${promises.map((p) => p.summary).join('; ')}` : '',
  ].filter(Boolean).join('\n\n');

  let parsed;
  try {
    const raw = await askLLM(SUGGEST_SYSTEM, ctx);
    parsed = extractJson(raw) || {};
  } catch {
    return { person, suggestion: '', basedOn: [], hasContext: false }; // breaker/IA fora → genérico
  }

  return {
    person,
    suggestion: parsed.suggestion || '',
    basedOn: Array.isArray(parsed.basedOn) ? parsed.basedOn : [],
    hasContext: Boolean(parsed.suggestion),
  };
}

// Email do time, pra enviar via o server Playwright do Teams. Carla vai por nome
// (não tem email no contacts), igual o daily-checkin.sh faz.
const TEAMS_TO = {
  Felipe: 'pessoa@example.com',
  Gus: 'pessoa@example.com',
  Gustavo: 'pessoa@example.com',
  Carla: 'pessoa@example.com',
  Rafael: 'pessoa@example.com',
};

const TEAMS_SEND_URL = process.env.SEAL_TEAMS_SEND_URL || 'http://127.0.0.1:4317/api/send';

/**
 * Envia uma mensagem pra uma pessoa via o server Teams. Retorna {ok, error?}.
 * O TL aprova ANTES de chamar isto — esta função só dispara o que foi aprovado.
 */
export async function sendToTeams(person, message) {
  const to = TEAMS_TO[person] || person;
  try {
    const res = await fetch(TEAMS_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, message, headless: true }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: Boolean(body.ok), to, error: body.ok ? null : (body.error || `HTTP ${res.status}`) };
  } catch (err) {
    return { ok: false, to, error: err.message };
  }
}

/**
 * Prepara as sugestões de check-in pra uma lista de pessoas (default: o time).
 * NÃO envia — só gera. O comando /seal:checkin mostra e o TL escolhe o que disparar.
 */
export async function prepareCheckins(people = ['Felipe', 'Gus', 'Carla', 'Rafael']) {
  const out = [];
  for (const person of people) {
    try {
      out.push(await buildCheckinSuggestion(person));
    } catch (err) {
      out.push({ person, suggestion: '', basedOn: [], hasContext: false, error: err.message });
    }
  }
  return out;
}

// Pergunta genérica de fallback (tom do Uli, seco) quando a pessoa não tem contexto.
function genericQuestion(person) {
  return `${person}, e aí, no que tá mexendo? travou em algo?`;
}

/**
 * Fluxo completo "pergunta o TL primeiro": pra cada pessoa, gera a sugestão e
 * MANDA NO TELEGRAM com 3 botões (Enviar / Ajustar / Pular). Só o que o TL
 * aprova vai pro Teams. No "Ajustar", espera o TL digitar o texto novo.
 *
 * @param {object} gateway - GatewayRouter (do runner), com confirm()/onMessage()
 * @param {string[]} people
 * @returns {Promise<Array<{person, action, sent?, message?}>>}
 */
export async function proposeCheckinsViaTelegram(gateway, people = ['Felipe', 'Gus', 'Carla', 'Rafael']) {
  if (!gateway || typeof gateway.confirm !== 'function') {
    throw new Error('gateway com confirm() é necessário pra propor check-ins no Telegram');
  }
  const results = [];

  for (const person of people) {
    let s;
    try { s = await buildCheckinSuggestion(person); }
    catch { s = { person, suggestion: '', basedOn: [], hasContext: false }; }

    const proposed = s.suggestion || genericQuestion(person);
    const basedOn = s.basedOn?.length ? `\n\n_baseado em: ${s.basedOn.join(' · ')}_` : '';
    const actionId = `checkin-${person}-${randomBytes(3).toString('hex')}`;

    let choice;
    try {
      const res = await gateway.confirm(null, {
        actionId,
        description: `Mandar pro ${person} no Teams:\n\n"${proposed}"${basedOn}`,
        options: [
          { label: '✅ Enviar', callbackData: 'send' },
          { label: '✏️ Ajustar', callbackData: 'edit' },
          { label: '⏭️ Pular', callbackData: 'skip' },
        ],
      });
      choice = res.choice;
    } catch (err) {
      results.push({ person, action: 'timeout', error: err.message });
      continue; // não respondeu a tempo → não manda nada
    }

    if (choice === 'skip') {
      results.push({ person, action: 'skip' });
      continue;
    }

    let finalMessage = proposed;
    if (choice === 'edit') {
      // Espera o TL digitar o texto corrigido (próxima mensagem dele no chat).
      finalMessage = await waitForNextMessage(gateway, 120_000);
      if (!finalMessage) {
        results.push({ person, action: 'edit-timeout' });
        continue;
      }
    }

    const sent = await sendToTeams(person, finalMessage);
    results.push({ person, action: choice === 'edit' ? 'edited' : 'send', sent, message: finalMessage });
  }

  return results;
}

// Captura a PRÓXIMA mensagem de texto que o TL mandar (pro "Ajustar"). Resolve
// null se estourar o timeout.
function waitForNextMessage(gateway, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    gateway.onMessage((msg) => {
      if (done) return;
      const text = (msg?.text || '').trim();
      if (!text) return;
      done = true;
      clearTimeout(timer);
      resolve(text);
    });
  });
}
