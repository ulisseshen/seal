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
  await db.run(`INSERT INTO tasks (id, type, summary, detail, status, created, retry_count) VALUES ('seal_pr_3', 'task', 's', '{"headSha":"ccc"}', 'failed', datetime('now'), 1)`);
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

test('a claim for a new commit is released when the only task is the finished one from the previous commit', async () => {
  const previous = { repo: 'r', prId: 7, headSha: 'old7' };
  const current = { repo: 'r', prId: 7, headSha: 'new7' };
  await ledger.claimReview({ ...previous, mode: 'first-review', taskId: 'seal_pr_7' });
  await ledger.beginPublish(previous);
  await ledger.finishReview({ ...previous, status: 'published', verdict: 'needs-work', findings: 1 });
  await db.run(`INSERT INTO tasks (id, type, summary, detail, status, created, result) VALUES ('seal_pr_7', 'task', 's', '{"headSha":"old7"}', 'done', datetime('now'), 'ok [seal:published] needs-work')`);
  await ledger.claimReview({ ...current, mode: 're-review', taskId: 'seal_pr_7' });
  await age(current, 30);
  assert.deepEqual((await ledger.releaseOrphanClaims({ maxAgeMinutes: 10 })).map((row) => row.headSha), ['new7']);
});

test('a finished task still waiting to publish its own commit keeps the claim', async () => {
  const waiting = { repo: 'r', prId: 8, headSha: 'wait8' };
  await ledger.claimReview({ ...waiting, mode: 'first-review', taskId: 'seal_pr_8' });
  await age(waiting, 30);
  await db.run(`INSERT INTO tasks (id, type, summary, detail, status, created, result) VALUES ('seal_pr_8', 'task', 's', '{"headSha":"wait8"}', 'done', datetime('now'), 'review pronto')`);
  assert.deepEqual(await ledger.releaseOrphanClaims({ maxAgeMinutes: 10 }), []);
});

test('health reports a stuck claim and a publish that never finished', async () => {
  const stuck = { repo: 'h', prId: 9, headSha: 'stuck9' };
  await ledger.claimReview({ ...stuck, mode: 'first-review', taskId: 'seal_pr_9' });
  await age(stuck, 60);
  const publishing = { repo: 'h', prId: 10, headSha: 'pub10' };
  await ledger.claimReview({ ...publishing, mode: 'first-review', taskId: 'seal_pr_10' });
  await ledger.beginPublish(publishing);
  await db.run(`UPDATE pr_reviews SET publish_started_at = datetime('now', '-30 minutes') WHERE pr_id = 10`);
  const texts = (await ledger.healthIssues()).map((issue) => issue.text);
  assert.ok(texts.some((text) => text.includes('h !9')));
  assert.ok(texts.some((text) => text.includes('publicação parada') && text.includes('h !10')));
});

const failedRow = (row) => db.get(`SELECT status, failure_kind, rounds, retry_at, error, (retry_at IS NOT NULL AND datetime(retry_at) <= datetime('now')) AS due FROM pr_reviews WHERE repo = ? AND pr_id = ? AND head_sha = ?`, [row.repo, row.prId, row.headSha]);

test('a transient failure schedules a retry of the same commit with a growing wait, until the rounds run out', async () => {
  const row = { repo: 'r', prId: 70, headSha: 'f00' };
  await ledger.claimReview({ ...row, mode: 'first-review', taskId: 'seal_pr_70' });
  const first = await ledger.failReview({ ...row, error: 'Process killed (SIGTERM)', maxRounds: 3 });
  assert.equal(first.kind, 'transient');
  assert.ok(first.retryAt);
  let stored = await failedRow(row);
  assert.deepEqual([stored.status, stored.failure_kind, stored.rounds, stored.due], ['failed', 'transient', 1, 0]);
  const firstWait = Date.parse(`${stored.retry_at}Z`) - Date.now();
  assert.equal(await ledger.reclaimFailedReview({ ...row, mode: 'first-review', taskId: 'seal_pr_70' }), false);

  await db.run(`UPDATE pr_reviews SET retry_at = datetime('now', '-1 minute') WHERE pr_id = 70`);
  assert.equal(await ledger.reclaimFailedReview({ ...row, mode: 'first-review', taskId: 'seal_pr_70' }), true);
  stored = await failedRow(row);
  assert.deepEqual([stored.status, stored.retry_at, stored.error], ['queued', null, null]);

  const second = await ledger.failReview({ ...row, error: 'Exit code 143', maxRounds: 3 });
  stored = await failedRow(row);
  assert.equal(stored.rounds, 2);
  assert.ok(Date.parse(`${stored.retry_at}Z`) - Date.now() > firstWait, 'second wait is longer');
  assert.equal(second.kind, 'transient');

  await db.run(`UPDATE pr_reviews SET status = 'queued', retry_at = NULL, rounds = 3 WHERE pr_id = 70`);
  const exhausted = await ledger.failReview({ ...row, error: 'Exit code 143', maxRounds: 3 });
  assert.deepEqual(exhausted, { kind: 'transient', retryAt: null, exhausted: true, rounds: 4 });
  assert.equal((await failedRow(row)).retry_at, null);
});

