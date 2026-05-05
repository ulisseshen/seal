/**
 * azure-pr-review sensor
 *
 * Polls Azure DevOps REST API (zero tokens) every N minutes.
 * When an eligible PR is found, creates a git worktree for isolation
 * and a SEAL task that spawns `claude -p "/smart-review <url> --auto"`.
 *
 * Tokens only spent when there's actual work.
 * Multiple reviews can run in parallel — each in its own worktree.
 *
 * Eligible PR = active + not mine + not draft + I haven't voted +
 *               no "Revisando" comment from me.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { insertTaskIfNew, searchTasks, insertEvent, db, updateLastNotified } from '../db.js';
import { notify } from '../notify.js';
import { checkClaudeAuth, isLoginExpiredResult } from '../auth.js';
import {
  REVIEW_TRIGGERS,
  PENDING_RESOLVES_MARKER,
  VOTED_MARKER,
  VOTE_MAP,
  commentDate,
  isMyAuthor as _isMyAuthor,
  findReviewRequestInThreads,
  findMyLastCommentInThreads,
  countOpenThreadsByMeIn,
  decideAction,
  parseVoteFromResult,
} from './azure-pr-review-logic.js';

const execFileP = promisify(execFile);

// ─── Config (read from env or defaults) ─────────────────
const ORG = process.env.SEAL_AZURE_ORG || 'yandev';
const PROJECT = process.env.SEAL_AZURE_PROJECT || 'SmartSales';
const REPO_ID = process.env.SEAL_AZURE_REPO_ID || 'f25aac20-9d94-441e-8f13-e09b0d56554d';
const MY_EMAIL = (process.env.SEAL_AZURE_MY_EMAIL || 'ulisses.hen@yandeh.com').toLowerCase();
// Azure DevOps user ID (GUID) for formal @mention markup. Optional —
// when empty, mention detection falls back to plain-text matching of MY_NAME.
const MY_AZURE_ID = (process.env.SEAL_AZURE_MY_ID || '').toLowerCase();
// Substring used as a fallback / additional mention signal in comment text.
// Case-insensitive. Default matches the local part of MY_EMAIL.
const MY_NAME = (process.env.SEAL_AZURE_MY_NAME || 'ulisses').toLowerCase();
// Eligibility window — comments published before this date are ignored.
// Prevents a flood of stale mentions when the rule first activates.
const ELIGIBILITY_START = new Date(
  process.env.SEAL_AZURE_START_DATE || '2026-04-30T00:00:00Z'
).getTime();
// Test PR whitelist — comma-separated PR IDs that bypass the "skip my own PRs"
// gate. Used to drive end-to-end tests on a PR I created myself.
const TEST_PRS = new Set(
  (process.env.SEAL_AZURE_TEST_PRS || '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n))
);
// Test mode — does everything for real (posts lock, creates worktree,
// posts pending-resolves notice, casts auto-vote) EXCEPT inserting the
// SEAL task into the DB. Without the task, claude is never spawned.
// Logs "[dry] WOULD CREATE task ..." so the gate decision is visible.
const TEST_DRY = process.env.SEAL_AZURE_TEST_DRY === '1';
const PAT = process.env.AZURE_DEVOPS_PAT || process.env.AZURE_DEVOPS_EXT_PAT || '';
const API_BASE = `https://dev.azure.com/${ORG}/${PROJECT}/_apis/git/repositories/${REPO_ID}`;
const API_VERSION = 'api-version=7.1';

// The main project directory (used to create worktrees from)
const PROJECT_DIR = process.env.SEAL_AZURE_PROJECT_DIR || '/Users/ulisseshen/projects/prs_smartesales_flutter';
// Worktrees inside the project — claude -p works reliably here because
// .claude/, .mcp.json, and the full environment are in the parent tree.
const WORKTREE_BASE = path.join(PROJECT_DIR, '.seal-worktrees');
const MAX_PARALLEL_REVIEWS = 2; // leave 2 claude slots for interactive use

function authHeaders() {
  return {
    Authorization: 'Basic ' + Buffer.from(':' + PAT).toString('base64'),
    'Content-Type': 'application/json',
  };
}

async function azGet(urlPath) {
  const sep = urlPath.includes('?') ? '&' : '?';
  const url = `${API_BASE}${urlPath}${sep}${API_VERSION}`;
  const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Azure API ${res.status}: ${await res.text().catch(() => '(no body)')}`);
  return res.json();
}

async function azPost(urlPath, body) {
  const sep = urlPath.includes('?') ? '&' : '?';
  const url = `${API_BASE}${urlPath}${sep}${API_VERSION}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Azure API ${res.status}: ${await res.text().catch(() => '(no body)')}`);
  return res.json();
}

async function azPut(urlPath, body) {
  const sep = urlPath.includes('?') ? '&' : '?';
  const url = `${API_BASE}${urlPath}${sep}${API_VERSION}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Azure API ${res.status}: ${await res.text().catch(() => '(no body)')}`);
  return res.json();
}

async function azPatch(urlPath, body) {
  const sep = urlPath.includes('?') ? '&' : '?';
  const url = `${API_BASE}${urlPath}${sep}${API_VERSION}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Azure API ${res.status}: ${await res.text().catch(() => '(no body)')}`);
  return res.json();
}

// ─── Worktree management ────────────────────────────────

function worktreePath(prId) {
  return path.join(WORKTREE_BASE, `pr-${prId}`);
}

async function createWorktree(prId, sourceBranch) {
  const wtPath = worktreePath(prId);
  if (fs.existsSync(wtPath)) {
    console.log(`[azure-pr-review] Worktree already exists: ${wtPath}`);
    return wtPath;
  }
  fs.mkdirSync(WORKTREE_BASE, { recursive: true });

  // Fetch latest refs
  await execFileP('git', ['fetch', 'origin'], { cwd: PROJECT_DIR, timeout: 30_000 });

  // Find latest release branch (where skills/agents are always up-to-date)
  let latestRelease;
  try {
    const { stdout } = await execFileP('git', [
      'branch', '-r', '--list', 'origin/release/*', '--sort=-version:refname',
    ], { cwd: PROJECT_DIR, timeout: 10_000 });
    latestRelease = stdout.trim().split('\n')[0]?.trim();
  } catch {}

  // Create worktree from latest release (not the PR's source branch).
  // Smart-review uses git diff to analyze the PR, so it doesn't need
  // to be on the source branch — it needs the latest skills + agents.
  const base = latestRelease || 'origin/main';
  try {
    await execFileP('git', ['worktree', 'add', '--detach', wtPath, base], {
      cwd: PROJECT_DIR,
      timeout: 30_000,
    });
  } catch (err) {
    // Fallback: detached HEAD from current
    if (!fs.existsSync(wtPath)) {
      await execFileP('git', ['worktree', 'add', '--detach', wtPath], {
        cwd: PROJECT_DIR,
        timeout: 30_000,
      });
    }
  }

  // Copy .mcp.json from project root if present. Without it, the executor
  // spawns claude without --mcp-config and the smart-review skill aborts
  // because it can't reach the Azure DevOps MCP server (no posting findings).
  // The .mcp.json is intentionally not committed to the source branch — it
  // lives in the parent repo root and we propagate it to each worktree.
  try {
    const srcMcp = path.join(PROJECT_DIR, '.mcp.json');
    const dstMcp = path.join(wtPath, '.mcp.json');
    if (fs.existsSync(srcMcp) && !fs.existsSync(dstMcp)) {
      fs.copyFileSync(srcMcp, dstMcp);
      console.log(`[azure-pr-review] Copied .mcp.json into worktree`);
    }
  } catch (err) {
    console.warn(`[azure-pr-review] Failed to copy .mcp.json: ${err.message}`);
  }

  console.log(`[azure-pr-review] Created worktree: ${wtPath} (base: ${base}, reviewing: ${sourceBranch})`);
  return wtPath;
}

async function cleanupWorktrees() {
  if (!fs.existsSync(WORKTREE_BASE)) return 0;
  let cleaned = 0;

  const dirs = fs.readdirSync(WORKTREE_BASE);
  for (const dir of dirs) {
    if (!dir.startsWith('pr-')) continue;
    const prId = dir.replace('pr-', '');
    const needle = `smart-review PR #${prId}`;

    // Check if any task still needs this worktree (by project path OR by summary)
    const wtPath = path.join(WORKTREE_BASE, dir);
    try {
      // Check by project path — catches tasks regardless of naming.
      // Include 'failed' tasks that still have retries available (auto-recovery
      // may reset them back to 'pending' on the next tick and need the worktree).
      const MAX_RETRIES = 5;
      const activeByPath = await db.all(
        `SELECT id, status, retry_count FROM tasks
         WHERE project = ?
         AND (
           status IN ('pending', 'running', 'firing')
           OR (status = 'failed' AND COALESCE(retry_count, 0) < ?)
         )`,
        [wtPath, MAX_RETRIES]
      );
      if (activeByPath.length > 0) {
        console.log(`[azure-pr-review] Worktree ${wtPath} still needed by ${activeByPath.length} task(s) (by path), keeping`);
        continue;
      }
      // Also check by summary (legacy/fallback)
      const pending = await searchTasks(needle, 'pending');
      const running = await searchTasks(needle, 'running');
      if (pending?.length > 0 || running?.length > 0) continue; // still active
    } catch {}

    // Task is done/failed/acknowledged — remove worktree
    try {
      await execFileP('git', ['worktree', 'remove', '--force', wtPath], {
        cwd: PROJECT_DIR,
        timeout: 15_000,
      });
      cleaned++;
      console.log(`[azure-pr-review] Cleaned up worktree: ${wtPath}`);
    } catch (err) {
      // Orphaned worktree (registry gone or .git missing): git refuses to
      // remove it, but the directory keeps re-triggering this loop forever.
      // Force-delete the directory and prune stale registry entries.
      const msg = err.message || '';
      const orphan = msg.includes('is not a working tree')
        || msg.includes('does not exist')
        || msg.includes('not a valid path');
      if (orphan) {
        try {
          fs.rmSync(wtPath, { recursive: true, force: true });
          await execFileP('git', ['worktree', 'prune'], {
            cwd: PROJECT_DIR,
            timeout: 10_000,
          }).catch(() => {});
          cleaned++;
          console.log(`[azure-pr-review] Force-removed orphaned worktree: ${wtPath}`);
        } catch (rmErr) {
          console.warn(`[azure-pr-review] Failed to force-remove ${wtPath}: ${rmErr.message}`);
        }
      } else {
        console.warn(`[azure-pr-review] Failed to remove worktree ${wtPath}: ${err.message}`);
      }
    }
  }
  return cleaned;
}

// ─── PR status helpers ─────────────────────────────────

/**
 * Fetch the current status of a PR from Azure DevOps.
 * Returns the PR object (with .status: 'active' | 'completed' | 'abandoned'),
 * or null if the request fails / PR is not found.
 */
