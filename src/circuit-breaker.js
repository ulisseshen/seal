/**
 * Circuit breaker to stop calling a CLI tool that's failing repeatedly.
 *
 * After N failures, opens the circuit (refuses calls) for a cooldown
 * period. Then half-opens to test if it's recovered.
 *
 * Added in v0.4.0 after a launchd respawn loop caused 4452 failed
 * codex CLI calls to burn API credits in a single afternoon. Every
 * external CLI we shell out to (codex, claude, etc.) MUST be wrapped
 * with one of these. Logging prefix: [circuit-breaker:NAME].
 */

// Optional notifier — set via setBreakerNotifier() to avoid a hard
// dependency cycle (notify.js can pull this file too in the future).
let breakerNotifier = null;

export function setBreakerNotifier(fn) {
  breakerNotifier = typeof fn === 'function' ? fn : null;
}

class CircuitBreaker {
  constructor(name, opts = {}) {
    this.name = name;
    this.threshold = opts.threshold || 3;          // open after N consecutive failures
    this.cooldownMs = opts.cooldownMs || 30 * 60 * 1000;  // 30 min default
    this.failures = 0;
    this.openUntil = 0;
    this.lastNotifiedOpenUntil = 0;
  }

  canExecute() {
    if (Date.now() < this.openUntil) {
      return false; // circuit open
    }
    return true;
  }

  recordSuccess() {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure() {
    this.failures++;
    if (this.failures >= this.threshold) {
      const wasClosed = Date.now() >= this.openUntil;
      this.openUntil = Date.now() + this.cooldownMs;
      console.warn(`[circuit-breaker:${this.name}] OPEN after ${this.failures} failures — cooldown ${this.cooldownMs / 60000}min`);

      // Notify the user, but only once per "open episode" to avoid spam.
      if (wasClosed && breakerNotifier && this.lastNotifiedOpenUntil !== this.openUntil) {
        this.lastNotifiedOpenUntil = this.openUntil;
        try {
          breakerNotifier({
            name: this.name,
            failures: this.failures,
            threshold: this.threshold,
            cooldownMs: this.cooldownMs,
            openUntil: new Date(this.openUntil).toISOString(),
          });
        } catch (err) {
          console.warn(`[circuit-breaker:${this.name}] notifier failed:`, err.message);
        }
      }
    }
  }

  status() {
    const open = !this.canExecute();
    return {
      name: this.name,
      open,
      failures: this.failures,
      threshold: this.threshold,
      cooldownMs: this.cooldownMs,
      openUntil: open ? new Date(this.openUntil).toISOString() : null,
    };
  }
}

const breakers = new Map();

export function getBreaker(name, opts) {
  if (!breakers.has(name)) {
    breakers.set(name, new CircuitBreaker(name, opts));
  }
  return breakers.get(name);
}

export function listBreakers() {
  return [...breakers.values()].map((b) => b.status());
}
