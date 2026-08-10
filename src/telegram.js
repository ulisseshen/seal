import TelegramBot from 'node-telegram-bot-api';
import { insertTask } from './db.js';
import { transcribeBuffer } from './transcribe.js';
import { detectProject, getKnownProjects } from './projects.js';
import { resolveSecret } from './config.js';
import { setSharedBot, getExistingBot } from './gateway/telegram/bot.js';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

let bot = null;

// Pending tasks waiting for project assignment
const pendingProject = new Map();

/**
 * Start Telegram bot for SEAL task ingestion.
 *
 * Setup:
 *   1. Message @BotFather on Telegram → /newbot → name it "SEAL by Hens"
 *   2. Copy the token → add to ~/.config/seal/ingest.json
 *   3. Message your bot to start receiving tasks
 *
 * Usage — just message the bot:
 *   "valenty: run all tests"     → task for valenty
 *   "fix the auth bug"           → asks which project
 *   Voice note                   → transcribed → task
 */
export function startTelegram(config) {
  if (!config.telegram?.enabled) return null;

  const { token: configToken, allowedUsers } = config.telegram;

  // Resolve token: config → env var → .secrets file
  const token = resolveSecret(configToken, 'SEAL_TELEGRAM_TOKEN', 'telegram_token');

  if (!token) {
    console.log('[telegram] Missing token. Set via config, SEAL_TELEGRAM_TOKEN env var, or .secrets file.');
    return null;
  }

  // Reuse the gateway's bot instance if it was already created; otherwise
  // create one and register it so the gateway plugin uses the same.
  // This prevents the dreaded "ETELEGRAM 409 Conflict" loop that crashes
  // the runner when two polling instances exist for the same token.
  const existing = getExistingBot();
  if (existing) {
    bot = existing;
    console.log('[telegram] Reusing existing shared bot instance');
  } else {
    bot = new TelegramBot(token, { polling: true });
    setSharedBot(bot);
    console.log('[telegram] Bot started. Waiting for messages...');
  }

  // Always attach an error handler — without one, polling errors become
  // unhandled `error` events and crash the Node process.
  bot.on('polling_error', (err) => {
    console.warn('[telegram] polling_error:', err?.code || err?.message || err);
  });
  bot.on('error', (err) => {
    console.warn('[telegram] error:', err?.code || err?.message || err);
  });

  // --- Text messages ---
  bot.on('message', async (msg) => {
    try {
      // Security: only accept messages from allowed users
      const userId = msg.from.id.toString();
      const username = msg.from.username || '';

      if (allowedUsers && allowedUsers.length > 0) {
        const allowed = allowedUsers.some(u => {
          // Normalize: allow numeric ID (number or string), username, @username
          const us = String(u);
          return us === userId || us === username || us === `@${username}`;
        });
        if (!allowed) {
          await bot.sendMessage(msg.chat.id, 'SEAL: Not authorized. Add your Telegram user ID to the config.');
          return;
        }
      }

      const chatId = msg.chat.id;

      // Handle voice notes
      if (msg.voice || msg.audio) {
        await handleVoice(msg, chatId, config);
        return;
      }

      // Handle text
      if (msg.text) {
        // Skip commands other than /start
        if (msg.text === '/start') {
          await bot.sendMessage(chatId, 'SEAL ready. Send me tasks, voice notes, or project-specific messages.\n\nExamples:\n• "valenty: run tests"\n• "fix the auth bug"\n• Voice note → auto-transcribed');
          return;
        }

        // "apaga 2" tem que ser tratado ANTES de tudo, senão vira tarefa nova.
        if (await tryHandleCorrection(msg.text, chatId)) return;

        await handleText(msg.text, chatId, config);
      }
    } catch (err) {
      console.error('[telegram] Error:', err.message);
    }
  });

  return bot;
}

