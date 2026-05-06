// Race condition test for getPendingTasks / claimPendingTasks.
//
// Repro: when the Mac sleeps and wakes up, the Node setInterval can fire
// twice almost simultaneously. Both calls hit getPendingTasks before
// either marks the task as 'running' in the DB, so both pick up the same
// task and execute it twice.
//
// The fix is to add a `claimPendingTasks(limit)` that does an atomic
// SELECT + UPDATE in a transaction (same effect as SQL FOR UPDATE SKIP
// LOCKED). After the fix, two concurrent claims should never return the
// same task.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DB = path.join(
  os.tmpdir(),
  `seal-race-test-${process.pid}-${Date.now()}.db`
);
process.env.SEAL_DB_PATH = TMP_DB;

const db = await import('../src/db.js');
const { insertTask, claimPendingTasks } = db;

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
});

function makeTask(id) {
  return {
    id,
    type: 'task',
    summary: `test task ${id}`,
    detail: '',
    execute_at: null,
    recurrence: null,
    next_run: null,
    prompt: 'do something',
    project: null,
    allowed_tools: '[]',
    permission_mode: 'auto',
    capabilities: '[]',
    notify_type: 'silent',
    notify_channel: null,
    notify_target: null,
    people: '[]',
    priority: 'medium',
    status: 'pending',
    created: new Date().toISOString(),
    max_runs: null,
  };
}

test('claimPendingTasks: two concurrent claims never return the same task', async () => {
  // Insert 3 pending tasks
  await insertTask(makeTask('race-1'));
  await insertTask(makeTask('race-2'));
  await insertTask(makeTask('race-3'));

  // Simulate the wake-from-sleep scenario: two ticks fire at the same time.
  // Each tries to claim up to 5 tasks. Without the fix, both return the
  // same 3 tasks. With the fix, the union has no duplicates and totals 3.
  const [batchA, batchB] = await Promise.all([
    claimPendingTasks(5),
    claimPendingTasks(5),
  ]);

  const idsA = batchA.map(t => t.id);
  const idsB = batchB.map(t => t.id);
  const overlap = idsA.filter(id => idsB.includes(id));

  assert.equal(
    overlap.length,
    0,
    `Concurrent claims returned the same task(s): ${overlap.join(', ')}`
  );

  const total = idsA.length + idsB.length;
  assert.equal(total, 3, `Expected 3 total claims across both batches, got ${total}`);
});

test('claimPendingTasks: claimed tasks are marked running in the DB', async () => {
  await insertTask(makeTask('claim-running-1'));

  const claimed = await claimPendingTasks(5);
  const ids = claimed.map(t => t.id);
  assert.ok(ids.includes('claim-running-1'), 'task was not claimed');

  // Subsequent claim should not return it again
  const second = await claimPendingTasks(5);
  const secondIds = second.map(t => t.id);
  assert.ok(
    !secondIds.includes('claim-running-1'),
    'task was claimed twice'
  );
});

test('claimPendingTasks: respects priority ordering', async () => {
  // Insert in mixed order
  await insertTask({ ...makeTask('prio-low'), priority: 'low' });
  await insertTask({ ...makeTask('prio-high'), priority: 'high' });
  await insertTask({ ...makeTask('prio-medium'), priority: 'medium' });

  const claimed = await claimPendingTasks(1);
  assert.equal(claimed.length, 1, 'should claim 1 task');
  assert.equal(claimed[0].id, 'prio-high', 'should claim highest priority first');
});

test('claimPendingTasks: skips tasks scheduled in the future', async () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await insertTask({ ...makeTask('future-task'), execute_at: future });
  await insertTask({ ...makeTask('now-task') });

  const claimed = await claimPendingTasks(5);
  const ids = claimed.map(t => t.id);
  assert.ok(ids.includes('now-task'), 'now-task should be claimed');
  assert.ok(!ids.includes('future-task'), 'future-task should not be claimed yet');
});
