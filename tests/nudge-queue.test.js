// Tests for getPendingNudges / markNudged — the queue that surfaces
// type=person notes with a due follow-up so SEAL can cobra them.
//
// Regression context: getPendingReminders only matches type='reminder', so
// person notes with a follow-up date were NEVER dispatched. getPendingNudges
// fixes that, with a retry cap and a spacing interval for insistence.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DB = path.join(os.tmpdir(), `seal-nudge-test-${process.pid}-${Date.now()}.db`);
process.env.SEAL_DB_PATH = TMP_DB;

const db = await import('../src/db.js');
const { insertTask, getPendingNudges, markNudged } = db;

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
});

function personNote(id, overrides = {}) {
  return {
    id,
    type: 'person',
    summary: `note ${id}`,
    detail: 'OBSERVED: x',
    execute_at: '2020-01-01T00:00:00.000Z', // due in the past
    recurrence: null,
    next_run: '2020-01-01T00:00:00.000Z',
    prompt: null,
    project: null,
    allowed_tools: '[]',
    permission_mode: 'auto',
    capabilities: '[]',
    notify_type: 'sound',
    notify_channel: 'system',
    notify_target: null,
    people: '["Ana"]',
    priority: 'medium',
    status: 'pending',
    created: new Date().toISOString(),
    max_runs: null,
    ...overrides,
  };
}

test('getPendingNudges: picks a due pending person note', async () => {
  await insertTask(personNote('n1'));
  const nudges = await getPendingNudges();
  assert.ok(nudges.some((n) => n.id === 'n1'));
});

test('getPendingNudges: ignores notes with no follow-up date (log-only)', async () => {
  await insertTask(personNote('n2', { execute_at: null, next_run: null, status: 'done' }));
  const nudges = await getPendingNudges();
  assert.ok(!nudges.some((n) => n.id === 'n2'));
});

test('getPendingNudges: ignores future follow-ups', async () => {
  await insertTask(personNote('n3', { execute_at: '2099-01-01T00:00:00.000Z' }));
  const nudges = await getPendingNudges();
  assert.ok(!nudges.some((n) => n.id === 'n3'));
});

test('markNudged: bumps retry_count, moves to firing, stamps last_notified_at', async () => {
  await insertTask(personNote('n4'));
  await markNudged('n4');
  const row = await db.getTaskById('n4');
  assert.equal(row.status, 'firing');
  assert.equal(row.retry_count, 1);
  assert.ok(row.last_notified_at);
});

test('getPendingNudges: stops nagging after the retry cap (3)', async () => {
  await insertTask(personNote('n5'));
  // Fire 3 times. last_notified_at would normally throttle, but the cap is the
  // hard stop — simulate by clearing last_notified_at between fires.
  for (let i = 0; i < 3; i++) {
    await markNudged('n5');
    await db.db.run(`UPDATE tasks SET last_notified_at = NULL WHERE id = 'n5'`);
  }
  const nudges = await getPendingNudges();
  assert.ok(!nudges.some((n) => n.id === 'n5'), 'note at retry cap must not re-fire');
});

test('getPendingNudges: respects the 2-day spacing interval', async () => {
  await insertTask(personNote('n6'));
  await markNudged('n6'); // last_notified_at = now, retry_count = 1
  // Within 2 days → should NOT re-fire yet.
  const nudges = await getPendingNudges({ maxRetries: 3, intervalDays: 2 });
  assert.ok(!nudges.some((n) => n.id === 'n6'), 'must wait the spacing interval before re-firing');
});
