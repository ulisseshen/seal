import TelegramBot from 'node-telegram-bot-api';
import { insertTask } from './db.js';
import { transcribeBuffer } from './transcribe.js';
import { detectProject, getKnownProjects } from './projects.js';
import { resolveSecret } from './config.js';
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

  bot = new TelegramBot(token, { polling: true });

  console.log('[telegram] Bot started. Waiting for messages...');

  // --- Text messages ---
  bot.on('message', async (msg) => {
    try {
      // Security: only accept messages from allowed users
      const userId = msg.from.id.toString();
      const username = msg.from.username || '';

      if (allowedUsers && allowedUsers.length > 0) {
        const allowed = allowedUsers.some(u =>
          u === userId || u === username || u === `@${username}`
        );
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
    await handleText(text, chatId, config);
  } catch (err) {
    console.error('[telegram] Voice transcription failed:', err.message);
    await bot.sendMessage(chatId, 'SEAL: Voice transcription failed.');
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
