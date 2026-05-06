/**
 * Source Plugin Registry — Discovery, lifecycle, and sync orchestration.
 *
 * Manages source plugins that feed the Knowledge Engine.
 * Config is read from ~/.config/seal/sources.json with the shape:
 *
 * {
 *   "teams": {
 *     "enabled": true,
 *     "dataDir": "/path/to/teamsbot/playwright_sender/data",
 *     "syncInterval": 1800000
 *   },
 *   "azure-devops": {
 *     "enabled": true,
 *     "org": "myorg",
 *     "project": "myproject"
 *   }
 * }
 */
export class SourceRegistry {
  constructor(engine) {
    this.engine = engine;
    this.plugins = new Map();
    this._syncTimers = new Map();
  }

  /**
   * Register a source plugin (does not initialize it yet).
   * @param {import('./base.js').BaseSourcePlugin} plugin
   */
  register(plugin) {
    if (this.plugins.has(plugin.name)) {
      console.log(`[seal:sources] Warning: plugin '${plugin.name}' already registered, replacing`);
    }
    this.plugins.set(plugin.name, { plugin, initialized: false, lastSync: null });
    console.log(`[seal:sources] Registered plugin: ${plugin.name}`);
  }

  /**
   * Initialize all registered plugins from config.
   * Only initializes plugins that are enabled in the config.
   * @param {object} config - Full sources config object keyed by plugin name
   */
  async init(config) {
    for (const [name, entry] of this.plugins) {
      const pluginConfig = config[name];
      if (!pluginConfig) {
        console.log(`[seal:sources] No config for '${name}', skipping`);
        continue;
      }
      if (pluginConfig.enabled === false) {
        console.log(`[seal:sources] Plugin '${name}' disabled in config, skipping`);
        continue;
      }

      try {
        await entry.plugin.init(pluginConfig, this.engine);
        entry.initialized = true;
        console.log(`[seal:sources] Initialized: ${name} (${entry.plugin.description})`);
      } catch (err) {
        console.error(`[seal:sources] Failed to initialize '${name}': ${err.message}`);
      }
    }
  }

  /**
   * Sync all initialized plugins.
   * @returns {Promise<object>} Summary of sync results keyed by plugin name
   */
  async syncAll() {
    const results = {};
    for (const [name, entry] of this.plugins) {
      if (!entry.initialized) continue;
      results[name] = await this._syncPlugin(name, entry);
    }
    return results;
  }

  /**
   * Sync a specific plugin by name.
   * @param {string} name - Plugin name
   * @param {string|null} since - ISO date to sync from (null = full sync)
   */
  async syncOne(name, since) {
    const entry = this.plugins.get(name);
    if (!entry) throw new Error(`Unknown source plugin: ${name}`);
    if (!entry.initialized) throw new Error(`Plugin '${name}' not initialized`);
    return this._syncPlugin(name, entry, since);
  }

  /**
   * Internal: run sync on a single plugin, ingest results into the engine.
   */
  async _syncPlugin(name, entry, since) {
    const start = Date.now();
    try {
      const items = await entry.plugin.sync(since || null);
      if (!items || items.length === 0) {
        console.log(`[seal:sources] ${name}: sync returned 0 items`);
        entry.lastSync = new Date().toISOString();
        return { ok: true, items: 0, ms: Date.now() - start };
      }

      console.log(`[seal:sources] ${name}: syncing ${items.length} items into engine`);
      const stats = await this.engine.ingest(items);
      entry.lastSync = new Date().toISOString();

      await this.engine.updateSyncState(name, entry.lastSync, items.length);

      return { ok: true, items: items.length, ...stats, ms: Date.now() - start };
    } catch (err) {
      console.error(`[seal:sources] ${name}: sync failed — ${err.message}`);
      return { ok: false, error: err.message, ms: Date.now() - start };
    }
  }

  /**
   * Start periodic sync for all initialized plugins.
   * Uses the syncInterval from each plugin's config (default: 30 min).
   * @param {object} config - Full sources config
   */
  startPeriodicSync(config) {
    for (const [name, entry] of this.plugins) {
      if (!entry.initialized) continue;
      const interval = config[name]?.syncInterval || 1_800_000; // default 30 min
      console.log(`[seal:sources] ${name}: periodic sync every ${interval / 60_000}min`);
      const timer = setInterval(() => {
        this._syncPlugin(name, entry).catch(err => {
          console.error(`[seal:sources] ${name}: periodic sync error — ${err.message}`);
        });
      }, interval);
      this._syncTimers.set(name, timer);
    }
  }

  /**
   * Get sync state for all plugins.
   * @returns {object} Map of plugin name to sync info
   */
  getSyncStates() {
    const states = {};
    for (const [name, entry] of this.plugins) {
      states[name] = {
        initialized: entry.initialized,
        lastSync: entry.lastSync,
        artifactTypes: entry.plugin.artifactTypes,
      };
    }
    return states;
  }

  /**
   * Health check all initialized plugins.
   */
  async healthy() {
    const results = {};
    for (const [name, entry] of this.plugins) {
      if (!entry.initialized) {
        results[name] = { ok: false, detail: 'not initialized' };
        continue;
      }
      try {
        results[name] = await entry.plugin.healthy();
      } catch (err) {
        results[name] = { ok: false, detail: err.message };
      }
    }
    return results;
  }

  /**
   * Destroy all plugins and clear periodic sync timers.
   */
  async destroy() {
    for (const timer of this._syncTimers.values()) {
      clearInterval(timer);
    }
    this._syncTimers.clear();

    for (const [name, entry] of this.plugins) {
      try {
        await entry.plugin.destroy();
      } catch (err) {
        console.error(`[seal:sources] ${name}: destroy error — ${err.message}`);
      }
    }
    this.plugins.clear();
  }
}
