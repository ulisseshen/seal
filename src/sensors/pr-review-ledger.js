import { db } from '../db.js';
import { classifyReviewFailure } from './pr-review-pipeline-logic.js';

await db.exec(`
  CREATE TABLE IF NOT EXISTS pr_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    pr_id INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'publishing', 'published', 'failed', 'cancelled')),
    task_id TEXT,
    verdict TEXT,
    findings INTEGER,
    error TEXT,
    claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    UNIQUE(repo, pr_id, head_sha)
  );
  CREATE INDEX IF NOT EXISTS idx_pr_reviews_pr ON pr_reviews(repo, pr_id);
`);

for (const ddl of [
  `ALTER TABLE pr_reviews ADD COLUMN publish_started_at TEXT`,
  `ALTER TABLE pr_reviews ADD COLUMN session_id TEXT`,
  `ALTER TABLE pr_reviews ADD COLUMN worktree TEXT`,
  `ALTER TABLE pr_reviews ADD COLUMN failure_kind TEXT`,
  `ALTER TABLE pr_reviews ADD COLUMN retry_at TEXT`,
  `ALTER TABLE pr_reviews ADD COLUMN rounds INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE pr_reviews ADD COLUMN replies_seen_at TEXT`,
  `ALTER TABLE pr_reviews ADD COLUMN verify_requested_at TEXT`,
  `ALTER TABLE pr_reviews ADD COLUMN source_branch TEXT`,
  `ALTER TABLE pr_reviews ADD COLUMN target_branch TEXT`,
  `ALTER TABLE pr_reviews ADD COLUMN origin_branch TEXT`,
]) {
  try {
    await db.exec(ddl);
  } catch {}
}

// Blocks posted before any review (branch name, target). They never enter pr_reviews, on purpose: the same
// commit must be reviewable once the author fixes the cause. Kept apart so the panel can list them.
await db.exec(`
  CREATE TABLE IF NOT EXISTS pr_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    pr_id INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_branch TEXT,
    target_branch TEXT,
    reason TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(repo, pr_id, head_sha, kind)
  );
`);

