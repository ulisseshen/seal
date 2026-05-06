/**
 * SubsystemManager — lifecycle management for all SEAL subsystems.
 *
 * Each subsystem registers with start/stop functions and the config file
 * that triggers its restart. Provides graceful restart with error isolation.
 */
export class SubsystemManager {
  constructor() {
    /** @type {Map<string, { start: function, stop: function, configFile: string|null, status: string }>} */
    this.subsystems = new Map();
    /** @type {Array<{ type: string, name?: string, filePath?: string }>} */
    this._queue = [];
    this._processing = false;
  }

  /**
   * Register a subsystem with its lifecycle functions.
   * @param {string} name - Subsystem identifier
   * @param {object} opts
   * @param {function} opts.start - async () => void
   * @param {function} opts.stop - async () => void
   * @param {string|null} [opts.configFile] - Config file path that triggers restart
   */
  register(name, { start, stop, configFile = null }) {
    this.subsystems.set(name, { start, stop, configFile, status: 'registered' });
    console.log(`[seal:subsystem] Registered: ${name}${configFile ? ` (watches: ${configFile})` : ''}`);
  }

  /**
   * Enqueue a restart for a specific subsystem. Processed serially.
   * @param {string} name
   */
  async restart(name) {
    if (!this.subsystems.has(name)) {
      console.warn(`[seal:subsystem] Unknown subsystem: ${name}`);
      return;
    }
    this._enqueue({ type: 'restart', name });
  }

  /**
   * Enqueue restarts for all subsystems linked to a config file.
   * @param {string} filePath
   */
  async restartForConfig(filePath) {
    this._enqueue({ type: 'config', filePath });
  }

  /** @private */
  _enqueue(job) {
    // Deduplicate: if same job already queued, skip
    const isDupe = this._queue.some(q =>
      q.type === job.type && q.name === job.name && q.filePath === job.filePath
    );
    if (isDupe) {
      console.log(`[seal:subsystem] Already queued, skipping: ${JSON.stringify(job)}`);
      return;
    }
    this._queue.push(job);
    this._drain();
  }

  /** @private — process queue one at a time */
  async _drain() {
    if (this._processing) return;
    this._processing = true;

    while (this._queue.length > 0) {
      const job = this._queue.shift();
      try {
        if (job.type === 'restart') {
          await this._doRestart(job.name);
        } else if (job.type === 'config') {
          await this._doRestartForConfig(job.filePath);
        }
      } catch (err) {
        console.error(`[seal:subsystem] Queue job failed:`, err.message);
      }
    }

    this._processing = false;
  }

  /** @private */
  async _doRestart(name) {
    const sub = this.subsystems.get(name);
    if (!sub) return;

    console.log(`[seal:subsystem] Restarting: ${name}`);
    sub.status = 'restarting';

    try {
      await sub.stop();
    } catch (err) {
      console.error(`[seal:subsystem] Error stopping ${name}:`, err.message);
    }

    try {
      await sub.start();
      sub.status = 'running';
      console.log(`[seal:subsystem] Restarted: ${name}`);
    } catch (err) {
      sub.status = 'error';
      console.error(`[seal:subsystem] Error starting ${name}:`, err.message);
    }
  }

  /** @private */
  async _doRestartForConfig(filePath) {
    const toRestart = [];
    for (const [name, sub] of this.subsystems) {
      if (sub.configFile === filePath) {
        toRestart.push(name);
      }
    }

    if (toRestart.length === 0) {
      console.log(`[seal:subsystem] No subsystems linked to ${filePath}`);
      return;
    }

    console.log(`[seal:subsystem] Config changed: ${filePath} -> restarting: ${toRestart.join(', ')}`);
    for (const name of toRestart) {
      await this._doRestart(name);
    }
  }

  /**
   * Stop all registered subsystems.
   */
  async destroyAll() {
    console.log(`[seal:subsystem] Destroying all subsystems...`);
    for (const [name, sub] of this.subsystems) {
      try {
        await sub.stop();
        sub.status = 'stopped';
        console.log(`[seal:subsystem] Stopped: ${name}`);
      } catch (err) {
        console.error(`[seal:subsystem] Error stopping ${name}:`, err.message);
      }
    }
  }

  /**
   * Get status of all subsystems.
   * @returns {object} Map of name to status info
   */
  status() {
    const result = {};
    for (const [name, sub] of this.subsystems) {
      result[name] = {
        status: sub.status,
        configFile: sub.configFile,
      };
    }
    return result;
  }
}
