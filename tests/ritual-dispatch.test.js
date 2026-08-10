// Dispatch tests for prompt-less rituals.
//
// Repro: /seal:ritual creates rows with type='ritual' and prompt=NULL, because
// a ritual fires a reminder carrying a prep template instead of executing an
// agent. Those rows used to be dispatched by NOTHING:
//
//   claimPendingTasks  → requires `prompt IS NOT NULL`  → skips them
//   getPendingReminders → matched only `type='reminder'` → skipped them too
//
// So every ritual sat pending forever and silently never fired. The user got
// no error — just silence, which reads as "I forgot" rather than "it's broken".
//
// The fix widens getPendingReminders to also match prompt-less rituals, and
// makes the runner's reminder loop reschedule recurrences (previously only
// executeTask() could advance a recurrence, and rituals never reach it — so a
// daily ritual would fire once and never come back).

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DB = path.join(
  os.tmpdir(),
  `seal-ritual-test-${process.pid}-${Date.now()}.db`
);
process.env.SEAL_DB_PATH = TMP_DB;

const db = await import('../src/db.js');
const {
  insertTask,
  getPendingReminders,
  claimPendingTasks,
  advanceRecurring,
  checkMaxRuns,
} = db;

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
});

const PAST = '2020-01-01T09:00:00.000Z';

function makeRitual(id, overrides = {}) {
  return {
    id,
    type: 'ritual',
    summary: `ritual ${id}`,
    detail: 'TEMPLATE:\n- question one\n- question two',
    execute_at: PAST,
    recurrence: '15 9 * * 1-5',
    next_run: PAST,
    prompt: null,
    project: 'techlead-90d',
    allowed_tools: '[]',
    permission_mode: 'auto',
    capabilities: '[]',
    notify_type: 'sticky',
    notify_channel: 'telegram',
    notify_target: '12345',
    people: '[]',
    priority: 'high',
    status: 'pending',
    created: new Date().toISOString(),
    max_runs: null,
    ...overrides,
  };
}

test('a due prompt-less ritual is dispatched as a reminder', async () => {
  await insertTask(makeRitual('ritual-due'));

  const reminders = await getPendingReminders();
  const ids = reminders.map(r => r.id);

  assert.ok(
    ids.includes('ritual-due'),
    'prompt-less ritual must be picked up by getPendingReminders — this is the bug that made rituals silently never fire'
  );
});

test('the dispatched ritual carries its template, not just a title', async () => {
  await insertTask(makeRitual('ritual-template'));

  const reminders = await getPendingReminders();
  const fired = reminders.find(r => r.id === 'ritual-template');

  assert.ok(fired, 'ritual should be dispatched');
  assert.match(
    fired.detail,
    /question one/,
    'the prep template is the entire value of a ritual — it must survive dispatch'
  );
});

test('a prompt-less ritual is NOT also claimed as an executable task', async () => {
  await insertTask(makeRitual('ritual-no-double'));

  const claimed = await claimPendingTasks(10);
  const ids = claimed.map(t => t.id);

  assert.ok(
    !ids.includes('ritual-no-double'),
    'a reminder-style ritual must never be claimed for agent execution — that would run an empty prompt'
  );
});

test('a ritual WITH a prompt still goes to the executor, not the reminder loop', async () => {
  // Executable rituals are a real case (a ritual that runs a script to build
  // its own prep). Those must keep their atomic-claim path so two poll ticks
  // cannot double-run them.
  await insertTask(makeRitual('ritual-executable', { prompt: 'build the prep doc' }));

  const reminders = await getPendingReminders();
  assert.ok(
    !reminders.map(r => r.id).includes('ritual-executable'),
    'a ritual with a prompt is executable and must not be dispatched as a plain reminder'
  );

  const claimed = await claimPendingTasks(10);
  assert.ok(
    claimed.map(t => t.id).includes('ritual-executable'),
    'a ritual with a prompt must still be claimed by the executor path'
  );
});

test('rescheduling a recurring ritual returns it to pending and bumps run_count', async () => {
  // This is what makes "fired N times" measurable. Without advanceRecurring
  // the runner marks the ritual done and it never fires again.
  await insertTask(makeRitual('ritual-recurring'));

  const future = '2030-06-10T09:15:00.000Z';
  await advanceRecurring('ritual-recurring', future);

  const after = await db.getTaskById('ritual-recurring');
  assert.equal(after.status, 'pending', 'a recurring ritual must return to pending, not stay done');
  assert.equal(after.run_count, 1, 'run_count must advance so occurrences are countable');
  assert.equal(after.next_run, future);
});

test('checkMaxRuns stays false for an unbounded ritual', async () => {
  // Rituals are created with max_runs = NULL (run forever). A one-shot review
  // ritual sets max_runs = 1 and must retire itself after firing once.
  await insertTask(makeRitual('ritual-forever'));
  await advanceRecurring('ritual-forever', '2030-01-01T09:00:00.000Z');
  // Returns the falsy `max_runs` value itself (NULL) rather than a strict
  // boolean — the runner only branches on truthiness, so assert on that.
  assert.ok(!(await checkMaxRuns('ritual-forever')), 'an unbounded ritual must never retire');

  await insertTask(makeRitual('ritual-oneshot', { max_runs: 1 }));
  await advanceRecurring('ritual-oneshot', '2030-01-01T09:00:00.000Z');
  assert.ok(
    await checkMaxRuns('ritual-oneshot'),
    'a max_runs=1 ritual must retire after its single occurrence'
  );
});
