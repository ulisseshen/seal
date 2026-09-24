const LIMIT_RE = /you(?:'|’)ve hit your\s+(session|weekly|opus|usage)?\s*limit[^\n]*?resets\s+([^\n(]+?)\s*(?:\(([^)]+)\))?\s*$/im;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DEFAULT_TZ = 'America/Sao_Paulo';
const FALLBACK_WAIT_MS = 60 * 60 * 1000;

export const USAGE_LIMIT_PREFIX = 'Usage limit:';
export const RESUME_GRACE_MS = 2 * 60 * 1000;

function partsIn(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  return Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
}

function wallClockToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month, day, hour, minute);
  const seen = partsIn(guess, timeZone);
  const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second) - guess;
  return guess - offset;
}

function resolveReset(text, timeZone, now) {
  const time = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text.replace(/\b[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*(?:at\s+)?/i, ''));
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2] || 0);
  const meridiem = (time[3] || '').toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  const today = partsIn(now.getTime(), timeZone);
  const dated = /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})/i.exec(text);
  const monthIndex = dated ? MONTHS.indexOf(dated[1].toLowerCase()) : -1;
  if (monthIndex >= 0) {
    let year = today.year;
    let at = wallClockToUtc(year, monthIndex, Number(dated[2]), hour, minute, timeZone);
    if (at < now.getTime() - 24 * 60 * 60 * 1000) at = wallClockToUtc(++year, monthIndex, Number(dated[2]), hour, minute, timeZone);
    return new Date(at);
  }
  let at = wallClockToUtc(today.year, today.month - 1, today.day, hour, minute, timeZone);
  if (at <= now.getTime()) at = wallClockToUtc(today.year, today.month - 1, today.day + 1, hour, minute, timeZone);
  return new Date(at);
}

export function parseUsageLimit(text, now = new Date()) {
  const match = LIMIT_RE.exec(String(text || ''));
  if (!match) return null;
  const kind = (match[1] || 'usage').toLowerCase();
  const resetText = match[2].trim();
  let timeZone = (match[3] || DEFAULT_TZ).trim();
  let resetAt = null;
  try {
    resetAt = resolveReset(resetText, timeZone, now);
  } catch {
    timeZone = DEFAULT_TZ;
    resetAt = resolveReset(resetText, timeZone, now);
  }
  return {
    kind,
    resetText,
    timeZone,
    resetAt: resetAt || new Date(now.getTime() + FALLBACK_WAIT_MS),
    estimated: !resetAt,
  };
}

export function resumeAt(limit, now = new Date()) {
  return new Date(Math.max(limit.resetAt.getTime() + RESUME_GRACE_MS, now.getTime()));
}

export function usageLimitResult(limit) {
  return `${USAGE_LIMIT_PREFIX} ${limit.kind} limit, resets ${limit.resetAt.toISOString()}`;
}

export function isUsageLimitResult(result) {
  return String(result || '').startsWith(USAGE_LIMIT_PREFIX);
}

const KIND_LABEL = { session: 'da sessão de 5h', weekly: 'semanal', opus: 'do Opus', usage: 'de uso' };

export function formatResetClock(limit) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: limit.timeZone, hour: '2-digit', minute: '2-digit' }).format(limit.resetAt);
}

export function usageLimitMessage(limit, taskSummary) {
  const when = formatResetClock(limit);
  const lines = [
    `⏰ <b>Seu limite ${KIND_LABEL[limit.kind] || 'de uso'} do Claude acabou</b>`,
    `A revisão automática pausa e retoma sozinha às ${when}.`,
  ];
  if (taskSummary) lines.push(`Parou em: ${taskSummary}`);
  return lines.join('\n');
}

let pausedUntil = 0;

export function markUsageLimit(limit) {
  const until = limit.resetAt.getTime();
  const isNewWindow = until > pausedUntil + RESUME_GRACE_MS;
  pausedUntil = Math.max(pausedUntil, until);
  return isNewWindow;
}

export function usagePausedUntil(now = Date.now()) {
  return pausedUntil > now ? new Date(pausedUntil) : null;
}

export function resetUsagePauseForTests() {
  pausedUntil = 0;
}
