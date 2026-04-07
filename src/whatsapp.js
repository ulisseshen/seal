import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestWaWebVersion,
  DisconnectReason,
  Browsers,
} from '@whiskeysockets/baileys';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { insertTask } from './db.js';
import { transcribeBuffer } from './transcribe.js';
import { detectProject, getKnownProjects } from './projects.js';
import crypto from 'crypto';

const AUTH_DIR = path.join(os.homedir(), '.config', 'seal', 'whatsapp-auth');

let sock = null;
let connected = false;

// Pending tasks waiting for project assignment
// Key: chatJid, Value: { task, timestamp }
const pendingProject = new Map();

export async function startWhatsApp(config) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    const fetched = await fetchLatestWaWebVersion({});
    version = fetched.version;
  } catch {}

  const silentLogger = {
    level: 'silent',
    trace: () => {}, debug: () => {}, info: () => {},
    warn: () => {}, error: () => {}, fatal: () => {},
    child: () => silentLogger,
  };

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    printQRInTerminal: false,
    logger: silentLogger,
    browser: Browsers.macOS('Chrome'),
    getMessage: async () => ({ conversation: '' }),
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n[whatsapp] Scan this QR code with WhatsApp:');
      qrcode.generate(qr, { small: true });
      console.log('[whatsapp] WhatsApp → Settings → Linked Devices → Link a Device\n');
    }

    if (connection === 'open') {
      connected = true;
      console.log('[whatsapp] Connected! Send messages to yourself to create SEAL tasks.');
    }

    if (connection === 'close') {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('[whatsapp] Logged out. Delete ~/.config/seal/whatsapp-auth/ and restart.');
      } else {
        console.log('[whatsapp] Disconnected. Reconnecting in 5s...');
        setTimeout(() => startWhatsApp(config), 5000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;
        await processMessage(msg, config);
      } catch (err) {
        console.error('[whatsapp] Message error:', err.message);
      }
    }
  });

  return sock;
}

async function reply(jid, text) {
  if (!sock || !connected) return;
  try {
    await sock.sendMessage(jid, { text: `SEAL: ${text}` });
  } catch (err) {
    console.error('[whatsapp] Reply failed:', err.message);
  }
}

async function processMessage(msg, config) {
  const normalized = msg.message;
  if (!normalized) return;
  const jid = msg.key.remoteJid;

  let text = '';

  // Text message
  text = normalized.conversation
    || normalized.extendedTextMessage?.text
    || '';

  // Voice note
  if (normalized.audioMessage) {
    try {
      console.log('[whatsapp] Downloading voice note...');
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      const mime = normalized.audioMessage.mimetype || 'audio/ogg';
      const ext = mime.split('/')[1]?.split(';')[0] || 'ogg';
      text = transcribeBuffer(buffer, `wa_${Date.now()}.${ext}`, config);
      console.log(`[whatsapp] Transcribed: "${text.slice(0, 60)}..."`);
    } catch (err) {
      console.error('[whatsapp] Voice note failed:', err.message);
      text = '[Voice note — transcription failed]';
    }
  }

  if (!text) return;

  // ─── Check if this is a reply to a pending project question ───
  const pending = pendingProject.get(jid);
  if (pending) {
    const projects = getKnownProjects();
    const answer = text.trim().toLowerCase();
    const match = projects.find(p => p.toLowerCase() === answer);

    if (match) {
      // User answered with a valid project name
      pending.task.project = path.join(os.homedir(), 'projects', match);
      await insertTask(pending.task);
      pendingProject.delete(jid);
      await reply(jid, `${pending.task.summary} → ${match}`);
      console.log(`[whatsapp] "${pending.task.summary}" → ${match} (${pending.task.id})`);
      return;
    }

    // Not a valid project — maybe it's a new task, fall through
    // But first, save the old pending task without project
    await insertTask(pending.task);
    pendingProject.delete(jid);
    console.log(`[whatsapp] "${pending.task.summary}" (no project) (${pending.task.id})`);
    // Continue to process current message as new task
  }

  // ─── Detect project from message ───
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
    notify_channel: 'whatsapp',
    notify_target: jid,
    people: '[]',
    priority: 'medium',
    status: 'pending',
    created: new Date().toISOString(),
    max_runs: null,
  };

  // ─── Project found → save immediately ───
  if (project) {
    await insertTask(task);
    await reply(jid, `${summary} → ${projectName}`);
    console.log(`[whatsapp] "${summary}" → ${projectName} (${task.id})`);
    return;
  }

  // ─── No project detected ───
  const projects = getKnownProjects();

  if (projects.length === 0) {
    // No projects exist — just save without project
    await insertTask(task);
    console.log(`[whatsapp] "${summary}" (${task.id})`);
    return;
  }

  if (projects.length === 1) {
    // Only one project — auto-assign
    task.project = path.join(os.homedir(), 'projects', projects[0]);
    await insertTask(task);
    await reply(jid, `${summary} → ${projects[0]}`);
    console.log(`[whatsapp] "${summary}" → ${projects[0]} (${task.id})`);
    return;
  }

  // Multiple projects — ask which one
  pendingProject.set(jid, { task, timestamp: Date.now() });

  // Auto-expire pending after 5 minutes
  setTimeout(() => {
    const still = pendingProject.get(jid);
    if (still && still.task.id === task.id) {
      insertTask(still.task); // Save without project
      pendingProject.delete(jid);
      console.log(`[whatsapp] "${summary}" expired, saved without project (${task.id})`);
    }
  }, 5 * 60 * 1000);

  const projectList = projects.join(', ');
  await reply(jid, `Which project?\n${projectList}`);
  console.log(`[whatsapp] Asking project for: "${summary}"`);
}

export function isWhatsAppConnected() {
  return connected;
}

/**
 * Send a message to a WhatsApp JID from outside this module (used by executor lifecycle).
 * Returns true on success, false if not connected or send failed.
 */
export async function sendWhatsAppMessage(jid, text) {
  if (!sock || !connected || !jid) return false;
  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    console.error('[whatsapp] sendMessage failed:', err.message);
    return false;
  }
}
