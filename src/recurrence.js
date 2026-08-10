// Recurrence resolver — turns a task's `recurrence` field into the next run time.
//
// SEAL historically supported ONLY cron expressions (parsed by cron-parser).
// Cron cannot express "every N days" for N that isn't a clean divisor of a
// month (e.g. every 45 days), which is a real cadence for things like 1:1s.
//
// This module adds a second recurrence dialect — fixed intervals — while
// keeping cron as the default. The two are disambiguated by a prefix:
//
//   "every:45d"   → 45 days after the last run
//   "every:2w"    → 14 days
//   "every:12h"   → 12 hours
//   "every:90m"   → 90 minutes
//   "0 9 * * 1"   → cron (anything not starting with "every:")
//
// Interval recurrences advance from the moment the task actually ran (passed
// in as `fromDate`), NOT from a fixed calendar anchor — so a 45-day 1:1 that
// slips a few days simply restarts its 45-day clock from when it happened.

import { CronExpressionParser } from 'cron-parser';

const INTERVAL_UNITS = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse an "every:Nd"-style interval recurrence into milliseconds.
 * Returns null if the string is not an interval recurrence.
 */
export function parseInterval(recurrence) {
  if (typeof recurrence !== 'string') return null;
  const m = recurrence.trim().match(/^every:\s*(\d+)\s*([mhdw])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (!n || !INTERVAL_UNITS[unit]) return null;
  return n * INTERVAL_UNITS[unit];
}

/**
 * Compute the next run time for a recurrence, returned as an ISO string.
 *
 * @param {string} recurrence - cron expression OR "every:Nd"/"every:Nw"/etc.
 * @param {Date} [fromDate] - anchor for interval recurrences (defaults to now).
 *                            Ignored for cron (cron-parser uses its own clock).
 * @param {string} [tz] - timezone for cron parsing (defaults to local).
 * @returns {string} ISO datetime of the next run.
 * @throws if the recurrence cannot be parsed by either dialect.
 */
export function computeNextRun(recurrence, fromDate = new Date(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const intervalMs = parseInterval(recurrence);
  if (intervalMs != null) {
    return new Date(fromDate.getTime() + intervalMs).toISOString();
  }
  // Fall back to cron. Throws if invalid — caller logs and skips, same as before.
  const interval = CronExpressionParser.parse(recurrence, { tz });
  return interval.next().toDate().toISOString();
}