async function fetchPrStatus(prId) {
  if (!PAT) return null;
  try {
    return await azGet(`/pullRequests/${prId}`);
  } catch (err) {
    console.warn(`[azure-pr-review] Failed to fetch PR #${prId} status: ${err.message}`);
    return null;
  }
}

/**
 * Try to recreate a missing worktree for a failed review task.
 * Returns true on success, false on failure.
 *
 * Mirrors the createWorktree logic — uses latest release branch as base,
 * since smart-review uses git diff and only needs the latest skills/agents.
 */
async function tryRecreateWorktree(task) {
  const match = task.summary && task.summary.match(/PR #(\d+)/);
  if (!match) return false;
  const prId = match[1];

  try {
    console.log(`[azure-pr-review] Auto-recovering worktree for failed task ${task.id} (PR #${prId})`);
    // Fetch to get latest refs
    await execFileP('git', ['fetch', 'origin'], { cwd: PROJECT_DIR, timeout: 30_000 });

    // Find latest release branch (skills/agents always up-to-date there)
    let base = 'origin/main';
    try {
      const { stdout } = await execFileP('git', [
        'branch', '-r', '--list', 'origin/release/*', '--sort=-version:refname',
      ], { cwd: PROJECT_DIR, timeout: 10_000 });
      const latestRelease = stdout.trim().split('\n')[0]?.trim();
      if (latestRelease) base = latestRelease;
    } catch {}

    // Recreate worktree at the same path the task expects
    fs.mkdirSync(WORKTREE_BASE, { recursive: true });
    await execFileP('git', ['worktree', 'add', '--detach', task.project, base], {
      cwd: PROJECT_DIR,
      timeout: 30_000,
    });
    console.log(`[azure-pr-review] Recreated worktree ${task.project}`);
    return true;
  } catch (err) {
    console.warn(`[azure-pr-review] Worktree recreation failed for ${task.id}: ${err.message}`);
    return false;
  }
}

// ─── PR eligibility checks ─────────────────────────────

// Per-tick threads cache so the same PR is fetched at most once even when
// multiple eligibility checks need it. Reset at the top of runAzurePrReview.
let threadsCache = new Map(); // prId -> { ok: bool, threads: [] }

async function getPrThreads(prId) {
  if (threadsCache.has(prId)) return threadsCache.get(prId);
  try {
    const data = await azGet(`/pullRequests/${prId}/threads`);
    const entry = { ok: true, threads: data.value || [] };
    threadsCache.set(prId, entry);
    return entry;
  } catch (err) {
    console.warn(`[azure-pr-review] threads fetch failed for PR ${prId}: ${err.message}`);
    const entry = { ok: false, threads: [] };
    threadsCache.set(prId, entry);
    return entry;
  }
}

function isMyAuthor(author) {
  return _isMyAuthor(author, MY_EMAIL);
}

/**
 * Find my "Revisando" lock comment on this PR (if any).
 * Returns { found, threadId, commentId } — found=true also when fetch fails,
 * so the caller treats network errors as "skip, don't risk double-review".
 */
async function findMyReviewLock(prId) {
  const { ok, threads } = await getPrThreads(prId);
  if (!ok) return { found: true, fetchError: true };
  for (const thread of threads) {
    for (const comment of thread.comments || []) {
      if (isMyAuthor(comment.author) && comment.content?.includes('Revisando')) {
        return { found: true, threadId: thread.id, commentId: comment.id };
      }
    }
  }
  return { found: false };
}

async function hasMyReviewLock(prId) {
  return (await findMyReviewLock(prId)).found;
}

async function findMyLastComment(prId) {
  const { ok, threads } = await getPrThreads(prId);
  if (!ok) return null;
  return findMyLastCommentInThreads(threads, MY_EMAIL, {
    myAzureId: MY_AZURE_ID,
    myName: MY_NAME,
    eligibilityStart: ELIGIBILITY_START,
  });
}

async function countOpenThreadsByMe(prId) {
  const { ok, threads } = await getPrThreads(prId);
  if (!ok) return 0;
  return countOpenThreadsByMeIn(threads, MY_EMAIL);
}

async function findReviewRequest(prId, sinceTs = 0) {
  const { ok, threads } = await getPrThreads(prId);
  if (!ok) return null;
  return findReviewRequestInThreads(threads, {
    myAzureId: MY_AZURE_ID,
    myName: MY_NAME,
    eligibilityStart: ELIGIBILITY_START,
    sinceTs,
  });
}

/**
 * I'm in pr.reviewers[] (any vote, including 0 = pending). Treats this as
 * an explicit review request even without a comment.
 */
function isAssignedReviewer(pr) {
  return (pr.reviewers || []).some(r =>
    (r.uniqueName || '').toLowerCase() === MY_EMAIL
  );
}

/**
 * Returns the timestamp (ms) of the most recent commit in the PR, or 0 on
 * error / empty. The re-review gate compares this against my last comment
 * AND the latest review-request comment to enforce ordering:
 *   commit > lastMyAt  AND  triggerAt > commit
 */
async function getLastCommitDate(prId) {
  try {
    const data = await azGet(`/pullRequests/${prId}/commits?$top=20`);
    let latest = 0;
    for (const c of data.value || []) {
      const at = new Date(c.committer?.date || c.author?.date || 0).getTime();
      if (at > latest) latest = at;
    }
    return latest;
  } catch (err) {
    console.warn(`[azure-pr-review] commits fetch failed for PR ${prId}: ${err.message}`);
    return 0;
  }
}

/**
 * Posts the "you have unresolved findings" comment, but only once per
 * review cycle — if my last comment was already this notice, stay silent.
 */
async function postPendingResolvesNotice(prId, openCount, lastMyComment) {
  if (lastMyComment && (lastMyComment.content || '').includes(PENDING_RESOLVES_MARKER)) {
    return false; // already complained, don't spam
  }
  const body = `${PENDING_RESOLVES_MARKER}\n\nVocê tem **${openCount}** thread(s) ainda em aberto da revisão anterior. Resolva os pontos pendentes antes de pedir nova revisão.`;
  try {
    await azPost(`/pullRequests/${prId}/threads`, {
      comments: [{ parentCommentId: 0, content: body, commentType: 1 }],
      status: 1, // active
    });
    return true;
  } catch (err) {
    console.warn(`[azure-pr-review] failed to post pending-resolves notice on PR #${prId}: ${err.message}`);
    return false;
  }
}

/**
 * Cast my vote on the PR via Azure DevOps API. Requires MY_AZURE_ID.
 */
async function setMyVote(prId, vote) {
  if (!MY_AZURE_ID) throw new Error('MY_AZURE_ID not configured');
  // Azure DevOps reviewer vote uses PUT (not PATCH). Tested against the
  // /pullRequests/{id}/reviewers/{reviewerId} endpoint.
  return azPut(
    `/pullRequests/${prId}/reviewers/${MY_AZURE_ID}`,
    { vote, id: MY_AZURE_ID }
  );
}

/**
 * Sweep done review tasks whose result contains a verdict line and cast
 * the vote on Azure. Marks the task result with [seal:voted] to avoid
 * re-voting on subsequent ticks.
 */
async function processPendingVotes() {
  if (!MY_AZURE_ID) return 0;
  const candidates = await db.all(
    `SELECT id, summary, project, result FROM tasks
     WHERE summary LIKE 'smart-review PR #%'
       AND status = 'done'
       AND result IS NOT NULL
       AND result NOT LIKE ?`,
    [`%${VOTED_MARKER}%`]
  );
  let voted = 0;
  for (const t of candidates) {
    const vote = parseVoteFromResult(t.result);
    if (vote === null) continue; // no [seal:vote] line yet — skip silently
    const m = t.summary && t.summary.match(/PR #(\d+)/);
    if (!m) continue;
    const prId = parseInt(m[1], 10);
    try {
      await setMyVote(prId, vote);
      const stamp = `\n\n${VOTED_MARKER} ${vote} at ${new Date().toISOString()}`;
      await db.run(
        `UPDATE tasks SET result = result || ? WHERE id = ?`,
        [stamp, t.id]
      );
      voted++;
      console.log(`[azure-pr-review] Voted ${vote} on PR #${prId} (task ${t.id})`);
    } catch (err) {
      console.warn(`[azure-pr-review] auto-vote failed on PR #${prId}: ${err.message}`);
    }
  }
  return voted;
}

/**
 * Edit the lock comment in-place. Used to mark zombie locks as interrupted
 * so the next sensor tick can re-create the review task.
 */
async function updateLockComment(prId, threadId, commentId, newContent) {
  return azPatch(
    `/pullRequests/${prId}/threads/${threadId}/comments/${commentId}`,
    { content: newContent, parentCommentId: 0, commentType: 1 }
  );
}

// ─── Main sensor ────────────────────────────────────────

/**
 * Main sensor function. Returns stats for logging.
 */
export async function runAzurePrReview() {
  if (!PAT) {
    console.warn('[azure-pr-review] No AZURE_DEVOPS_PAT in env — skipping');
    return { skipped: true, reason: 'no-pat' };
  }

  // Reset per-tick caches.
  threadsCache = new Map();

  // Pre-flight: prune stale worktree registry entries left by crashed runs
  // or external interference. Cheap (~10ms) and prevents cleanupWorktrees
  // from looping forever on orphans.
  try {
    await execFileP('git', ['worktree', 'prune'], {
      cwd: PROJECT_DIR,
      timeout: 10_000,
    });
  } catch (err) {
    console.warn(`[azure-pr-review] worktree prune failed: ${err.message}`);
  }

  // Step 0vote: cast pending votes from completed review tasks.
  try {
    const v = await processPendingVotes();
    if (v > 0) console.log(`[azure-pr-review] Cast ${v} pending vote(s)`);
  } catch (err) {
    console.warn(`[azure-pr-review] pending votes sweep failed: ${err.message}`);
  }

  // Step 0z: Global auto-unblock for tasks parked by the executor's
  // login pre-flight check. The executor parks ANY task type with the
  // sentinel result when /login is expired; we sweep them all back to
  // 'pending' as soon as auth is restored. Cheap (one auth probe + one
  // SQL update at most).
  try {
    const blocked = await db.all(
      `SELECT id FROM tasks
       WHERE status = 'failed'
         AND result LIKE '%login expired%'`
    );
    if (blocked.length > 0) {
      const auth = await checkClaudeAuth();
      if (auth.ok) {
        const ids = blocked.map((t) => t.id);
        const placeholders = ids.map(() => '?').join(',');
        await db.run(
          `UPDATE tasks SET status = 'pending', result = NULL WHERE id IN (${placeholders})`,
          ids
        );
        console.log(`[seal:auth] Claude login restored, unblocking ${ids.length} task(s)`);
      }
    }
  } catch (err) {
    console.warn(`[seal:auth] login-expired sweep error: ${err.message}`);
  }

  // Step 0a: Auto-archive review tasks for PRs that no longer need review
  // (PR was completed/abandoned externally — task is moot, stop nagging)
  try {
    const allReviewTasks = await db.all(
      `SELECT id, summary, project FROM tasks
       WHERE summary LIKE 'smart-review PR #%'
         AND status NOT IN ('done', 'archived', 'acknowledged')`
    );
    for (const t of allReviewTasks) {
      const m = t.summary && t.summary.match(/PR #(\d+)/);
      if (!m) continue;
      const prId = m[1];
      const pr = await fetchPrStatus(prId);
      if (!pr) continue; // network / auth issue — try again next tick
      if (pr.status && pr.status !== 'active') {
        await db.run(
          `UPDATE tasks SET status = 'archived', result = ?, completed_at = datetime('now') WHERE id = ?`,
          [`PR was ${pr.status} (auto-archived)`, t.id]
        );
        console.log(`[azure-pr-review] Auto-archived task ${t.id} for PR #${prId} (status: ${pr.status})`);
      } else if (pr.isDraft) {
        // Draft PRs don't need review either — archive
        await db.run(
          `UPDATE tasks SET status = 'archived', result = ?, completed_at = datetime('now') WHERE id = ?`,
          [`PR became draft (auto-archived)`, t.id]
        );
        console.log(`[azure-pr-review] Auto-archived task ${t.id} for PR #${prId} (now a draft)`);
      }
    }
  } catch (err) {
    console.warn(`[azure-pr-review] auto-archive error: ${err.message}`);
  }

  // Step 0: Clean up worktrees from completed reviews
  try {
    const cleaned = await cleanupWorktrees();
    if (cleaned > 0) console.log(`[azure-pr-review] Cleaned ${cleaned} stale worktree(s)`);
  } catch (err) {
    console.warn(`[azure-pr-review] cleanup error: ${err.message}`);
  }

  // Step 0b: Check how many reviews are already in-flight
  let inFlight = 0;
  try {
    const running = await searchTasks('smart-review PR', 'running');
    inFlight = running?.length || 0;
    if (inFlight >= MAX_PARALLEL_REVIEWS) {
      console.log(`[azure-pr-review] Skipped — ${inFlight}/${MAX_PARALLEL_REVIEWS} reviews in-flight`);
      return { skipped: true, reason: 'max-parallel-reached', inFlight };
    }
  } catch (err) {
    // Can't determine in-flight count — bail to avoid exceeding slot limit
    console.warn(`[azure-pr-review] in-flight check failed, skipping tick: ${err.message}`);
    return { skipped: true, reason: 'inflight-check-error', error: err.message };
  }

  // Step 1: List active PRs (pure HTTP, 0 tokens)
  let prs;
  try {
    const data = await azGet('/pullRequests?searchCriteria.status=active&$top=50');
    prs = data.value || [];
  } catch (err) {
    console.warn(`[azure-pr-review] list PRs failed: ${err.message}`);
    return { skipped: true, reason: 'list-error', error: err.message };
  }

  // Emit events for every active PR so the detector + team builder see them.
  for (const pr of prs) {
    const authorEmail = (pr.createdBy?.uniqueName || '').toLowerCase();
    const authorName = pr.createdBy?.displayName || '';
    try {
      await insertEvent({
        source: 'azure',
        kind: 'azure.pr.active',
        data: {
          pr_id: pr.pullRequestId,
          title: pr.title,
          source_branch: (pr.sourceRefName || '').replace('refs/heads/', ''),
          target_branch: (pr.targetRefName || '').replace('refs/heads/', ''),
          author_name: authorName,
          author_email: authorEmail,
          is_draft: pr.isDraft || false,
          repo: pr.repository?.name || '',
          url: `https://dev.azure.com/${ORG}/${PROJECT}/_git/${pr.repository?.name || ''}/pullrequest/${pr.pullRequestId}`,
        },
      });
    } catch {}
  }

  // Step 2: Filter and create tasks (up to available slots)
  // Deduplicate — Azure API can return the same PR multiple times
  // (e.g. when listed under multiple reviewers or across pages).
  const seen = new Set();
  prs = prs.filter(pr => {
    if (seen.has(pr.pullRequestId)) return false;
    seen.add(pr.pullRequestId);
    return true;
  });

  // Step 1.5: Zombie lock detector. A "Revisando…" comment with no
  // matching active task means a previous review crashed/was cleaned up
  // before completing — the PR is locked but nothing will ever finish it.
  // Edit the comment so the next tick can re-create the task.
  let zombiesCleared = 0;
  for (const pr of prs) {
    const lock = await findMyReviewLock(pr.pullRequestId);
    if (!lock.found || lock.fetchError) continue;
    try {
      const active = await db.all(
        `SELECT id FROM tasks
         WHERE summary LIKE ?
           AND status IN ('pending', 'running', 'firing')`,
        [`smart-review PR #${pr.pullRequestId}%`]
      );
      if (active.length > 0) continue; // legitimate in-progress review

      await updateLockComment(
        pr.pullRequestId,
        lock.threadId,
        lock.commentId,
        '⚠️ Review interrompida — reagendando.\n\n_Lock anterior detectado como zumbi (sem task ativa). O sensor irá criar uma nova revisão no próximo ciclo._'
      );
      zombiesCleared++;
      console.log(`[azure-pr-review] Cleared zombie lock on PR #${pr.pullRequestId}`);
    } catch (err) {
      console.warn(`[azure-pr-review] zombie-lock clear failed for PR #${pr.pullRequestId}: ${err.message}`);
    }
  }
  if (zombiesCleared > 0) {
    console.log(`[azure-pr-review] Cleared ${zombiesCleared} zombie lock(s)`);
  }

  const slotsAvailable = MAX_PARALLEL_REVIEWS - inFlight;
  let checked = 0;
  let skipped = 0;
  let created = 0;

  for (const pr of prs) {
    if (created >= slotsAvailable) break;

    // Skip my own PRs (match by email) — except whitelisted test PRs.
    const authorEmail = (pr.createdBy?.uniqueName || '').toLowerCase();
    const isTestPr = TEST_PRS.has(pr.pullRequestId);
    if (authorEmail === MY_EMAIL && !isTestPr) { skipped++; continue; }

    // Skip drafts
    if (pr.isDraft) { skipped++; continue; }

    // Skip PRs where I already voted
    const myVote = (pr.reviewers || []).find(r =>
      (r.uniqueName || '').toLowerCase() === MY_EMAIL && r.vote !== 0
    );
    if (myVote) { skipped++; continue; }

    // Skip if a SEAL task for this PR is already in flight (pending/running/firing).
    // Catches the case where the lock comment was never posted (e.g. claude
    // crashed before reaching that step) and prevents the gate from logging
    // PASS every tick on the same trigger. Ends recovers via recoverOrphanTasks
    // on next runner restart.
    const inFlightTask = await db.get(
      `SELECT id, status FROM tasks
       WHERE id = ? AND status IN ('pending', 'running', 'firing')`,
      [`seal_pr_${pr.pullRequestId}`]
    );
    if (inFlightTask) {
      skipped++;
      continue;
    }

    // Skip if a review is already in progress on this PR (lock comment present)
    checked++;
    if (await hasMyReviewLock(pr.pullRequestId)) {
      skipped++;
      continue;
    }

    // ─── Eligibility gate: review only on explicit request ───
    // Trigger comment = same comment containing mention + review keyword.
    const lastMyComment = await findMyLastComment(pr.pullRequestId);
    const lastMyAt = lastMyComment ? commentDate(lastMyComment) : 0;
    const reviewReq = await findReviewRequest(pr.pullRequestId, lastMyAt);

    if (!reviewReq) {
      if (isTestPr) {
        console.log(`[azure-pr-review] [test PR #${pr.pullRequestId}] skip: no trigger comment (lastMyAt=${lastMyAt || 'n/a'})`);
      }
      skipped++;
      continue; // no signal newer than my last fala — leave PR alone
    }
    const triggerAt = commentDate(reviewReq);

    // Path discrimination: first review vs re-review.
    let isReReview = false;
    if (lastMyComment) {
      // Re-review requires BOTH: a commit after my last fala, AND the
      // trigger comment posted AFTER that commit. Otherwise the trigger
      // is stale (asks for re-review on un-changed code) — post a
      // "pending resolves" notice once and stay silent.
      const lastCommitAt = await getLastCommitDate(pr.pullRequestId);
      const commitFresh = lastCommitAt > lastMyAt;
      const triggerAfterCommit = triggerAt > lastCommitAt;

      if (!commitFresh || !triggerAfterCommit) {
        const open = await countOpenThreadsByMe(pr.pullRequestId);
        if (isTestPr) {
          console.log(`[azure-pr-review] [test PR #${pr.pullRequestId}] re-review gate failed: commitFresh=${commitFresh} triggerAfterCommit=${triggerAfterCommit} open=${open} lastMyAt=${lastMyAt} lastCommitAt=${lastCommitAt} triggerAt=${triggerAt}`);
        }
        if (open > 0) {
          const posted = await postPendingResolvesNotice(
            pr.pullRequestId, open, lastMyComment
          );
          if (posted) {
            console.log(`[azure-pr-review] PR #${pr.pullRequestId}: posted pending-resolves notice (${open} open)`);
          }
        }
        skipped++;
        continue;
      }
      isReReview = true;
    }
    if (isTestPr) {
      console.log(`[azure-pr-review] [test PR #${pr.pullRequestId}] gate PASS: mode=${isReReview ? 're-review' : 'first-review'} triggerCommentId=${reviewReq.id}`);
    }

    // ─── Eligible! Create worktree + SEAL task ───────────
    const prUrl = `https://dev.azure.com/${ORG}/${PROJECT}/_git/${pr.repository?.name || 'smartsales-flutter-frontend'}/pullrequest/${pr.pullRequestId}`;
    const sourceBranch = (pr.sourceRefName || '').replace('refs/heads/', '');

    let wtPath;
    try {
      wtPath = await createWorktree(pr.pullRequestId, sourceBranch);
    } catch (err) {
      console.warn(`[azure-pr-review] worktree failed for PR #${pr.pullRequestId}: ${err.message}`);
      continue;
    }

    const reviewArgs = isReReview ? `${prUrl} --auto --re-review` : `${prUrl} --auto`;
    const task = {
      id: `seal_pr_${pr.pullRequestId}`,
      type: 'task',
      summary: `smart-review PR #${pr.pullRequestId}: ${pr.title}`.slice(0, 80),
      detail: `Auto-created by azure-pr-review sensor. PR: ${prUrl}. Author: ${pr.createdBy?.displayName}. Source: ${sourceBranch}. Worktree: ${wtPath}. Mode: ${isReReview ? 're-review' : 'first-review'}.`,
      execute_at: new Date().toISOString(),
      recurrence: null,
      next_run: null,
      prompt: `Use the Skill tool to invoke skill="smart-review" with args="${reviewArgs}". Wait for it to complete fully. Do not interrupt or summarize early.`,
      project: wtPath, // isolated worktree, not the shared repo
      // Empty = no --allowedTools flag passed to claude.
      // With bypassPermissions, all tools are available — no whitelist needed.
      allowed_tools: '[]',
      permission_mode: 'bypassPermissions',
      notify_type: 'sound',
      notify_channel: 'system',
      notify_target: null,
      people: JSON.stringify([pr.createdBy?.displayName || 'unknown']),
      priority: 'medium',
      status: 'pending',
      created: new Date().toISOString(),
      max_runs: null,
    };

    try {
      // Lock: skip if a task for this PR was completed in the last 60 minutes.
      // Prevents duplicate review comments when the sensor would otherwise
      // create a fresh task right after a successful run completes.
      const recentDone = await db.get(
        `SELECT id, completed_at FROM tasks
         WHERE id = ? AND status = 'done'
         AND datetime(completed_at) > datetime('now', '-60 minutes')`,
        [task.id]
      );
      if (recentDone) {
        skipped++;
        console.log(`[azure-pr-review] PR #${pr.pullRequestId} reviewed recently (${recentDone.completed_at}), skipping`);
        continue;
      }

      if (TEST_DRY) {
        // Test mode: lock posted, worktree created — but task is never
        // inserted, so claude is never spawned. Use this to drive
        // anti-loop tests on a real PR without burning tokens.
        skipped++;
        console.log(`[azure-pr-review] [dry] WOULD CREATE task ${task.id} for PR #${pr.pullRequestId} (mode: ${isReReview ? 're-review' : 'first-review'})`);
        continue;
      }

      const inserted = await insertTaskIfNew(task);
      if (inserted) {
        created++;
        console.log(`[azure-pr-review] Created task ${task.id} for PR #${pr.pullRequestId} (worktree: ${wtPath})`);
      } else {
        skipped++;
        console.log(`[azure-pr-review] PR #${pr.pullRequestId} already has task ${task.id}, skipped`);
      }
    } catch (err) {
      console.warn(`[azure-pr-review] insert failed: ${err.message}`);
    }
  }

  // ─── Nag about failed reviews & auto-retry recoverable ones ───
  // Catches every failed review (no last_notified_at gate at the SQL level)
  // so OLD failures still get retried/nagged. The 5-min nag throttle is
  // applied per-task below, only when we actually need to nag.
  try {
    const recoverablePatterns = [
      'sigterm',
      'exit code 143',
      'exit code -2',
      'orphaned',
      'enoent',
      'no such file',
      'worktree missing',
      'worktree was deleted',
    ];
    const MAX_RETRIES = 5;
    const NAG_COOLDOWN_MIN = 5;

    const failedReviews = await db.all(
      `SELECT id, summary, result, project, retry_count, last_notified_at FROM tasks
       WHERE summary LIKE 'smart-review PR%'
         AND status = 'failed'`
    );

    for (const task of failedReviews) {
      const result = task.result || '';
      const retryCount = task.retry_count || 0;

      // ─── Login-expired failures: skip retry, don't nag ────────────
      // The Step-0z sweep at the top of this tick already unblocked any
      // login-expired task if /login was restored. If we still see one
      // here, auth is still bad — leave it alone (executor handles the
      // user-facing nag, throttled to once per hour).
      if (isLoginExpiredResult(result)) {
        continue;
      }

      // Empty result OR matches a known recoverable pattern → try to recover.
      const isRecoverable =
        result === '' ||
        recoverablePatterns.some(p => result.toLowerCase().includes(p));
      const canRetry = retryCount < MAX_RETRIES;

      if (isRecoverable && canRetry && task.project && task.project.includes('.seal-worktrees')) {
        // Recreate worktree if missing
        if (!fs.existsSync(task.project)) {
          const ok = await tryRecreateWorktree(task);
          if (!ok) {
            console.log(`[azure-pr-review] Could not recreate worktree for ${task.id}, will retry next tick`);
            continue; // skip nag — transient infra issue, retry on next tick
          }
        }

        // Reset to pending and bump retry count
        await db.run(
          `UPDATE tasks SET status = 'pending', result = NULL, retry_count = retry_count + 1 WHERE id = ?`,
          [task.id]
        );
        console.log(`[azure-pr-review] Auto-recovered task ${task.id} (retry ${retryCount + 1}/${MAX_RETRIES})`);
        continue;
      }

      // Real failure (or out of retries) — nag, but throttled to once every NAG_COOLDOWN_MIN.
      if (task.last_notified_at) {
        const last = new Date(task.last_notified_at + 'Z').getTime();
        if (!Number.isNaN(last) && Date.now() - last < NAG_COOLDOWN_MIN * 60_000) {
          continue;
        }
      }

      console.log(`[azure-pr-review] Nagging about failed review: ${task.summary}`);
      const failReason = result ? result.slice(0, 200) : 'Unknown reason';
      notify({
        ...task,
        summary: `FAILED: ${task.summary} — ${failReason}`,
        priority: 'high',
      }, 'sticky');
      await updateLastNotified(task.id);
    }
  } catch (err) {
    console.warn(`[azure-pr-review] failed-review check error: ${err.message}`);
  }

  console.log(`[azure-pr-review] Done. prs=${prs.length} checked=${checked} created=${created} skipped=${skipped} inFlight=${inFlight}`);
  return { total: prs.length, checked, created, skipped, inFlight };
}
