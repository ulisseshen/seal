const DEFAULT_QUIET_HOURS = '0-6';
const TICK_MS = 15_000;
const SLEEP_GAP_MS = 60_000;

export function quietWindow(env = process.env) {
  const raw = String(env.SEAL_QUIET_HOURS ?? DEFAULT_QUIET_HOURS).trim().toLowerCase();
  if (!raw || raw === 'off') return null;
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > 23 || end > 24 || start === end) return null;
  return { start, end };
}

export function quietUntil(now = new Date(), window = quietWindow()) {
  if (!window) return null;
  const hour = now.getHours();
  const inside = window.start < window.end
    ? hour >= window.start && hour < window.end
    : hour >= window.start || hour < window.end;
  if (!inside) return null;
  const until = new Date(now);
  until.setHours(window.end, 0, 0, 0);
  if (until <= now) until.setDate(until.getDate() + 1);
  return until;
}

export function awakeTimer(limitMs, onExpire, { tickMs = TICK_MS, sleepGapMs = SLEEP_GAP_MS, now = Date.now } = {}) {
  const startedAt = now();
  let last = startedAt;
  let slept = 0;
  const awakeMs = () => now() - startedAt - slept;
  const id = setInterval(() => {
    const current = now();
    const gap = current - last - tickMs;
    if (gap > sleepGapMs) slept += gap;
    last = current;
    if (awakeMs() >= limitMs) {
      clearInterval(id);
      onExpire({ awakeMs: awakeMs(), sleptMs: slept });
    }
  }, tickMs);
  if (typeof id.unref === 'function') id.unref();
  return {
    stop: () => clearInterval(id),
    awakeMs,
    sleptMs: () => slept,
  };
}

export function createSleepTracker({ tickMs = TICK_MS, sleepGapMs = SLEEP_GAP_MS, now = Date.now } = {}) {
  let last = now();
  let wokeAt = null;
  const tick = () => {
    const current = now();
    if (current - last - tickMs > sleepGapMs) wokeAt = current;
    last = current;
  };
  return {
    tick,
    lastWakeAt: () => wokeAt,
    sleptWithin: (ms) => wokeAt !== null && now() - wokeAt < ms,
  };
}

let sharedTracker = null;

export function sleepTracker() {
  if (!sharedTracker) {
    sharedTracker = createSleepTracker();
    const id = setInterval(sharedTracker.tick, TICK_MS);
    if (typeof id.unref === 'function') id.unref();
  }
  return sharedTracker;
}
