import { db } from '../db.js';

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

try {
  await db.exec(`ALTER TABLE pr_reviews ADD COLUMN publish_started_at TEXT`);
} catch {}

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

export async function finishReview({ repo, prId, headSha, status, verdict = null, findings = null, error = null }) {
  await db.run(
    `UPDATE pr_reviews SET status = ?, verdict = ?, findings = ?, error = ?, finished_at = datetime('now') WHERE repo = ? AND pr_id = ? AND head_sha = ?`,
    [status, verdict, findings, error, repo, prId, headSha],
  );
}

export async function reviewForSha({ repo, prId, headSha }) {
  return db.get(`SELECT * FROM pr_reviews WHERE repo = ? AND pr_id = ? AND head_sha = ?`, [repo, prId, headSha]);
}

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
         OR t.status IN ('archived', 'acknowledged')
         OR (t.status = 'failed' AND COALESCE(t.retry_count, 0) >= ?)
         OR EXISTS (SELECT 1 FROM pr_reviews newer WHERE newer.repo = r.repo AND newer.pr_id = r.pr_id AND newer.id > r.id)
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