async function handleVoice(msg, chatId, config) {
  const fileId = msg.voice?.file_id || msg.audio?.file_id;
  if (!fileId) return;

  try {
    // UMA mensagem de status, que depois vira o resultado por edição. Antes
    // eram três ("ouvindo" → transcrição → "entendi N"), o que fazia o SEAL
    // narrar o próprio processo interno em vez de só trabalhar e reportar.
    // O usuário quer confirmação de recebimento + resultado, não pensamento
    // em voz alta.
    const status = await bot.sendMessage(chatId, '🎧 já ouvi, processando...');
    statusMsg.set(chatId, status.message_id);

    const fileLink = await bot.getFileLink(fileId);
    const response = await fetch(fileLink);
    const buffer = Buffer.from(await response.arrayBuffer());

    const ext = msg.voice ? 'ogg' : (msg.audio?.mime_type?.split('/')[1] || 'mp3');
    const text = transcribeBuffer(buffer, `tg_${Date.now()}.${ext}`, config);

    console.log(`[telegram] Transcribed: "${text.slice(0, 60)}..."`);

    // Antes de virar tarefa solta, tenta rotear para um ritual. O usuário
    // responde os rituais "na sequência" — manda o áudio sem dizer a que se
    // refere. Se não for resposta de ritual, cai no fluxo normal de tarefa.
    const routed = await tryRouteToRitual(text, chatId);
    if (routed) return;

    // Áudio NUNCA vira interrogatório de projeto. Voz é captura rápida — o
    // usuário falou e seguiu a vida; perguntar "qual projeto?" prende a
    // conversa (a resposta seguinte dele é engolida como resposta à pergunta,
    // que foi exatamente o que aconteceu em 10/08). Salva sem projeto; dá para
    // classificar depois no dashboard.
    await handleText(text, chatId, config, { askProject: false });
  } catch (err) {
    console.error('[telegram] Voice transcription failed:', err.message);
    await finishStatus(chatId, `🔴 <b>não consegui transcrever</b>\n<i>${esc(err.message)}</i>`);
  }
}

// Confiança mínima para gravar sem perguntar. Abaixo disso o SEAL pergunta em
// vez de adivinhar: classificar errado em silêncio corrompe justamente o dado
// que a revisão de 14 dias vai ler.
const ROUTE_CONFIDENCE_FLOOR = 0.6;

// Id da mensagem de status por chat. O resultado EDITA essa mensagem em vez de
// mandar outra — assim o chat fica com uma linha por áudio, não com três.
const statusMsg = new Map();

/**
 * Escreve o resultado no lugar da mensagem de status. Se a edição falhar
 * (mensagem velha demais, apagada), manda nova — nunca perde o resultado.
 */
