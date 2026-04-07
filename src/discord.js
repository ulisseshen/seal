import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { insertTask } from './db.js';
import { transcribeBuffer } from './transcribe.js';
import { detectProject, getKnownProjects } from './projects.js';
import { resolveSecret } from './config.js';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

let client = null;

// Pending tasks waiting for project assignment
const pendingProject = new Map();

/**
 * Start Discord bot for SEAL task ingestion.
 *
 * Setup:
 *   1. Go to https://discord.com/developers/applications → New Application
 *   2. Bot tab → Reset Token → copy it
 *   3. Enable "Message Content Intent" in Bot tab → Privileged Gateway Intents
 *   4. OAuth2 → URL Generator → scopes: bot → permissions: Send Messages, Read Message History
 *   5. Use generated URL to invite bot to a server (needed even for DMs)
 *   6. Set token: export SEAL_DISCORD_TOKEN="your-token" or add to .secrets
 *   7. Set discord.enabled: true in ~/.config/seal/ingest.json
 *   8. Run seal-run
 *
 * Usage — DM the bot directly:
 *   "valenty: run all tests"     -> task for valenty
 *   "fix the auth bug"           -> asks which project
 *   Voice message attachment     -> transcribed -> task
 */
export function startDiscord(config) {
  if (!config.discord?.enabled) return null;

  const { token: configToken, allowedUsers, dmOnly } = config.discord;

  // Resolve token: config -> env var -> .secrets file
  const token = resolveSecret(configToken, 'SEAL_DISCORD_TOKEN', 'discord_token');

  if (!token) {
    console.log('[discord] Missing token. Set via config, SEAL_DISCORD_TOKEN env var, or .secrets file.');
    return null;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel], // Required for DMs
  });

  client.once('ready', () => {
    console.log(`[discord] Bot started as ${client.user.tag}. Waiting for messages...`);
  });

  client.on('messageCreate', async (msg) => {
    try {
      // Ignore bot messages (prevent self-reply loops)
      if (msg.author.bot) return;

      // DM-only mode: skip guild (server) messages
      if (dmOnly !== false && !msg.channel.isDMBased()) return;

      // Security: only accept messages from allowed users
      const userId = msg.author.id;
      const username = msg.author.username;

      if (allowedUsers && allowedUsers.length > 0) {
        const allowed = allowedUsers.some(u =>
          u === userId || u === username
        );
        if (!allowed) {
          await msg.channel.send('SEAL: Not authorized. Add your Discord user ID to the config.');
          return;
        }
      }

      const channelId = msg.channel.id;

      // Handle voice message / audio attachments
      const audioAttachment = msg.attachments.find(att => {
        const name = (att.name || '').toLowerCase();
        return name.endsWith('.ogg') || name.endsWith('.mp3') || name.endsWith('.m4a')
          || name.endsWith('.wav') || name.endsWith('.opus') || name.endsWith('.webm');
      });

      if (audioAttachment) {
        await handleVoice(msg, audioAttachment, channelId, config);
        return;
      }

      // Handle text
      if (msg.content) {
        await handleText(msg.content, channelId, msg, config);
      }
    } catch (err) {
      console.error('[discord] Error:', err.message);
    }
  });

  client.login(token).catch((err) => {
    console.error('[discord] Login failed:', err.message);
    client = null;
  });

  return client;
}

async function handleVoice(msg, attachment, channelId, config) {
  try {
    await msg.channel.send('SEAL: Transcribing...');

    const response = await fetch(attachment.url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const ext = (attachment.name || 'audio.ogg').split('.').pop().toLowerCase();
    const text = transcribeBuffer(buffer, `dc_${Date.now()}.${ext}`, config);

    console.log(`[discord] Transcribed: "${text.slice(0, 60)}..."`);
    await handleText(text, channelId, msg, config);
  } catch (err) {
    console.error('[discord] Voice transcription failed:', err.message);
    await msg.channel.send('SEAL: Voice transcription failed.');
  }
}

async function handleText(text, channelId, msg, config) {
  // Check if this is a reply to a pending project question
  const pending = pendingProject.get(channelId);
  if (pending) {
    const projects = getKnownProjects();
    const answer = text.trim().toLowerCase();
    const match = projects.find(p => p.toLowerCase() === answer);

    if (match) {
      pending.task.project = path.join(os.homedir(), 'projects', match);
      await insertTask(pending.task);
      pendingProject.delete(channelId);
      await msg.channel.send(`SEAL: ${pending.task.summary} \u2192 ${match}`);
      console.log(`[discord] "${pending.task.summary}" \u2192 ${match} (${pending.task.id})`);
      return;
    }

    // Not a valid project -- save old task without project, process new message
    await insertTask(pending.task);
    pendingProject.delete(channelId);
    console.log(`[discord] "${pending.task.summary}" saved without project (${pending.task.id})`);
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
    notify_channel: 'discord',
    people: '[]',
    priority: 'medium',
    status: 'pending',
    created: new Date().toISOString(),
    max_runs: null,
  };

  // Project found -> save
  if (project) {
    await insertTask(task);
    await msg.channel.send(`SEAL: ${summary} \u2192 ${projectName}`);
    console.log(`[discord] "${summary}" \u2192 ${projectName} (${task.id})`);
    return;
  }

  // No project
  const projects = getKnownProjects();

  if (projects.length <= 1) {
    if (projects.length === 1) {
      task.project = path.join(os.homedir(), 'projects', projects[0]);
    }
    await insertTask(task);
    await msg.channel.send(`SEAL: ${summary}${projects[0] ? ' \u2192 ' + projects[0] : ''}`);
    console.log(`[discord] "${summary}" (${task.id})`);
    return;
  }

  // Multiple projects -- ask
  pendingProject.set(channelId, { task, timestamp: Date.now() });

  // Auto-expire after 5 minutes
  setTimeout(async () => {
    const still = pendingProject.get(channelId);
    if (still && still.task.id === task.id) {
      await insertTask(still.task);
      pendingProject.delete(channelId);
      console.log(`[discord] "${summary}" expired, saved without project (${task.id})`);
    }
  }, 5 * 60 * 1000);

  await msg.channel.send(`SEAL: Which project?\n${projects.join(', ')}`);
  console.log(`[discord] Asking project for: "${summary}"`);
}

export function isDiscordConnected() {
  return client !== null && client.isReady();
}
