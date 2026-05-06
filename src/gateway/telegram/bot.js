import TelegramBot from 'node-telegram-bot-api';
import { resolveSecret } from '../../config.js';

/**
 * Shared Telegram bot instance.
 *
 * Both the ingestion module (src/telegram.js) and the gateway plugin
 * need the same bot. This module ensures only one instance exists.
 *
 * The ingestion module calls startTelegram() which creates a bot with polling.
 * The gateway plugin can either:
 *   1. Reuse the bot created by ingestion (if telegram ingestion is enabled)
 *   2. Create its own bot (if ingestion is disabled but gateway needs Telegram)
 *
 * Usage:
 *   import { getOrCreateBot, getExistingBot, setSharedBot } from './bot.js';
 */

let sharedBot = null;

/**
 * Register a bot instance created elsewhere (e.g., by src/telegram.js).
 * @param {TelegramBot} bot
 */
export function setSharedBot(bot) {
  sharedBot = bot;
  console.log('[seal:gateway:telegram] Shared bot instance registered');
}

/**
 * Get the existing shared bot (if any).
 * @returns {TelegramBot|null}
 */
export function getExistingBot() {
  return sharedBot;
}

/**
 * Get the shared bot or create a new one.
 * If a bot already exists, returns it. Otherwise creates one in polling mode.
 *
 * @param {object} [config] - { token } or reads from ingest.json / env / .secrets
 * @returns {TelegramBot}
 */
export function getOrCreateBot(config = {}) {
  if (sharedBot) return sharedBot;

  const token = config.token
    || resolveSecret(null, 'SEAL_TELEGRAM_TOKEN', 'telegram_token');

  if (!token) {
    throw new Error('No Telegram token available. Set via config, SEAL_TELEGRAM_TOKEN, or .secrets file.');
  }

  sharedBot = new TelegramBot(token, { polling: true });
  console.log('[seal:gateway:telegram] Created new bot instance (polling)');
  return sharedBot;
}

/**
 * Destroy the shared bot (stop polling).
 */
export async function destroySharedBot() {
  if (sharedBot) {
    try {
      await sharedBot.stopPolling();
    } catch {
      // Already stopped or never started
    }
    sharedBot = null;
  }
}
