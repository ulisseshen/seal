import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-ledger-'));
process.env.SEAL_DB_PATH = path.join(dir, 'tasks.db');

const ledger = await import('../src/sensors/pr-review-ledger.js');
const claim = { repo: 'app-web', prId: 10107, headSha: 'ab7cf0d9' };

test('only one claim wins for the same repo, PR and head sha', async () => {
  const results = await Promise.all([1, 2, 3].map(() => ledger.claimReview({ ...claim, mode: 'first-review', taskId: 't' })));
  assert.deepEqual(results.filter(Boolean).length, 1);
  assert.equal((await ledger.reviewForSha(claim)).status, 'queued');
});

test('publish can begin only once, and a published review becomes the last one', async () => {
  assert.equal(await ledger.beginPublish(claim), true);
  assert.equal(await ledger.beginPublish(claim), false);
  await ledger.finishReview({ ...claim, status: 'published', verdict: 'needs-work', findings: 3 });
  const last = await ledger.lastPublishedReview(claim);
  assert.equal(last.head_sha, 'ab7cf0d9');
  assert.equal(last.findings, 3);
});

test('a released claim frees the sha for a new attempt', async () => {
  const other = { ...claim, headSha: 'deadbeef' };
  assert.equal(await ledger.claimReview({ ...other, mode: 're-review', taskId: 't' }), true);
  await ledger.releaseClaim({ ...other, error: 'boom' });
  assert.equal(await ledger.reviewForSha(other), undefined);
  assert.equal(await ledger.claimReview({ ...other, mode: 're-review', taskId: 't' }), true);
});

const { db } = await import('../src/db.js');
const age = (row, minutes) => db.run(`UPDATE pr_reviews SET claimed_at = datetime('now', ?) WHERE pr_id = ? AND head_sha = ?`, [`-${minutes} minutes`, row.prId, row.headSha]);

test('a claim whose task never got created is released after the grace period, a fresh one is kept', async () => {
  const stale = { repo: 'r', prId: 1, headSha: 'aaa' };
  const fresh = { repo: 'r', prId: 2, headSha: 'bbb' };
  await ledger.claimReview({ ...stale, mode: 'first-review', taskId: 'seal_pr_1' });
  await ledger.claimReview({ ...fresh, mode: 'first-review', taskId: 'seal_pr_2' });
  await age(stale, 30);
  const released = await ledger.releaseOrphanClaims({ maxAgeMinutes: 10 });
  assert.deepEqual(released.map((row) => row.prId), [1]);
  assert.equal(await ledger.reviewForSha(stale), undefined);
  assert.equal((await ledger.reviewForSha(fresh)).status, 'queued');
});

test('a claim with a live or retryable task is never released', async () => {
  const live = { repo: 'r', prId: 3, headSha: 'ccc' };
  await ledger.claimReview({ ...live, mode: 'first-review', taskId: 'seal_pr_3' });
  await age(live, 30);
  await db.run(`INSERT INTO tasks (id, type, summary, status, created, retry_count) VALUES ('seal_pr_3', 'task', 's', 'failed', datetime('now'), 1)`);
  assert.deepEqual(await ledger.releaseOrphanClaims({ maxAgeMinutes: 10, maxRetries: 5 }), []);
  await db.run(`UPDATE tasks SET status = 'running' WHERE id = 'seal_pr_3'`);
  assert.deepEqual(await ledger.releaseOrphanClaims({ maxAgeMinutes: 10, maxRetries: 5 }), []);
  await db.run(`UPDATE tasks SET status = 'failed', retry_count = 5 WHERE id = 'seal_pr_3'`);
  assert.deepEqual((await ledger.releaseOrphanClaims({ maxAgeMinutes: 10, maxRetries: 5 })).map((row) => row.prId), [3]);
});

test('a stale claim superseded by a newer commit of the same PR is released even though the task id is reused', async () => {
  const old = { repo: 'r', prId: 4, headSha: 'old1' };
  const current = { repo: 'r', prId: 4, headSha: 'new1' };
  await ledger.claimReview({ ...old, mode: 'first-review', taskId: 'seal_pr_4' });
  await age(old, 30);
  await ledger.claimReview({ ...current, mode: 'first-review', taskId: 'seal_pr_4' });
  await db.run(`INSERT INTO tasks (id, type, summary, status, created) VALUES ('seal_pr_4', 'task', 's', 'running', datetime('now'))`);
  assert.deepEqual((await ledger.releaseOrphanClaims({ maxAgeMinutes: 10 })).map((row) => row.headSha), ['old1']);
  assert.equal((await ledger.reviewForSha(current)).status, 'queued');
});

test('a publish interrupted mid-way goes back to queued after the grace period, a recent one is left alone', async () => {
  const stuck = { repo: 'r', prId: 5, headSha: 'pub1' };
  const recent = { repo: 'r', prId: 6, headSha: 'pub2' };
  for (const claim of [stuck, recent]) {
    await ledger.claimReview({ ...claim, mode: 'first-review', taskId: `seal_pr_${claim.prId}` });
    assert.equal(await ledger.beginPublish(claim), true);
  }
  await db.run(`UPDATE pr_reviews SET publish_started_at = datetime('now', '-30 minutes') WHERE pr_id = 5`);
  assert.deepEqual((await ledger.resumeStalePublishing({ maxAgeMinutes: 10 })).map((row) => row.prId), [5]);
  assert.equal((await ledger.reviewForSha(stuck)).status, 'queued');
  assert.equal((await ledger.reviewForSha(recent)).status, 'publishing');
  assert.equal(await ledger.beginPublish(stuck), true);
});
