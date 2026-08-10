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
    await bot.sendMessage(chatId, 'SEAL: Transcribing...');

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

    await handleText(text, chatId, config);
  } catch (err) {
    console.error('[telegram] Voice transcription failed:', err.message);
    await bot.sendMessage(chatId, 'SEAL: Voice transcription failed.');
  }
}

// Confiança mínima para gravar sem perguntar. Abaixo disso o SEAL pergunta em
// vez de adivinhar: classificar errado em silêncio corrompe justamente o dado
// que a revisão de 14 dias vai ler.
const ROUTE_CONFIDENCE_FLOOR = 0.6;

// Resposta de ritual aguardando o usuário desambiguar ("1" ou "2").
const pendingRoute = new Map();

const RITUAL_LABEL = { 'tl-log': 'TL Log', radar: 'Radar de incidentes' };

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
        await handleText(waiting.text, chatId, waiting.config);
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
    const { classifyMessage } = await import('./brain/route-voice.js');
    const { getRecentlyFiredRituals } = await import('./db.js');

    const fired = await getRecentlyFiredRituals({ windowHours: 20 });
    const hint = fired[0]
      ? {
          summary: fired[0].summary,
          hoursAgo: Math.round(
            (Date.now() - new Date(fired[0].last_notified_at + 'Z').getTime()) / 3_600_000
          ),
        }
      : null;

    const result = await classifyMessage(text, { pendingRitual: hint });
    console.log(`[telegram] Route: kind=${result.kind} conf=${result.confidence} src=${result.source}`);

    if (result.kind === 'unknown' || result.confidence < ROUTE_CONFIDENCE_FLOOR) {
      // Só pergunta se havia mesmo um ritual esperando. Sem isso, qualquer
      // tarefa solta ("lembra de pagar o boleto") viraria uma pergunta chata.
      if (!fired.length) return false;

      pendingRoute.set(chatId, { text, config: null });
      await bot.sendMessage(chatId,
        `SEAL: não tenho certeza do que é isso. Responde com o número:\n\n` +
        `1 — TL Log\n2 — Radar de incidentes\n3 — Nenhum dos dois (vira tarefa)\n\n` +
        `"${text.slice(0, 100)}${text.length > 100 ? '…' : ''}"`);
      return true;
    }

    const { rendered, degraded } = await saveRitualResponse(result.kind, text, chatId);
    // Sempre mostra o que entendeu. Se classificou errado, o usuário vê agora —
    // não em 25/08 com o dado já contaminado.
    await bot.sendMessage(chatId,
      `SEAL: ${RITUAL_LABEL[result.kind]} salvo.\n\n${rendered}\n\n` +
      (degraded ? '(IA fora do ar — texto cru, sem estruturar.)\n' : '') +
      `Se eu errei o ritual, manda "corrigir".`);
    return true;
  } catch (err) {
    console.error('[telegram] Ritual routing failed:', err.message);
    return false; // degrada para o fluxo normal de tarefa
  }
}

async function handleText(text, chatId, config) {
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

  // Multiple projects — ask
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
export async function sendTelegramMessage(chatId, text) {
  if (!chatId) return false;

  // If the ingestion bot is running, use it directly
  if (bot) {
    try {
      await bot.sendMessage(chatId, text);
      return true;
    } catch (err) {
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
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('[telegram] sendMessage HTTP failed:', data.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[telegram] sendMessage HTTP failed:', err.message);
    return false;
  }
}
