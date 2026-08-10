// Date/string helpers ported verbatim from the original app.js so behavior
// (relative times, durations, path shortening) stays identical.

export function relativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = date - now;
  const absDiff = Math.abs(diff);
  const mins = Math.floor(absDiff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (absDiff < 60000) return 'just now';
  if (mins < 60) return diff > 0 ? `in ${mins}m` : `${mins}m ago`;
  if (hours < 24) return diff > 0 ? `in ${hours}h` : `${hours}h ago`;
  if (days < 30) return diff > 0 ? `in ${days}d` : `${days}d ago`;
  return date.toLocaleDateString();
}

// SEAL-flavored relative time used by patterns/proposals/skills/nudges:
// always "ago", em-dash for empty.
export function fmtRelative(iso) {
  if (!iso) return '—';
  const now = Date.now();
  const then = Date.parse(iso);
  const diff = Math.max(0, now - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatDuration(start, end) {
  if (!start || !end) return '';
  const ms = new Date(end) - new Date(start);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function shortPath(path) {
  if (!path) return '';
  const parts = path.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : path;
}

// Cron weekday matcher, ported from app.js (used by the calendar view).
function matchField(field, value) {
  if (field === '*') return true;
  for (const seg of field.split(',')) {
    if (seg.includes('-')) {
      const [start, end] = seg.split('-').map(Number);
      if (value >= start && value <= end) return true;
    } else if (parseInt(seg, 10) === value) {
      return true;
    }
  }
  return false;
}

// Does this 5-field cron fire on the given Date? Honors BOTH day-of-month
// (field 3) and day-of-week (field 5). Standard cron ORs the two day fields
// when both are restricted; if one is '*', only the other constrains the day.
// (The original only looked at day-of-week, so "0 9 22 * *" — fire on the
// 22nd — matched EVERY day because its DOW field is '*'. That's the Jun-22 bug.)
export function matchesCronDate(cron, date) {
  const parts = (cron || '').trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [, , dom, , dow] = parts;
  const domMatch = matchField(dom, date.getDate());
  const dowMatch = matchField(dow, date.getDay());
  if (dom !== '*' && dow !== '*') return domMatch || dowMatch; // cron OR semantics
  return domMatch && dowMatch;
}

// Back-compat shim: old call sites pass a day-of-week number.
export function matchesCronDay(cron, dayOfWeek) {
  const parts = (cron || '').trim().split(/\s+/);
  if (parts.length < 5) return false;
  return matchField(parts[4], dayOfWeek);
}

// Reads the HH:MM that a 5-field cron expression fires at, when both the
// minute and hour fields are single numbers. Returns null for wildcards/lists
// (we then treat the occurrence as "all-day" on the agenda).
export function cronTimeOfDay(cron) {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [min, hour] = parts;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return null;
  const h = Number(hour); const m = Number(min);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Maps a SEAL task type / nudge to its category slug — the key the whole UI
// uses to pick a color (see --cat-* tokens in styles.css). Keep this the single
// source of truth so badges, agenda dots, and card rails always agree.
export function categoryOf(type) {
  switch (type) {
    case 'person':
    case 'decision':
    case '1:1': return 'person';
    case 'reminder':
    case 'nudge': return 'nudge';
    case 'ritual': return 'ritual';
    case 'proposal': return 'proposal';
    case 'deadline': return 'deadline';
    case 'skill': return 'skill';
    default: return 'task';
  }
}

// CSS var() reference for a category color — used inline so a row can set its
// own --cat without a class per category.
export function categoryColor(type) {
  return `var(--cat-${categoryOf(type)})`;
}

// Expands a task's next occurrences over the next `horizonDays` days. Uses
// next_run / execute_at as concrete dates, and expands `recurrence` (cron)
// across each day in the window via matchesCronDay, attaching cronTimeOfDay
// when the cron pins an hour. Returns [{ date: Date (midnight), time: 'HH:MM'|null }].
export function expandOccurrences(task, horizonDays = 30) {
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const seen = new Set();
  const push = (date, time) => {
    const key = `${date.getTime()}|${time || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ date, time: time || null });
  };

  // Concrete one-off dates.
  for (const iso of [task.next_run, task.execute_at]) {
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const within = (day - today) / 86400000;
    if (within < 0 || within > horizonDays) continue;
    const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
    push(day, hasTime ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null);
  }

  // Recurring cron expansion across the window. Anchored on next_run: the
  // runner owns next_run as the source of truth for WHEN this recurrence fires
  // next, so we never surface a cron date BEFORE it (that produced phantom
  // "today" occurrences like the Jun-22 bug). Falls back to `today` if next_run
  // is missing/past. Matches both day-of-month and day-of-week (matchesCronDate).
  if (task.recurrence) {
    const time = cronTimeOfDay(task.recurrence);
    const nr = task.next_run ? new Date(task.next_run) : null;
    const floor = nr && !Number.isNaN(nr.getTime()) && nr > today ? nr : today;
    const floorDay = new Date(floor); floorDay.setHours(0, 0, 0, 0);
    for (let i = 0; i <= horizonDays; i++) {
      const day = new Date(floorDay);
      day.setDate(day.getDate() + i);
      if (matchesCronDate(task.recurrence, day)) push(day, time);
    }
  }
  return out;
}