export async function recordPreReviewBlock({ repo, prId, headSha, kind, source, target, reason }) {
  await db.run(
    `INSERT OR IGNORE INTO pr_blocks (repo, pr_id, head_sha, kind, source_branch, target_branch, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [repo, prId, headSha, kind, source || null, target || null, reason || null],
  );
}

const RETRY_BASE_MINUTES = 30;

const changed = (result) => (result?.changes ?? result?.rowsAffected ?? 0) > 0;

export async function claimReview({ repo, prId, headSha, mode, taskId }) {
  const result = await db.run(
    `INSERT OR IGNORE INTO pr_reviews (repo, pr_id, head_sha, mode, status, task_id) VALUES (?, ?, ?, ?, 'queued', ?)`,
    [repo, prId, headSha, mode, taskId],
  );
  return changed(result);
}

export async function releaseClaim({ repo, prId, headSha, error }) {
  await db.run(
    `UPDATE pr_reviews SET status = 'failed', error = ?, finished_at = datetime('now'), retry_at = datetime('now', ?)
     WHERE repo = ? AND pr_id = ? AND head_sha = ? AND status = 'queued' AND rounds > 0`,
    [error || null, `+${RETRY_BASE_MINUTES} minutes`, repo, prId, headSha],
  );
  await db.run(
    `UPDATE pr_reviews SET status = 'cancelled', error = ?, finished_at = datetime('now') WHERE repo = ? AND pr_id = ? AND head_sha = ? AND status = 'queued'`,
    [error || null, repo, prId, headSha],
  );
  await db.run(`DELETE FROM pr_reviews WHERE repo = ? AND pr_id = ? AND head_sha = ? AND status = 'cancelled'`, [repo, prId, headSha]);
}

export async function beginPublish({ repo, prId, headSha }) {
  const result = await db.run(
    `UPDATE pr_reviews SET status = 'publishing', publish_started_at = datetime('now') WHERE repo = ? AND pr_id = ? AND head_sha = ? AND status = 'queued'`,
    [repo, prId, headSha],
  );
  return changed(result);
}

export async function finishReview({ repo, prId, headSha, status, verdict = null, findings = null, error = null, sessionId = null, worktree = null }) {
  await db.run(
    `UPDATE pr_reviews SET status = ?, verdict = ?, findings = ?, error = ?, finished_at = datetime('now'),
       session_id = COALESCE(?, session_id), worktree = COALESCE(?, worktree)
     WHERE repo = ? AND pr_id = ? AND head_sha = ?`,
    [status, verdict, findings, error, sessionId, worktree, repo, prId, headSha],
  );
}

export async function setReviewBranches({ repo, prId, headSha, source, target, origin }) {
  await db.run(
    `UPDATE pr_reviews SET source_branch = ?, target_branch = ?, origin_branch = ? WHERE repo = ? AND pr_id = ? AND head_sha = ?`,
    [source || null, target || null, origin || null, repo, prId, headSha],
  );
}

export async function reviewedShaAt({ repo, prId, at }) {
  const row = await db.get(
    `SELECT head_sha FROM pr_reviews WHERE repo = ? AND pr_id = ? AND status = 'published' AND datetime(finished_at) >= datetime(?)
     ORDER BY datetime(finished_at) ASC LIMIT 1`,
    [repo, prId, at],
  );
  return row?.head_sha || null;
}

export async function markVerifyRequested({ repo, prId, headSha }) {
  const result = await db.run(
    `UPDATE pr_reviews SET verify_requested_at = datetime('now') WHERE repo = ? AND pr_id = ? AND head_sha = ? AND verify_requested_at IS NULL`,
    [repo, prId, headSha],
  );
  return changed(result);
}

export async function markRepliesSeen({ repo, prId, headSha, at }) {
  await db.run(
    `UPDATE pr_reviews SET replies_seen_at = ? WHERE repo = ? AND pr_id = ? AND head_sha = ? AND (replies_seen_at IS NULL OR replies_seen_at < ?)`,
    [at, repo, prId, headSha, at],
  );
}

export async function lastConversableReview(prId) {
  return db.get(
    `SELECT * FROM pr_reviews WHERE pr_id = ? AND status = 'published' AND session_id IS NOT NULL
     ORDER BY datetime(finished_at) DESC, id DESC LIMIT 1`,
    [prId],
  );
}

export async function reviewForSha({ repo, prId, headSha }) {
  return db.get(
    `SELECT *, (retry_at IS NOT NULL AND datetime(retry_at) <= datetime('now')) AS retry_due FROM pr_reviews WHERE repo = ? AND pr_id = ? AND head_sha = ?`,
    [repo, prId, headSha],
  );
}

const retryWaitMinutes = (rounds) => RETRY_BASE_MINUTES * 4 ** (rounds - 1);

export async function failReview({ repo, prId, headSha, error, maxRounds = 3 }) {
  const kind = classifyReviewFailure(error);
  const row = await db.get(`SELECT rounds FROM pr_reviews WHERE repo = ? AND pr_id = ? AND head_sha = ?`, [repo, prId, headSha]);
  const rounds = (row?.rounds || 0) + 1;
  const exhausted = kind === 'transient' && rounds > maxRounds;
  const wait = kind === 'transient' && !exhausted ? `+${retryWaitMinutes(rounds)} minutes` : null;
  await db.run(
    `UPDATE pr_reviews SET status = 'failed', error = ?, failure_kind = ?, rounds = ?, finished_at = datetime('now'),
       retry_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END
     WHERE repo = ? AND pr_id = ? AND head_sha = ?`,
    [error || null, kind, rounds, wait, wait, repo, prId, headSha],
  );
  const stored = wait ? await db.get(`SELECT retry_at FROM pr_reviews WHERE repo = ? AND pr_id = ? AND head_sha = ?`, [repo, prId, headSha]) : null;
  return { kind, retryAt: stored?.retry_at || null, exhausted, rounds };
}

export async function reclaimFailedReview({ repo, prId, headSha, mode, taskId }) {
  const result = await db.run(
    `UPDATE pr_reviews SET status = 'queued', mode = ?, task_id = ?, error = NULL, retry_at = NULL, finished_at = NULL,
       publish_started_at = NULL, claimed_at = datetime('now')
     WHERE repo = ? AND pr_id = ? AND head_sha = ? AND status = 'failed' AND retry_at IS NOT NULL AND datetime(retry_at) <= datetime('now')`,
    [mode, taskId, repo, prId, headSha],
  );
  return changed(result);
}

export async function classifyLegacyFailures() {
  const legacy = await db.all(`SELECT id, error FROM pr_reviews WHERE status = 'failed' AND failure_kind IS NULL`);
  for (const row of legacy) {
    const kind = classifyReviewFailure(row.error);
    await db.run(
      `UPDATE pr_reviews SET failure_kind = ?, rounds = MAX(rounds, 1), retry_at = CASE WHEN ? = 'transient' THEN datetime('now') ELSE NULL END WHERE id = ?`,
      [kind, kind, row.id],
    );
  }
  return legacy.length;
}

await classifyLegacyFailures();

export async function lastPublishedReview({ repo, prId }) {
  return db.get(
    `SELECT * FROM pr_reviews WHERE repo = ? AND pr_id = ? AND status = 'published' ORDER BY datetime(finished_at) DESC, id DESC LIMIT 1`,
    [repo, prId],
  );
}

export async function releaseOrphanClaims({ maxAgeMinutes = 10, maxRetries = 5 } = {}) {
  const orphans = await db.all(
    `SELECT r.repo, r.pr_id, r.head_sha, t.status AS task_status
     FROM pr_reviews r
     LEFT JOIN tasks t ON t.id = r.task_id
     WHERE r.status = 'queued'
       AND datetime(r.claimed_at) < datetime('now', ?)
       AND (
         t.id IS NULL
         OR EXISTS (SELECT 1 FROM pr_reviews newer WHERE newer.repo = r.repo AND newer.pr_id = r.pr_id AND newer.id > r.id)
         OR NOT (
           t.status IN ('pending', 'running', 'firing')
           OR (t.detail LIKE '%' || r.head_sha || '%' AND t.status = 'done'
               AND COALESCE(t.result, '') NOT LIKE '%[seal:published]%' AND COALESCE(t.result, '') NOT LIKE '%[seal:publish-failed]%')
           OR (t.detail LIKE '%' || r.head_sha || '%' AND t.status = 'failed' AND COALESCE(t.retry_count, 0) < ?)
         )
       )`,
    [`-${maxAgeMinutes} minutes`, maxRetries],
  );
  for (const orphan of orphans) {
    await db.run(`DELETE FROM pr_reviews WHERE repo = ? AND pr_id = ? AND head_sha = ? AND status = 'queued'`, [orphan.repo, orphan.pr_id, orphan.head_sha]);
  }
  return orphans.map((orphan) => ({ repo: orphan.repo, prId: orphan.pr_id, headSha: orphan.head_sha, taskStatus: orphan.task_status }));
}

export async function resumeStalePublishing({ maxAgeMinutes = 10 } = {}) {
  const stale = await db.all(
    `SELECT repo, pr_id, head_sha FROM pr_reviews
     WHERE status = 'publishing' AND datetime(COALESCE(publish_started_at, claimed_at)) < datetime('now', ?)`,
    [`-${maxAgeMinutes} minutes`],
  );
  for (const row of stale) {
    await db.run(`UPDATE pr_reviews SET status = 'queued', publish_started_at = NULL WHERE repo = ? AND pr_id = ? AND head_sha = ? AND status = 'publishing'`, [row.repo, row.pr_id, row.head_sha]);
  }
  return stale.map((row) => ({ repo: row.repo, prId: row.pr_id, headSha: row.head_sha }));
}

export async function healthIssues({ stuckClaimMinutes = 30, runningMinutes = 45, publishingMinutes = 15 } = {}) {
  const issues = [];
  const stuck = await db.all(
    `SELECT r.repo, r.pr_id FROM pr_reviews r LEFT JOIN tasks t ON t.id = r.task_id
     WHERE r.status = 'queued' AND datetime(r.claimed_at) < datetime('now', ?)
       AND (t.id IS NULL OR t.status NOT IN ('pending', 'running', 'firing'))`,
    [`-${stuckClaimMinutes} minutes`],
  );
  for (const row of stuck) issues.push({ key: `stuck-claim:${row.repo}:${row.pr_id}`, text: `claim preso há mais de ${stuckClaimMinutes} min sem task ativa: ${row.repo} !${row.pr_id}` });
  const running = await db.all(
    `SELECT t.id, MAX(runs.started_at) AS started_at FROM tasks t JOIN task_runs runs ON runs.task_id = t.id
     WHERE t.id LIKE 'seal_pr_%' AND t.status = 'running' GROUP BY t.id
     HAVING datetime(MAX(runs.started_at)) < datetime('now', ?)`,
    [`-${runningMinutes} minutes`],
  );
  for (const row of running) issues.push({ key: `long-run:${row.id}`, text: `review rodando há mais de ${runningMinutes} min: ${row.id.replace('seal_pr_', '!')}` });
  const publishing = await db.all(
    `SELECT repo, pr_id FROM pr_reviews WHERE status = 'publishing' AND datetime(COALESCE(publish_started_at, claimed_at)) < datetime('now', ?)`,
    [`-${publishingMinutes} minutes`],
  );
  for (const row of publishing) issues.push({ key: `publishing:${row.repo}:${row.pr_id}`, text: `publicação parada há mais de ${publishingMinutes} min: ${row.repo} !${row.pr_id}` });
  return issues;
}
