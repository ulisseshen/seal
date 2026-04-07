import { sendTelegramMessage } from './telegram.js';
import { sendDiscordMessage } from './discord.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { notify } from './notify.js';

/**
 * Unified channel notification dispatcher.
 *
 * Notifies the user about a task lifecycle event:
 *   - On the same channel where the task was created (if available)
 *   - Plus macOS system notification (always)
 *
 * Phase: 'start' | 'done' | 'failed'
 *
 * Used by executor.js to give OpenClaw-style "the bot talks back" UX.
 */
export async function notifyTaskLifecycle(task, phase, message) {
  const formatted = formatMessage(task, phase, message);

  // 1. Always fire macOS system notification
  const sysLevel = phase === 'failed' ? 'sound' : 'sound';
  notify({ ...task, summary: formatted }, sysLevel);

  // 2. Reply on the originating channel if we know how to reach it
  const channel = task.notify_channel;
  const target = task.notify_target;

  if (!target || !channel || channel === 'system') return;

  try {
    if (channel === 'telegram') {
      await sendTelegramMessage(target, `SEAL: ${formatted}`);
    } else if (channel === 'discord') {
      await sendDiscordMessage(target, `**SEAL:** ${formatted}`);
    } else if (channel === 'whatsapp') {
      await sendWhatsAppMessage(target, `SEAL: ${formatted}`);
    }
    // email channel doesn't support live replies (one-way ingestion)
  } catch (err) {
    console.error(`[channel-notify] Failed to notify ${channel}:`, err.message);
  }
}

function formatMessage(task, phase, message) {
  if (message) return message;

  const summary = task.summary || 'task';
  if (phase === 'start') return `Working on: ${summary}`;
  if (phase === 'done') return `Done: ${summary}`;
  if (phase === 'failed') return `Failed: ${summary}`;
  return summary;
}
