/**
 * ConfigWatcher — monitors config files and triggers callbacks on change.
 *
 * Uses fs.watch with debounce to avoid multiple triggers when editors
 * do tmp-file-then-rename saves. Gracefully handles watch errors.
 */
import fs from 'fs';

export class ConfigWatcher {
  constructor() {
    /** @type {Map<string, fs.FSWatcher>} */
    this.watchers = new Map();
    /** @type {Map<string, function>} */
    this.handlers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this.debounceTimers = new Map();
  }

  /**
   * Watch a config file and call handler when it changes.
   * @param {string} filePath - Absolute path to config file
   * @param {function} handler - Callback invoked with (filePath) on change
   * @param {number} [debounceMs=1000] - Debounce window in milliseconds
   */
  watch(filePath, handler, debounceMs = 1000) {
    // Don't double-watch
    if (this.watchers.has(filePath)) {
      this.unwatch(filePath);
    }

    if (!fs.existsSync(filePath)) {
      console.log(`[seal:config] File does not exist, skipping watch: ${filePath}`);
      return;
    }

    this.handlers.set(filePath, handler);

    try {
      const watcher = fs.watch(filePath, (eventType) => {
        // Clear any pending debounce timer
        const existing = this.debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);

        // Set new debounce timer
        const timer = setTimeout(() => {
          this.debounceTimers.delete(filePath);
          console.log(`[seal:config] Change detected: ${filePath} (${eventType})`);
          const fn = this.handlers.get(filePath);
          if (fn) {
            try {
              fn(filePath);
            } catch (err) {
              console.error(`[seal:config] Handler error for ${filePath}:`, err.message);
            }
          }
        }, debounceMs);

        this.debounceTimers.set(filePath, timer);
      });

      watcher.on('error', (err) => {
        console.error(`[seal:config] Watch error on ${filePath}:`, err.message);
      });

      this.watchers.set(filePath, watcher);
      console.log(`[seal:config] Watching ${filePath}`);
    } catch (err) {
      console.error(`[seal:config] Failed to watch ${filePath}:`, err.message);
    }
  }

  /**
   * Stop watching a specific file.
   * @param {string} filePath
   */
  unwatch(filePath) {
    const watcher = this.watchers.get(filePath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(filePath);
    }
    this.handlers.delete(filePath);
    const timer = this.debounceTimers.get(filePath);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(filePath);
    }
  }

  /**
   * Stop all watchers and clear state.
   */
  destroy() {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.handlers.clear();

    console.log('[seal:config] All watchers destroyed');
  }
}
