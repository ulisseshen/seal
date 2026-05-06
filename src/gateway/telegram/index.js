import { BaseGatewayPlugin } from '../base.js';
import { getOrCreateBot, getExistingBot, destroySharedBot } from './bot.js';
import { setupCallbackHandlers } from './handlers.js';

const LEVEL_EMOJI = {
  info: '📋',
  warning: '⚠️',
  urgent: '🔴',
  critical: '🚨',
};

// Default confirmation timeout: 24 hours
const DEFAULT_CONFIRM_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Telegram gateway plugin for outbound notifications and confirmations.
 *
 * Shares the bot instance with src/telegram.js (ingestion) when both are active.
 * Uses HTML parse mode for rich formatting.
 */
export class TelegramGateway extends BaseGatewayPlugin {
  constructor() {
    super('telegram');
    this.capabilities = ['send', 'confirm', 'button', 'reply', 'receive'];

    /** @type {import('node-telegram-bot-api')|null} */
    this.bot = null;

    /** Default chat ID from config */
    this.defaultChatId = null;

    /** Pending confirmations: actionId → { resolve, reject, timeout } */
    this.pendingConfirmations = new Map();

    /** Incoming message handlers */
    this.incomingHandlers = [];

    /** Generic callback handlers */
    this.callbackHandlers = [];

    this._handlersSetUp = false;
  }

  /**
   * Initialize the Telegram gateway.
   * @param {object} config - { token?, chatId }
   */
  async init(config) {
    this.defaultChatId = config.chatId || null;

    try {
      // Try to reuse existing bot (created by telegram.js ingestion)
      this.bot = getExistingBot() || getOrCreateBot(config);
    } catch (err) {
      console.error('[seal:gateway:telegram] Failed to create bot:', err.message);
      throw err;
    }

    // Set up callback handlers only once per bot
    if (!this._handlersSetUp) {
      setupCallbackHandlers(this.bot, this);
      this._setupIncomingMessages();
      // Attach error handlers — without these, polling errors crash the Node process.
      this.bot.on('polling_error', (err) => {
        console.warn('[seal:gateway:telegram] polling_error:', err?.code || err?.message || err);
      });
      this.bot.on('error', (err) => {
        console.warn('[seal:gateway:telegram] error:', err?.code || err?.message || err);
      });
      this._handlersSetUp = true;
    }

    console.log(`[seal:gateway:telegram] Initialized (chatId: ${this.defaultChatId || 'not set'})`);
  }

  /**
   * Send a notification message.
   * @param {string|number|null} target - Chat ID (falls back to default)
   * @param {import('../base.js').GatewayMessage} message
   */
  async send(target, message) {
    const chatId = target || this.defaultChatId;

    if (!chatId) {
      console.error('[seal:gateway:telegram] No chatId — cannot send');
      return { delivered: false };
    }

    if (!this.bot) {
      console.error('[seal:gateway:telegram] Bot not initialized');
      return { delivered: false };
    }

    const emoji = LEVEL_EMOJI[message.level] || '📋';
    const text = this._formatMessage(emoji, message);
    const opts = { parse_mode: 'HTML' };

    // Add inline keyboard if actions are present
    if (message.actions && message.actions.length > 0) {
      opts.reply_markup = {
        inline_keyboard: this._buildKeyboard(message.actions),
      };
    }

    try {
      const sent = await this.bot.sendMessage(chatId, text, opts);
      return { delivered: true, messageId: sent.message_id };
    } catch (err) {
      console.error('[seal:gateway:telegram] Send failed:', err.message);

      // Retry without HTML parse mode in case of formatting issues
      if (err.message.includes('parse')) {
        try {
          delete opts.parse_mode;
          const plainText = `${emoji} [${message.level?.toUpperCase()}]\n\n${message.text}`;
          const sent = await this.bot.sendMessage(chatId, plainText, opts);
          return { delivered: true, messageId: sent.message_id };
        } catch (retryErr) {
          console.error('[seal:gateway:telegram] Retry failed:', retryErr.message);
        }
      }

      return { delivered: false };
    }
  }

