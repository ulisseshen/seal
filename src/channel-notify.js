import { sendTelegramMessage } from './telegram.js';
import { sendDiscordMessage } from './discord.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { notify } from './notify.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

/**
 * Optional gateway router — set by runner.js after the gateway initializes.
 * When present, lifecycle notifications also fan out via the gateway
 * (Telegram by default), even for tasks that originated in the system
 * channel (e.g. PR review tasks created by the azure-pr-review sensor).
 */
let gatewayRouter = null;

export function setGatewayRouter(router) {
  gatewayRouter = router;
}

/**
 * Unified channel notification dispatcher.
 *
 * Notifies the user about a task lifecycle event:
 *   - macOS system notification (always)
 *   - Originating channel (if the task came from chat) — falls back to
 *     channels.json defaults when no per-task target is set
 *   - Gateway router (if configured) — fans out to default channel
 *
 * Phase: 'start' | 'done' | 'failed'
 *
 * Used by executor.js to give OpenClaw-style "the bot talks back" UX.
 */
export async function notifyTaskLifecycle(task, phase, message) {
  const formatted = formatMessage(task, phase, message);

  // 1. macOS system notification (always)
  notify({ ...task, summary: formatted }, 'sound');

  // 2. Reply on the originating channel if we know how to reach it
  const channel = task.notify_channel;
  let target = task.notify_target;

  if (channel && channel !== 'system') {
    // Fall back to channels.json defaults when no per-task target is set
    if (!target) {
      try {
        const cfg = JSON.parse(readFileSync(join(os.homedir(), '.config/seal/channels.json'), 'utf8'));
        if (channel === 'telegram' && cfg.telegram?.chat_id) target = cfg.telegram.chat_id;
      } catch {}
    }

    if (target) {
      try {
        console.log(`[channel-notify] Sending to ${channel} (target=${target})`);
        if (channel === 'telegram') {
          const ok = await sendTelegramMessage(target, `SEAL: ${formatted}`);
          console.log(`[channel-notify] Telegram result: ${ok}`);
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
  }

  // 3. Gateway broadcast (fans out to default channel — Telegram).
  //    Skipped when channel === target's channel to avoid duplicate replies.
  if (gatewayRouter) {
    try {
      const level =
        phase === 'failed' ? 'urgent' :
        phase === 'done'   ? 'info'   :
        'info';
      const category = `task-${phase}`;
      await gatewayRouter.send({
        text: formatted,
        level,
        category,
      });
    } catch (err) {
      console.warn(`[channel-notify] gateway send failed:`, err.message);
    }
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
