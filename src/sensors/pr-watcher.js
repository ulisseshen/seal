import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { insertTask, searchTasks } from '../db.js';

const execFileP = promisify(execFile);

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function genId() {
  return 'seal_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Poll `gh pr list` for PRs that need our review. For each PR updated
 * in the last 24h, create a SEAL reminder if one doesn't already exist.
 *
 * Graceful: logs warnings and returns if `gh` is missing or the command fails.
 */
export async function runPrWatcher() {
  let out;
  try {
    const res = await execFileP('gh', [
      'pr', 'list',
      '--search', 'is:open review-requested:@me',
      '--json', 'number,title,url,updatedAt',
      '--limit', '50',
    ], { timeout: 30_000 });
    out = res.stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('[pr-watcher] gh CLI not installed — skipping');
      return { skipped: true, reason: 'gh-missing' };
    }
    console.warn(`[pr-watcher] gh failed: ${err.message.slice(0, 200)}`);
    return { skipped: true, reason: 'gh-error', error: err.message };
  }

  let prs;
  try {
    prs = JSON.parse(out || '[]');
  } catch (err) {
    console.warn(`[pr-watcher] failed to parse gh output: ${err.message}`);
    return { skipped: true, reason: 'parse-error' };
  }

  const now = Date.now();
  let created = 0;
  let skipped = 0;

  for (const pr of prs) {
    const updated = new Date(pr.updatedAt).getTime();
    if (Number.isNaN(updated)) continue;
    if (now - updated > TWENTY_FOUR_HOURS_MS) {
      skipped++;
      continue;
    }

    const needle = `PR #${pr.number}`;
    try {
      const existing = await searchTasks(needle);
      if (existing && existing.length > 0) {
        skipped++;
        continue;
      }
    } catch (err) {
      console.warn(`[pr-watcher] searchTasks error: ${err.message}`);
      continue;
    }

    const task = {
      id: genId(),
      type: 'reminder',
      summary: `PR #${pr.number} waiting your review: ${pr.title}`,
      detail: pr.url,
      execute_at: new Date().toISOString(),
      recurrence: null,
      next_run: null,
      prompt: null,
      project: null,
      allowed_tools: '[]',
      permission_mode: 'plan',
      notify_type: 'nuclear',
      notify_channel: 'system',
      notify_target: null,
      people: '[]',
      priority: 'medium',
      status: 'pending',
      created: new Date().toISOString(),
      max_runs: null,
    };

    try {
      await insertTask(task);
      // Also tag capabilities — schema supports it after phase 2 migration
      const { db } = await import('../db.js');
      await db.run(`UPDATE tasks SET capabilities = ? WHERE id = ?`, [
        JSON.stringify(['github:pr:read']),
        task.id,
      ]);
      created++;
      console.log(`[pr-watcher] Created reminder for ${needle}: ${pr.title}`);
    } catch (err) {
      console.warn(`[pr-watcher] insert failed for ${needle}: ${err.message}`);
    }
  }

  console.log(`[pr-watcher] Done. created=${created} skipped=${skipped} total=${prs.length}`);
  return { created, skipped, total: prs.length };
}
