/**
 * Base class for gateway plugins.
 *
 * Gateway plugins handle outbound notifications (send) and interactive
 * confirmations (confirm) via external channels (Telegram, Slack, etc.).
 *
 * Every plugin declares its capabilities so the router knows what it can do.
 */
export class BaseGatewayPlugin {
  constructor(name) {
    this.name = name;
    /** @type {('send'|'confirm'|'button'|'reply'|'receive')[]} */
    this.capabilities = [];
  }

  /**
   * Initialize the plugin with channel-specific config.
   * @param {object} config
   */
  async init(config) {
    throw new Error('not implemented');
  }

  /**
   * Send a notification message.
   * @param {string|number} target - Channel/chat identifier (plugin-specific)
   * @param {GatewayMessage} message
   * @returns {Promise<{delivered: boolean, messageId?: number|string}>}
   */
  async send(target, message) {
    throw new Error('not implemented');
  }

  /**
   * Send a confirmation request and wait for user response.
   * @param {string|number} target
   * @param {ActionConfirmation} action
   * @returns {Promise<ConfirmationResult>}
   */
  async confirm(target, action) {
    throw new Error('not implemented');
  }

  /**
   * Register a handler for incoming messages from the channel.
   * @param {function} handler - (msg: {text, from, channel}) => void
   */
  onMessage(handler) {
    throw new Error('not implemented');
  }

  /**
   * Health check.
   * @returns {Promise<{ok: boolean, detail?: string}>}
   */
  async healthy() {
    return { ok: false };
  }

  /**
   * Graceful shutdown.
   */
  async destroy() {}
}

/**
 * @typedef {object} GatewayMessage
 * @property {string} text - Plain text body
 * @property {string} [html] - HTML-formatted body (optional, plugin may ignore)
 * @property {'info'|'warning'|'urgent'|'critical'} level
 * @property {string} [category] - Routing category (e.g. 'briefing', 'action-confirm')
 * @property {GatewayButton[]} [actions] - Inline action buttons
 */

/**
 * @typedef {object} GatewayButton
 * @property {string} label - Button text shown to user
 * @property {string} callbackData - Data sent back when button is pressed
 */

/**
 * @typedef {object} ActionConfirmation
 * @property {string} actionId - Unique ID for this confirmation request
 * @property {string} description - What the user is confirming
 * @property {GatewayButton[]} options - Buttons to present
 * @property {Date} [expiresAt] - When the confirmation times out
 */

/**
 * @typedef {object} ConfirmationResult
 * @property {string} actionId
 * @property {string} choice - The callbackData of the chosen button
 * @property {string} confirmedBy - Who confirmed (username/id)
 * @property {string} confirmedAt - ISO timestamp
 */