async function finishStatus(chatId, html) {
  const messageId = statusMsg.get(chatId);
  statusMsg.delete(chatId);

  if (messageId) {
    try {
      await bot.editMessageText(html, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
      return;
    } catch (err) {
      if (!String(err.message).includes('not modified')) {
        console.warn('[telegram] edit failed, sending new:', err.message);
      } else {
        return;
      }
    }
  }
  await sendHtml(chatId, html);
}

/**
 * Responde consumindo a mensagem de status se houver uma pendente (o comando
 * veio por voz), senão manda nova (veio por texto). Sem isso a correção falada
 * deixaria "processando..." pendurado para sempre.
 */
async function reply(chatId, html) {
  if (statusMsg.has(chatId)) return finishStatus(chatId, html);
  return sendHtml(chatId, html);
}

/** Escapa texto para o parse_mode HTML do Telegram. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Envia com formatação HTML, caindo para texto puro se o Telegram recusar o
 * parse. Mesmo padrão que o gateway já usa — o telegram.js estava mandando
 * texto cru, o que deixava toda resposta de áudio sem negrito, sem itálico e
 * visualmente achatada.
 *
 * IMPORTANTE: quem chama deve escapar o conteúdo dinâmico com esc(). A fala
 * transcrita pode conter "<" ou "&" e derrubaria o envio inteiro.
 */
async function sendHtml(chatId, html, extra = {}) {
  try {
    return await bot.sendMessage(chatId, html, { parse_mode: 'HTML', ...extra });
  } catch (err) {
    if (String(err.message).includes('parse')) {
      const plain = html.replace(/<[^>]+>/g, '');
      console.warn('[telegram] HTML parse failed, sending plain:', err.message);
      return bot.sendMessage(chatId, plain, extra);
    }
    throw err;
  }
}

// Resposta de ritual aguardando o usuário desambiguar ("1" ou "2").
const pendingRoute = new Map();

// Últimos itens salvos por chat, para permitir "apaga 2". Sem isso a lista de
// confirmação seria teatro: mostra o erro e não deixa corrigir.
const lastSaved = new Map();

/**
 * Trata "apaga 2" / "apaga tudo" referente à última fala salva.
 * Retorna true se tratou.
 */
async function tryHandleCorrection(text, chatId) {
  const t = text.trim().toLowerCase();
  const m = t.match(/^(apaga|apagar|remove|remover|corrig\w*)\s+(tudo|todos|\d+)$/);
  if (!m) return false;

  const saved = lastSaved.get(chatId);
  if (!saved || !saved.length) {
    await reply(chatId, '<i>nada recente para apagar</i>');
    return true;
  }

  const { deleteTask } = await import('./db.js');

  if (m[2] === 'tudo' || m[2] === 'todos') {
    for (const item of saved) await deleteTask(item.id);
    lastSaved.delete(chatId);
    await reply(chatId, `🗑️ <b>${saved.length} apagado${saved.length === 1 ? '' : 's'}</b>`);
    return true;
  }

  const n = parseInt(m[2], 10);
  if (!n || n < 1 || n > saved.length) {
    await reply(chatId, `<i>só tenho ${saved.length} item(ns) — manda 1 a ${saved.length}</i>`);
    return true;
  }

  const alvo = saved[n - 1];
  await deleteTask(alvo.id);
  saved.splice(n - 1, 1);
  lastSaved.set(chatId, saved);
  await reply(chatId, `🗑️ <b>apagado:</b> <i>${esc(alvo.resumo)}</i>`);
  return true;
}

const RITUAL_LABEL = { 'tl-log': 'TL Log', radar: 'Radar de incidentes' };

// Mapeia o tipo extraído para o `type` do banco. 'radar' e 'tl-log' viram
// 'person' (nota) porque é o tipo que o dashboard já lista e que a revisão de
// 25/08 vai contar; o que distingue é o project + summary.
const TYPE_TO_DB = {
  radar: 'person',
  'tl-log': 'person',
  pessoa: 'person',
  tarefa: 'task',
  decisao: 'decision',
  outro: 'task',
};

const TYPE_LABEL_DB = {
  radar: 'Radar',
  'tl-log': 'TL Log',
  pessoa: 'Nota',
  tarefa: 'Tarefa',
  decisao: 'Decisão',
  outro: 'Nota',
};

/**
 * Grava os N itens extraídos de uma fala. Cada item vira sua própria linha, do
 * seu tipo — nada some dentro de outro. Devolve os ids para permitir correção.
 */
async function saveItems(itens, rawText, chatId) {
  const today = new Date().toISOString().slice(0, 10);
  const saved = [];

  for (const item of itens) {
    const dbType = TYPE_TO_DB[item.tipo] || 'task';
    const label = TYPE_LABEL_DB[item.tipo] || 'Nota';
    const id = crypto.randomUUID().slice(0, 8);

    // Só o primeiro item guarda a transcrição crua — repetir o áudio inteiro em
    // cada linha polui o banco, mas perder o original impede recuperar nome
    // próprio que o whisper errou.
    const isFirst = saved.length === 0;
    const detail = isFirst
      ? `${item.texto}\n\n---\ntranscrição original:\n${rawText.trim()}`
      : item.texto;

    await insertTask({
      id,
      type: dbType,
      summary: `${label} — ${item.resumo}`.slice(0, 80),
      detail,
      execute_at: null,
      recurrence: null,
      next_run: null,
      prompt: null,
      // Rituais vão para o projeto que a revisão de 25/08 conta. Tarefa e
      // decisão ficam sem projeto — são trabalho, não medição do experimento.
      project: (item.tipo === 'radar' || item.tipo === 'tl-log') ? 'techlead-90d' : null,
      allowed_tools: '[]',
      permission_mode: 'auto',
      notify_type: 'silent',
      notify_channel: 'telegram',
      notify_target: String(chatId),
      people: item.pessoa ? JSON.stringify([item.pessoa]) : '[]',
      priority: 'medium',
      // Tarefa fica pendente (é trabalho a fazer). Registro fica done.
      status: item.tipo === 'tarefa' ? 'pending' : 'done',
      created: new Date().toISOString(),
      max_runs: null,
    });

    saved.push({ id, ...item });
  }

  return saved;
}

/**
 * Grava a resposta de um ritual: estrutura via IA e insere como type='person'
 * (nota), vinculada ao ritual pelo project. Devolve o texto renderizado para a
 * confirmação.
 */
async function saveRitualResponse(kind, text, chatId) {
  const { structureResponse, renderStructured } = await import('./brain/route-voice.js');
  const { structured, degraded } = await structureResponse(text, kind);
  const rendered = renderStructured(kind, structured, text);

  const label = RITUAL_LABEL[kind] || kind;
  const today = new Date().toISOString().slice(0, 10);

  await insertTask({
    id: crypto.randomUUID().slice(0, 8),
    type: 'person',
    summary: `${label} — ${today}`,
    // Guarda o texto cru junto: a transcrição pode ter errado um nome, e o
    // original é a única forma de recuperar o que foi dito de fato.
    detail: `${rendered}\n\n---\ntranscrição original:\n${text.trim()}`,
    execute_at: null,
    recurrence: null,
    next_run: null,
    prompt: null,
    project: 'techlead-90d',
    allowed_tools: '[]',
    permission_mode: 'auto',
    notify_type: 'silent',
    notify_channel: 'telegram',
    notify_target: String(chatId),
    people: '[]',
    priority: 'medium',
    status: 'done',
    created: new Date().toISOString(),
    max_runs: null,
  });

  return { rendered, degraded };
}

/**
 * Tenta interpretar a mensagem como resposta a um ritual.
 * Retorna true se tratou (o chamador não deve seguir para handleText).
 */
async function tryRouteToRitual(text, chatId) {
  // O usuário está respondendo "1" ou "2" a uma pergunta de desambiguação?
  const waiting = pendingRoute.get(chatId);
  if (waiting) {
    const answer = text.trim().toLowerCase();
    const pick =
      /^1\b|tl.?log/.test(answer) ? 'tl-log' :
      /^2\b|radar|incidente/.test(answer) ? 'radar' :
      /^3\b|nenhum|outro/.test(answer) ? 'none' : null;

    if (pick) {
      pendingRoute.delete(chatId);
      if (pick === 'none') {
        // Veio de áudio → mesma regra: não interroga sobre projeto.
        await handleText(waiting.text, chatId, waiting.config, { askProject: false });
        return true;
      }
      const { rendered, degraded } = await saveRitualResponse(pick, waiting.text, chatId);
      await bot.sendMessage(chatId,
        `SEAL: ${RITUAL_LABEL[pick]} salvo.\n\n${rendered}` +
        (degraded ? '\n\n(IA fora do ar — salvei o texto cru, sem estruturar.)' : ''));
      return true;
    }
    // Não era resposta à pergunta — segue o fluxo normal com a msg nova.
    pendingRoute.delete(chatId);
  }

  try {
    const { classifyMessage, isMicTest } = await import('./brain/route-voice.js');
    const { getRecentlyFiredRituals } = await import('./db.js');

    // Correção falada ("apaga dois"). O whisper escreve número por extenso, e
    // corrigir por voz é justamente o caminho de quem já está de mãos ocupadas.
    const numerais = { um: '1', dois: '2', tres: '3', três: '3', quatro: '4', cinco: '5', seis: '6' };
    const normalizado = text.trim().toLowerCase().replace(/\.$/, '')
      .replace(/\b(um|dois|tr[eê]s|quatro|cinco|seis)\b/g, (w) => numerais[w] || w);
    if (await tryHandleCorrection(normalizado, chatId)) return true;

    // Teste de microfone não é conteúdo. Responde e NÃO grava nada.
    if (isMicTest(text)) {
      console.log(`[telegram] Mic test ignored: "${text.slice(0, 40)}"`);
      await finishStatus(chatId, `👍 <b>te ouvi</b> — <i>nada registrado (teste de áudio)</i>`);
      return true;
    }

    const fired = await getRecentlyFiredRituals({ windowHours: 20 });
    const hint = fired[0]
      ? {
          summary: fired[0].summary,
          hoursAgo: Math.round(
            (Date.now() - new Date(fired[0].last_notified_at + 'Z').getTime()) / 3_600_000
          ),
        }
      : null;

    // Caminho principal: quebra a fala em N itens. Uma fala real de fim de dia
    // mistura incidente + aprendizado + tarefa, e escolher UM rótulo jogaria o
    // resto fora. `hint` continua sendo só contexto para a IA, nunca decisão.
    const { extractItems, renderItems } = await import('./brain/route-voice.js');
    const { itens, degraded } = await extractItems(text);
    console.log(`[telegram] Extracted ${itens.length} item(s): ${itens.map(i => i.tipo).join(', ')}`);

    // Nada com conteúdo real e nenhum ritual esperando → não é assunto do SEAL.
    // Deixa cair no fluxo normal de tarefa em vez de forçar uma categoria.
    const todosVazios = itens.every((i) => i.tipo === 'outro' && i.confianca < 0.4);
    if (todosVazios && !fired.length) {
      // Cai no fluxo de tarefa; a mensagem de status é consumida lá.
      return false;
    }

    const saved = await saveItems(itens, text, chatId);
    lastSaved.set(chatId, saved);

    // Log do que foi registrado. Sem narrar o processo — o que importa é o que
    // ficou gravado, não como o SEAL chegou lá.
    const plural = saved.length === 1 ? 'item' : 'itens';
    await finishStatus(chatId,
      `✅ <b>${saved.length} ${plural} registrado${saved.length === 1 ? '' : 's'}</b>\n\n` +
      `${renderItems(saved)}\n\n` +
      (degraded ? `⚠️ <i>IA fora do ar — gravei a fala inteira sem separar.</i>\n\n` : '') +
      `<i>errou? </i><code>apaga 2</code><i> · </i><code>apaga tudo</code>`);
    return true;
  } catch (err) {
    console.error('[telegram] Ritual routing failed:', err.message);
    return false; // degrada para o fluxo normal de tarefa
  }
}

async function handleText(text, chatId, config, { askProject = true } = {}) {
  // Check if this is a reply to a pending project question
  const pending = pendingProject.get(chatId);
  if (pending) {
    const projects = getKnownProjects();
    const answer = text.trim().toLowerCase();
    const match = projects.find(p => p.toLowerCase() === answer);

    if (match) {
      pending.task.project = path.join(os.homedir(), 'projects', match);
      await insertTask(pending.task);
      pendingProject.delete(chatId);
      await bot.sendMessage(chatId, `SEAL: ${pending.task.summary} → ${match}`);
      console.log(`[telegram] "${pending.task.summary}" → ${match} (${pending.task.id})`);
      return;
    }

    // Not a valid project — save old task without project, process new message
    await insertTask(pending.task);
    pendingProject.delete(chatId);
    console.log(`[telegram] "${pending.task.summary}" saved without project (${pending.task.id})`);
  }

  // Detect project
  const { project, projectName, cleanMessage } = detectProject(text);

  const lines = cleanMessage.split('\n');
  const summary = lines[0].slice(0, 80);
  const detail = lines.length > 1 ? lines.slice(1).join('\n').trim() : null;

  const task = {
    id: crypto.randomUUID().slice(0, 8),
    type: 'task',
    summary,
    detail,
    execute_at: null,
    recurrence: null,
    next_run: null,
    prompt: null,
    project,
    allowed_tools: '[]',
    permission_mode: 'auto',
    notify_type: 'sound',
    notify_channel: 'telegram',
    notify_target: String(chatId),
    people: '[]',
    priority: 'medium',
    status: 'pending',
    created: new Date().toISOString(),
    max_runs: null,
  };

  // Project found → save
  if (project) {
    await insertTask(task);
    await bot.sendMessage(chatId, `SEAL: ${summary} → ${projectName}`);
    console.log(`[telegram] "${summary}" → ${projectName} (${task.id})`);
    return;
  }

  // No project
  const projects = getKnownProjects();

  if (projects.length <= 1) {
    if (projects.length === 1) {
      task.project = path.join(os.homedir(), 'projects', projects[0]);
    }
    await insertTask(task);
    await bot.sendMessage(chatId, `SEAL: ${summary}${projects[0] ? ' → ' + projects[0] : ''}`);
    console.log(`[telegram] "${summary}" (${task.id})`);
    return;
  }

  // Multiple projects — normally ask, but never for voice (see handleVoice).
  if (!askProject) {
    await insertTask(task);
    // Veio de áudio: fecha a mensagem de status em vez de deixar "processando"
    // pendurado e mandar outra embaixo.
    await finishStatus(chatId, `✅ <b>1 item registrado</b>\n\n📘 <b>TAREFA</b>\n     ${esc(summary)}`);
    console.log(`[telegram] "${summary}" saved without project, no prompt (${task.id})`);
    return;
  }

  pendingProject.set(chatId, { task, timestamp: Date.now() });

  // Auto-expire after 5 minutes
  setTimeout(async () => {
    const still = pendingProject.get(chatId);
    if (still && still.task.id === task.id) {
      await insertTask(still.task);
      pendingProject.delete(chatId);
      console.log(`[telegram] "${summary}" expired, saved without project (${task.id})`);
    }
  }, 5 * 60 * 1000);

  await bot.sendMessage(chatId, `SEAL: Which project?\n${projects.join(', ')}`);
  console.log(`[telegram] Asking project for: "${summary}"`);
}

export function isTelegramConnected() {
  return bot !== null;
}

/**
 * Send a message to a Telegram chat from outside this module (used by executor lifecycle).
 * Returns true on success, false if not connected or send failed.
 */
export async function sendTelegramMessage(chatId, text, { html = true } = {}) {
  if (!chatId) return false;

  // Envia como HTML por padrão: os rituais chegam formatados por
  // brain/format-ritual.js e sem parse_mode as tags apareceriam literais na
  // tela — pior que o texto cru original. Se o parse falhar, tira as tags e
  // reenvia como texto puro, para a mensagem nunca se perder por formatação.
  const opts = html ? { parse_mode: 'HTML' } : {};
  const plain = () => text.replace(/<[^>]+>/g, '');

  // If the ingestion bot is running, use it directly
  if (bot) {
    try {
      await bot.sendMessage(chatId, text, opts);
      return true;
    } catch (err) {
      if (html && String(err.message).includes('parse')) {
        try {
          console.warn('[telegram] HTML parse failed, retrying plain:', err.message);
          await bot.sendMessage(chatId, plain());
          return true;
        } catch (retryErr) {
          console.error('[telegram] plain retry failed:', retryErr.message);
          return false;
        }
      }
      console.error('[telegram] sendMessage via bot failed:', err.message);
      return false;
    }
  }

  // Fallback: send via HTTP using token from channels.json
  try {
    const { readFileSync } = await import('fs');
    const cfg = JSON.parse(readFileSync(path.join(os.homedir(), '.config/seal/channels.json'), 'utf8'));
    const token = cfg.telegram?.bot_token;
    if (!token) {
      console.error('[telegram] No bot_token in channels.json');
      return false;
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...(html ? { parse_mode: 'HTML' } : {}) }),
    });
    const data = await res.json();
    if (!data.ok) {
      // Mesmo fallback do caminho do bot: HTML inválido não pode engolir a
      // mensagem inteira.
      if (html && /parse/i.test(data.description || '')) {
        const retry = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: plain() }),
        });
        return (await retry.json()).ok === true;
      }
      console.error('[telegram] sendMessage HTTP failed:', data.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[telegram] sendMessage HTTP failed:', err.message);
    return false;
  }
}
