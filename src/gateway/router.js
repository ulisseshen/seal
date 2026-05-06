import fs from 'fs';
import path from 'path';
import os from 'os';

const GATEWAY_CONFIG_PATH = path.join(os.homedir(), '.config', 'seal', 'gateway.json');

const DEFAULT_CONFIG = {
  default: 'telegram',
  channels: {
    telegram: { chatId: '' },
  },
  rules: [
    { category: 'briefing', channel: 'telegram' },
    { category: 'action-confirm', channel: 'telegram' },
    { level: 'critical', channel: 'telegram' },
  ],
};

/**
 * Routes notifications and confirmations to the right gateway plugin
 * based on message level, category, and routing rules.
 */
export class GatewayRouter {
  constructor() {
    /** @type {Map<string, import('./base.js').BaseGatewayPlugin>} */
    this.plugins = new Map();
    this.defaultChannel = null;
    this.rules = [];
    this.messageHandlers = [];
  }

  /**
   * Register a gateway plugin.
   * @param {import('./base.js').BaseGatewayPlugin} plugin
   */
  register(plugin) {
    this.plugins.set(plugin.name, plugin);
    console.log(`[seal:gateway] Registered plugin: ${plugin.name} (${plugin.capabilities.join(', ')})`);
  }

  /**
   * Load config and initialize all registered plugins.
   * Config is read from ~/.config/seal/gateway.json, merged with defaults.
   */
  async init(config = null) {
    const cfg = config || this._loadConfig();

    this.defaultChannel = cfg.default || 'telegram';
    this.rules = cfg.rules || [];

    // Initialize each registered plugin whose channel config exists
    for (const [name, plugin] of this.plugins) {
      const channelConfig = cfg.channels?.[name];
      if (!channelConfig) {
        console.log(`[seal:gateway] No config for plugin "${name}", skipping init`);
        continue;
      }

      try {
        await plugin.init(channelConfig);
        console.log(`[seal:gateway] Plugin "${name}" initialized`);
      } catch (err) {
        console.error(`[seal:gateway] Failed to init plugin "${name}":`, err.message);
      }
    }

    // Wire up message handlers to all plugins that support 'receive'
    for (const [, plugin] of this.plugins) {
      if (plugin.capabilities.includes('receive')) {
        try {
          plugin.onMessage((msg) => {
            for (const handler of this.messageHandlers) {
              handler(msg);
            }
          });
        } catch {
          // Plugin may not support onMessage yet
        }
      }
    }

    console.log(`[seal:gateway] Router ready (default: ${this.defaultChannel}, ${this.plugins.size} plugin(s))`);
  }

  /**
   * Route a message to the appropriate plugin based on rules.
   * @param {import('./base.js').GatewayMessage} message
   * @param {string|number} [target] - Override target (chatId, etc.)
   * @returns {Promise<{delivered: boolean, channel: string, messageId?: number|string}>}
   */
  async send(message, target) {
    const channelName = this._resolveChannel(message);
    const plugin = this.plugins.get(channelName);

    if (!plugin) {
      console.error(`[seal:gateway] No plugin for channel "${channelName}"`);
      return { delivered: false, channel: channelName };
    }

    if (!plugin.capabilities.includes('send')) {
      console.error(`[seal:gateway] Plugin "${channelName}" does not support send`);
      return { delivered: false, channel: channelName };
    }

    try {
      const result = await plugin.send(target || null, message);
      return { ...result, channel: channelName };
    } catch (err) {
      console.error(`[seal:gateway] Send failed on "${channelName}":`, err.message);
      return { delivered: false, channel: channelName };
    }
  }

  /**
   * Route a confirmation request. Always goes to the default channel
   * because confirmations are interactive.
   * @param {import('./base.js').ActionConfirmation} action
   * @param {string|number} [target]
   * @returns {Promise<import('./base.js').ConfirmationResult>}
   */
  async confirm(action, target) {
    const channelName = this.defaultChannel;
    const plugin = this.plugins.get(channelName);

    if (!plugin) {
      throw new Error(`[seal:gateway] No plugin for default channel "${channelName}"`);
    }

    if (!plugin.capabilities.includes('confirm')) {
      throw new Error(`[seal:gateway] Plugin "${channelName}" does not support confirm`);
    }

    return plugin.confirm(target || null, action);
  }

  /**
   * Register an incoming message handler across all plugins.
   * @param {function} handler
   */
  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  /**
   * Health check across all plugins.
   * @returns {Promise<{ok: boolean, plugins: object}>}
   */
  async healthy() {
    const results = {};
    let allOk = true;

    for (const [name, plugin] of this.plugins) {
      try {
        const h = await plugin.healthy();
        results[name] = h;
        if (!h.ok) allOk = false;
      } catch (err) {
        results[name] = { ok: false, detail: err.message };
        allOk = false;
      }
    }

    return { ok: allOk, plugins: results };
  }

  /**
   * Graceful shutdown of all plugins.
   */
  async destroy() {
    for (const [name, plugin] of this.plugins) {
      try {
        await plugin.destroy();
        console.log(`[seal:gateway] Plugin "${name}" destroyed`);
      } catch (err) {
        console.error(`[seal:gateway] Error destroying "${name}":`, err.message);
      }
    }
    this.plugins.clear();
  }

  /**
   * Resolve which channel to use based on routing rules.
   * Rules are evaluated in order; first match wins.
   */
  _resolveChannel(message) {
    for (const rule of this.rules) {
      if (rule.category && message.category === rule.category) {
        return rule.channel;
      }
      if (rule.level && message.level === rule.level) {
        return rule.channel;
      }
    }
    return this.defaultChannel;
  }

  /**
   * Load gateway config from disk, falling back to defaults.
   */
  _loadConfig() {
    try {
      if (fs.existsSync(GATEWAY_CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(GATEWAY_CONFIG_PATH, 'utf-8'));
        return { ...DEFAULT_CONFIG, ...raw };
      }
    } catch (err) {
      console.error(`[seal:gateway] Failed to load config:`, err.message);
    }
    return DEFAULT_CONFIG;
  }

  /**
   * Write default config to disk if it doesn't exist.
   */
  static ensureConfig() {
    if (!fs.existsSync(GATEWAY_CONFIG_PATH)) {
      const dir = path.dirname(GATEWAY_CONFIG_PATH);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(GATEWAY_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      console.log(`[seal:gateway] Created default config at ${GATEWAY_CONFIG_PATH}`);
    }
  }
}
