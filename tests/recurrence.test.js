import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInterval, computeNextRun } from '../src/recurrence.js';

test('parseInterval: days', () => {
  assert.equal(parseInterval('every:45d'), 45 * 86_400_000);
  assert.equal(parseInterval('every:1d'), 86_400_000);
});

test('parseInterval: weeks, hours, minutes', () => {
  assert.equal(parseInterval('every:2w'), 14 * 86_400_000);
  assert.equal(parseInterval('every:12h'), 12 * 3_600_000);
  assert.equal(parseInterval('every:90m'), 90 * 60_000);
});

test('parseInterval: tolerant of whitespace and case', () => {
  assert.equal(parseInterval('every: 45 D'), 45 * 86_400_000);
  assert.equal(parseInterval('  every:7d  '), 7 * 86_400_000);
});

test('parseInterval: returns null for cron and garbage', () => {
  assert.equal(parseInterval('0 9 * * 1'), null);
  assert.equal(parseInterval('every:0d'), null);
  assert.equal(parseInterval('every:5y'), null);
  assert.equal(parseInterval('weekly'), null);
  assert.equal(parseInterval(''), null);
  assert.equal(parseInterval(null), null);
  assert.equal(parseInterval(undefined), null);
});

test('computeNextRun: interval advances from the given anchor, not from now', () => {
  const from = new Date('2026-06-17T10:00:00.000Z');
  const next = computeNextRun('every:45d', from);
  // 17 Jun + 45d: 13 days left in June + 31 in July → 1 Aug.
  assert.equal(next, new Date('2026-08-01T10:00:00.000Z').toISOString());
});

test('computeNextRun: 30-day interval', () => {
  const from = new Date('2026-06-01T09:00:00.000Z');
  const next = computeNextRun('every:30d', from);
  assert.equal(next, new Date('2026-07-01T09:00:00.000Z').toISOString());
});

test('computeNextRun: still parses cron (the legacy path)', () => {
  // A cron that fires every minute — next run must be strictly in the future.
  const next = computeNextRun('* * * * *', new Date());
  assert.ok(new Date(next).getTime() > Date.now() - 1000);
});

test('computeNextRun: throws on un-parseable recurrence', () => {
  assert.throws(() => computeNextRun('not a cron and not an interval', new Date()));
});