  /**
   * Send a confirmation request and wait for user response.
   * @param {string|number|null} target
   * @param {import('../base.js').ActionConfirmation} action
   * @returns {Promise<import('../base.js').ConfirmationResult>}
   */
  async confirm(target, action) {
    const chatId = target || this.defaultChatId;

    if (!chatId || !this.bot) {
      throw new Error('Telegram gateway not ready for confirmations');
    }

    // Build inline keyboard from action options
    const buttons = action.options.map((opt) => ({
      label: opt.label,
      callbackData: `action:${action.actionId}:${opt.callbackData}`,
    }));

    const text = `🔐 <b>Confirmation Required</b>\n\n${escapeHtml(action.description)}`;

    const opts = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: this._buildKeyboard(buttons),
      },
    };

    // Send the confirmation message
    await this.bot.sendMessage(chatId, text, opts);

    // Return a promise that resolves when the user clicks a button
    return new Promise((resolve, reject) => {
      const timeoutMs = action.expiresAt
        ? Math.max(0, new Date(action.expiresAt).getTime() - Date.now())
        : DEFAULT_CONFIRM_TIMEOUT_MS;

      const timeout = setTimeout(() => {
        this.pendingConfirmations.delete(action.actionId);
        reject(new Error(`Confirmation "${action.actionId}" timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingConfirmations.set(action.actionId, { resolve, reject, timeout });
    });
  }

  /**
   * Register a handler for incoming text messages.
   * @param {function} handler
   */
  onMessage(handler) {
    this.incomingHandlers.push(handler);
  }

  /**
   * Health check — verify bot can reach Telegram API.
   */
  async healthy() {
    if (!this.bot) return { ok: false, detail: 'bot not initialized' };

    try {
      const me = await this.bot.getMe();
      return { ok: true, detail: `@${me.username}` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }

  /**
   * Graceful shutdown.
   */
  async destroy() {
    // Clear all pending confirmations
    for (const [id, pending] of this.pendingConfirmations) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Gateway shutting down'));
    }
    this.pendingConfirmations.clear();
    this.incomingHandlers = [];
    this.callbackHandlers = [];
    this._handlersSetUp = false;
    this.bot = null;

    // Don't destroy the shared bot here — it may be used by ingestion
    console.log('[seal:gateway:telegram] Destroyed');
  }

  // --- Internal methods ---

  /**
   * Resolve a pending confirmation (called by handlers.js).
   * @param {string} actionId
   * @param {import('../base.js').ConfirmationResult} result
   */
  _resolveConfirmation(actionId, result) {
    const pending = this.pendingConfirmations.get(actionId);
    if (!pending) {
      console.log(`[seal:gateway:telegram] No pending confirmation for ${actionId}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingConfirmations.delete(actionId);
    pending.resolve(result);
  }

  /**
   * Emit a generic callback event (called by handlers.js).
   */
  _emitCallback(event) {
    for (const handler of this.callbackHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error('[seal:gateway:telegram] Callback handler error:', err.message);
      }
    }
  }

  /**
   * Register a callback handler for non-confirmation button presses.
   */
  onCallback(handler) {
    this.callbackHandlers.push(handler);
  }

  /**
   * Set up forwarding of incoming text messages to registered handlers.
   * Filters out callback queries and commands — only plain text from users.
   */
  _setupIncomingMessages() {
    this.bot.on('message', (msg) => {
      // Only forward plain text (not commands, not from bots)
      if (!msg.text || msg.text.startsWith('/') || msg.from?.is_bot) return;

      // Don't forward if it looks like a reply to a confirmation
      // (the ingestion module handles task messages)
      // Only forward if we have handlers registered
      if (this.incomingHandlers.length === 0) return;

      const parsed = {
        text: msg.text,
        from: msg.from?.username || msg.from?.first_name || String(msg.from?.id),
        fromId: String(msg.from?.id),
        chatId: msg.chat.id,
        channel: 'telegram',
        raw: msg,
      };

      for (const handler of this.incomingHandlers) {
        try {
          handler(parsed);
        } catch (err) {
          console.error('[seal:gateway:telegram] Message handler error:', err.message);
        }
      }
    });
  }

  /**
   * Format a GatewayMessage into HTML for Telegram.
   */
  _formatMessage(emoji, message) {
    const level = (message.level || 'info').toUpperCase();
    const header = `${emoji} <b>${level}</b>`;
    const body = escapeHtml(message.text);

    let text = `${header}\n\n${body}`;

    if (message.category) {
      text += `\n\n<i>${escapeHtml(message.category)}</i>`;
    }

    return text;
  }

  /**
   * Build an inline keyboard from GatewayButton[].
   * Groups buttons into rows of 2.
   */
  _buildKeyboard(actions) {
    const rows = [];
    for (let i = 0; i < actions.length; i += 2) {
      const row = actions.slice(i, i + 2).map((btn) => ({
        text: btn.label,
        callback_data: btn.callbackData,
      }));
      rows.push(row);
    }
    return rows;
  }
}

/**
 * Escape special HTML characters for Telegram HTML parse mode.
 */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