test('a permanent failure is never retried on the same commit', async () => {
  const row = { repo: 'r', prId: 71, headSha: 'f01' };
  await ledger.claimReview({ ...row, mode: 'first-review', taskId: 'seal_pr_71' });
  const result = await ledger.failReview({ ...row, error: 'sem bloco de resultado' });
  assert.deepEqual(result, { kind: 'permanent', retryAt: null, exhausted: false, rounds: 1 });
  await db.run(`UPDATE pr_reviews SET claimed_at = datetime('now', '-1 day') WHERE pr_id = 71`);
  assert.equal(await ledger.reclaimFailedReview({ ...row, mode: 'first-review', taskId: 'seal_pr_71' }), false);
});

test('failures recorded before the classification existed are classified, and the transient ones become due now', async () => {
  const sigterm = { repo: 'r', prId: 72, headSha: 'f02' };
  const broken = { repo: 'r', prId: 73, headSha: 'f03' };
  await db.run(`INSERT INTO pr_reviews (repo, pr_id, head_sha, mode, status, error) VALUES ('r', 72, 'f02', 'first-review', 'failed', 'Process killed (SIGTERM) — will retry on next boot')`);
  await db.run(`INSERT INTO pr_reviews (repo, pr_id, head_sha, mode, status, error) VALUES ('r', 73, 'f03', 'first-review', 'failed', 'sem bloco de resultado')`);
  await ledger.classifyLegacyFailures();
  const retried = await failedRow(sigterm);
  assert.deepEqual([retried.failure_kind, retried.rounds, retried.due], ['transient', 1, 1]);
  assert.equal((await ledger.reviewForSha(sigterm)).retry_due, 1);
  const kept = await failedRow(broken);
  assert.deepEqual([kept.failure_kind, kept.retry_at], ['permanent', null]);
  assert.equal(await ledger.reclaimFailedReview({ ...sigterm, mode: 'first-review', taskId: 'seal_pr_72' }), true);
});

test('a retry that fails to enqueue goes back to waiting and keeps its rounds instead of being forgotten', async () => {
  const row = { repo: 'r', prId: 74, headSha: 'f04' };
  await ledger.claimReview({ ...row, mode: 'first-review', taskId: 'seal_pr_74' });
  await ledger.failReview({ ...row, error: 'Exit code 143' });
  await db.run(`UPDATE pr_reviews SET retry_at = datetime('now', '-1 minute') WHERE pr_id = 74`);
  assert.equal(await ledger.reclaimFailedReview({ ...row, mode: 'first-review', taskId: 'seal_pr_74' }), true);
  await ledger.releaseClaim({ ...row, error: 'git fetch failed' });
  const stored = await failedRow(row);
  assert.deepEqual([stored.status, stored.rounds, stored.due, stored.error], ['failed', 1, 0, 'git fetch failed']);
  assert.ok(stored.retry_at);
});

test('replies already handed to the reviewer are remembered per reviewed commit and never go backwards', async () => {
  const row = { repo: 'r', prId: 75, headSha: 'f05' };
  await ledger.claimReview({ ...row, mode: 'first-review', taskId: 'seal_pr_75' });
  await ledger.finishReview({ ...row, status: 'published' });
  assert.equal((await ledger.reviewForSha(row)).replies_seen_at, null);
  await ledger.markRepliesSeen({ ...row, at: '2026-09-25T15:46:00.000Z' });
  await ledger.markRepliesSeen({ ...row, at: '2026-09-25T15:00:00.000Z' });
  assert.equal((await ledger.reviewForSha(row)).replies_seen_at, '2026-09-25T15:46:00.000Z');
});

test('a verification of resolved comments is asked once per reviewed commit', async () => {
  const row = { repo: 'r', prId: 76, headSha: 'f06' };
  await ledger.claimReview({ ...row, mode: 'first-review', taskId: 'seal_pr_76' });
  await ledger.finishReview({ ...row, status: 'published', verdict: 'needs-work', findings: 0 });
  assert.equal(await ledger.markVerifyRequested(row), true);
  assert.equal(await ledger.markVerifyRequested(row), false);
  assert.ok((await ledger.reviewForSha(row)).verify_requested_at);
});

test('the commit a comment was posted on is the review published right at or after the comment time', async () => {
  const at = (sha, finished) => db.run(`INSERT INTO pr_reviews (repo, pr_id, head_sha, mode, status, finished_at) VALUES ('r', 77, ?, 'm', 'published', ?)`, [sha, finished]);
  await at('aaa', '2026-09-25 19:31:58');
  await at('bbb', '2026-09-25 19:54:01');
  assert.equal(await ledger.reviewedShaAt({ repo: 'r', prId: 77, at: '2026-09-25T19:31:50Z' }), 'aaa');
  assert.equal(await ledger.reviewedShaAt({ repo: 'r', prId: 77, at: '2026-09-25T19:53:59Z' }), 'bbb');
  assert.equal(await ledger.reviewedShaAt({ repo: 'r', prId: 77, at: '2026-09-25T20:30:00Z' }), null);
});
