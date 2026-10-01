import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-upsert-'));
process.env.SEAL_DB_PATH = path.join(dir, 'tasks.db');

const { db } = await import('../src/db.js');
const { upsertReviewTask } = await import('../src/sensors/azure-pr-review.js');

const task = (overrides = {}) => ({
  id: 'seal_pr_10116', type: 'task', summary: 'smart-review PR #10116: x', detail: '{"headSha":"new"}',
  execute_at: new Date().toISOString(), recurrence: null, next_run: null, prompt: 'p', project: '/wt',
  allowed_tools: '[]', disallowed_tools: '[]', model: null, permission_mode: 'bypassPermissions',
  notify_type: 'silent', notify_channel: 'system', notify_target: null, people: '[]', priority: 'medium',
  status: 'pending', created: new Date().toISOString(), max_runs: null, ...overrides,
});

test('re-review reuses a finished task that already has run history (foreign key from task_runs)', async () => {
  assert.equal(await upsertReviewTask(task({ detail: '{"headSha":"old"}' })), true);
  await db.run(`UPDATE tasks SET status = 'done', result = 'old result' WHERE id = 'seal_pr_10116'`);
  await db.run(`INSERT INTO task_runs (task_id, started_at) VALUES ('seal_pr_10116', datetime('now'))`);

  assert.equal(await upsertReviewTask(task()), true);
  const row = await db.get(`SELECT status, result, detail FROM tasks WHERE id = 'seal_pr_10116'`);
  assert.deepEqual(row, { status: 'pending', result: null, detail: '{"headSha":"new"}' });
  assert.equal((await db.get(`SELECT COUNT(*) AS runs FROM task_runs WHERE task_id = 'seal_pr_10116'`)).runs, 1);
});

test('a task still running is never overwritten', async () => {
  await db.run(`UPDATE tasks SET status = 'running' WHERE id = 'seal_pr_10116'`);
  assert.equal(await upsertReviewTask(task({ detail: '{"headSha":"newer"}' })), false);
  assert.equal((await db.get(`SELECT detail FROM tasks WHERE id = 'seal_pr_10116'`)).detail, '{"headSha":"new"}');
});
