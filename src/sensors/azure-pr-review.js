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
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { insertTask, searchTasks } from '../db.js';

const execFileP = promisify(execFile);

// ─── Config (read from env or defaults) ─────────────────
const ORG = process.env.SEAL_AZURE_ORG || 'yandev';
const PROJECT = process.env.SEAL_AZURE_PROJECT || 'SmartSales';
const REPO_ID = process.env.SEAL_AZURE_REPO_ID || 'f25aac20-9d94-441e-8f13-e09b0d56554d';
const MY_EMAIL = (process.env.SEAL_AZURE_MY_EMAIL || 'ulisses.hen@yandeh.com').toLowerCase();
const PAT = process.env.AZURE_DEVOPS_PAT || process.env.AZURE_DEVOPS_EXT_PAT || '';
const API_BASE = `https://dev.azure.com/${ORG}/${PROJECT}/_apis/git/repositories/${REPO_ID}`;
const API_VERSION = 'api-version=7.1';

// The main project directory (used to create worktrees from)
const PROJECT_DIR = process.env.SEAL_AZURE_PROJECT_DIR || '/Users/ulisseshen/projects/prs_smartesales_flutter';
// Worktrees inside the project — claude -p works reliably here because
// .claude/, .mcp.json, and the full environment are in the parent tree.
const WORKTREE_BASE = path.join(PROJECT_DIR, '.seal-worktrees');
const MAX_PARALLEL_REVIEWS = 2; // leave 2 claude slots for interactive use

function genId() {
  return 'seal_' + crypto.randomBytes(4).toString('hex');
}

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

    try {
      const pending = await searchTasks(needle, 'pending');
      const running = await searchTasks(needle, 'running');
      if (pending?.length > 0 || running?.length > 0) continue; // still active
    } catch {}

    // Task is done/failed/acknowledged — remove worktree
    const wtPath = path.join(WORKTREE_BASE, dir);
    try {
      await execFileP('git', ['worktree', 'remove', '--force', wtPath], {
        cwd: PROJECT_DIR,
        timeout: 15_000,
      });
      cleaned++;
      console.log(`[azure-pr-review] Cleaned up worktree: ${wtPath}`);
    } catch (err) {
      console.warn(`[azure-pr-review] Failed to remove worktree ${wtPath}: ${err.message}`);
    }
  }
  return cleaned;
}

// ─── PR eligibility checks ─────────────────────────────

/**
 * Check if I already commented "Revisando" on this PR.
 * Matches by email (uniqueName) since identity API is unreliable with PAT auth.
 */
async function hasMyReviewLock(prId) {
  try {
    const data = await azGet(`/pullRequests/${prId}/threads`);
    for (const thread of data.value || []) {
      for (const comment of thread.comments || []) {
        const authorEmail = (comment.author?.uniqueName || '').toLowerCase();
        if (authorEmail === MY_EMAIL && comment.content?.includes('Revisando')) {
          return true;
        }
      }
    }
  } catch (err) {
    console.warn(`[azure-pr-review] threads check failed for PR ${prId}: ${err.message}`);
    return true; // On error, skip (don't risk double-review)
  }
  return false;
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
  } catch {}

  // Step 1: List active PRs (pure HTTP, 0 tokens)
  let prs;
  try {
    const data = await azGet('/pullRequests?searchCriteria.status=active&$top=50');
    prs = data.value || [];
  } catch (err) {
    console.warn(`[azure-pr-review] list PRs failed: ${err.message}`);
    return { skipped: true, reason: 'list-error', error: err.message };
  }

  // Step 2: Filter and create tasks (up to available slots)
  const slotsAvailable = MAX_PARALLEL_REVIEWS - inFlight;
  let checked = 0;
  let skipped = 0;
  let created = 0;

  for (const pr of prs) {
    if (created >= slotsAvailable) break;

    // Skip my own PRs (match by email)
    const authorEmail = (pr.createdBy?.uniqueName || '').toLowerCase();
    if (authorEmail === MY_EMAIL) { skipped++; continue; }

    // Skip drafts
    if (pr.isDraft) { skipped++; continue; }

    // Skip PRs where I already voted
    const myVote = (pr.reviewers || []).find(r =>
      (r.uniqueName || '').toLowerCase() === MY_EMAIL && r.vote !== 0
    );
    if (myVote) { skipped++; continue; }

    // Skip if a SEAL task already exists for this PR (any status)
    const needle = `smart-review PR #${pr.pullRequestId}`;
    try {
      const existing = await searchTasks(needle);
      if (existing?.length > 0) {
        skipped++;
        continue;
      }
    } catch {}

    // Check for "Revisando" lock comment
    checked++;
    if (await hasMyReviewLock(pr.pullRequestId)) {
      skipped++;
      continue;
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

    const task = {
      id: genId(),
      type: 'task',
      summary: `smart-review PR #${pr.pullRequestId}: ${pr.title}`.slice(0, 80),
      detail: `Auto-created by azure-pr-review sensor. PR: ${prUrl}. Author: ${pr.createdBy?.displayName}. Source: ${sourceBranch}. Worktree: ${wtPath}`,
      execute_at: new Date().toISOString(),
      recurrence: null,
      next_run: null,
      prompt: `Use the Skill tool to invoke skill="smart-review" with args="${prUrl} --auto". Wait for it to complete fully. Do not interrupt or summarize early.`,
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
      await insertTask(task);
      created++;
      console.log(`[azure-pr-review] Created task ${task.id} for PR #${pr.pullRequestId} (worktree: ${wtPath})`);
    } catch (err) {
      console.warn(`[azure-pr-review] insert failed: ${err.message}`);
    }
  }

  console.log(`[azure-pr-review] Done. prs=${prs.length} checked=${checked} created=${created} skipped=${skipped} inFlight=${inFlight}`);
  return { total: prs.length, checked, created, skipped, inFlight };
}
