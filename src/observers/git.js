// Stream C — SEAL v0.3.0 "Eye" layer — GitObserver.
//
// Responsibilities:
//   1. Accept hook payloads from Stream D (POST /api/observe/git) and
//      normalize them into domain events (git.commit, git.branch.created,
//      git.merge, git.push).
//   2. Periodically drain ~/.config/seal/ipc/git/queue.jsonl, the offline
//      queue where hooks write when the SEAL daemon is down.
//   3. Run a fallback scraper every 5 minutes over watched repos —
//      picks up commits missed by hooks and emits git.tag.created
//      (there is no post-tag git hook).
//
// Prime directive: the Eye does not infer. Normalize shape, emit events,
// nothing more. Pattern detection (git.sequence, etc.) is v0.4.0.

import {
  readFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { Observer } from './base.js';
import { queryEvents, listWatchedRepos, db } from '../db.js';

const DEFAULT_IPC_DIR = join(homedir(), '.config', 'seal', 'ipc', 'git');
const SCRAPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DRAIN_INTERVAL_MS = 30 * 1000;       // 30 seconds
const BRANCH_LOOKBACK = 500;               // how far back to scan events when detecting a new branch
const SCRAPE_LOOKBACK = 500;               // how far back to scan when de-duping scraped commits/tags

export class GitObserver extends Observer {
  /**
   * @param {import('../event-bus.js').EventBus} eventBus
   * @param {object} [opts]
   * @param {string} [opts.ipcDir] - override IPC dir (used by tests)
   * @param {number} [opts.drainIntervalMs]
   * @param {number} [opts.scraperIntervalMs]
   */
  constructor(eventBus, opts = {}) {
    super('git', eventBus);
    this.ipcDir = opts.ipcDir || DEFAULT_IPC_DIR;
    this.ipcQueue = join(this.ipcDir, 'queue.jsonl');
    this.drainIntervalMs = opts.drainIntervalMs || DRAIN_INTERVAL_MS;
    this.scraperIntervalMs = opts.scraperIntervalMs || SCRAPER_INTERVAL_MS;
    this.scraperTimer = null;
    this.drainTimer = null;
  }

  async start() {
    mkdirSync(this.ipcDir, { recursive: true });
    this.started = true;

    // Initial drain — pick up anything queued while the daemon was offline.
    await this.drainIpcQueue();

    this.drainTimer = setInterval(() => {
      this.drainIpcQueue().catch((err) =>
        console.warn('[git-observer] drain error:', err.message),
      );
    }, this.drainIntervalMs);
    // Don't keep the event loop alive just for the observer timers.
    if (this.drainTimer.unref) this.drainTimer.unref();

    this.scraperTimer = setInterval(() => {
      this.runFallbackScraper().catch((err) =>
        console.warn('[git-observer] scraper error:', err.message),
      );
    }, this.scraperIntervalMs);
    if (this.scraperTimer.unref) this.scraperTimer.unref();

    console.log(
      `[git-observer] started (drain every ${Math.round(this.drainIntervalMs / 1000)}s, ` +
      `scraper every ${Math.round(this.scraperIntervalMs / 1000)}s)`,
    );
  }

  async stop() {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.scraperTimer) {
      clearInterval(this.scraperTimer);
      this.scraperTimer = null;
    }
    await super.stop();
  }

  /**
   * Called by POST /api/observe/git (wired through setGitIngester).
   * Accepts a parsed hook payload and emits zero or one normalized events.
   *
   * Contract (frozen by Stream D):
   *   { repo_path, repo_name, hook, timestamp, data: { ... } }
   */
  async ingestHookPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!payload.repo_path || !payload.hook) return;

    const {
      repo_path,
      repo_name,
      hook,
      timestamp,
      data = {},
    } = payload;
    const repoLabel = repo_name || repo_path;

    switch (hook) {
      case 'post-commit':
        this.emit({
          kind: 'git.commit',
          timestamp,
          data: {
            repo: repoLabel,
            repo_path,
            branch: data.branch || '',
            sha: data.sha || '',
            message: data.message || '',
            author_name: data.author_name || '',
            author_email: data.author_email || '',
          },
        });
        return;

      case 'post-checkout': {
        const isBranch = data.is_branch === '1' || data.is_branch === 1;
        const prev = data.prev_head || '';
        const next = data.new_head || '';
        if (!isBranch) return;        // file checkout — ignore
        if (prev === next) return;    // no-op checkout — ignore
        const branch = data.branch || '';
        if (!branch) return;          // detached / unknown — ignore
        const isNew = await this.isBranchNew(repo_path, branch);
        if (!isNew) return;
        this.emit({
          kind: 'git.branch.created',
          timestamp,
          data: {
            repo: repoLabel,
            repo_path,
            name: branch,
            base: null, // not reliably knowable from a post-checkout alone
          },
        });
        return;
      }

      case 'post-merge':
        this.emit({
          kind: 'git.merge',
          timestamp,
          data: {
            repo: repoLabel,
            repo_path,
            branch: data.branch || '',
            merge_head: data.merge_head || '',
            squash: data.squash === '1' || data.squash === 1,
          },
        });
        return;

      case 'pre-push':
        this.emit({
          kind: 'git.push',
          timestamp,
          data: {
            repo: repoLabel,
            repo_path,
            branch: data.branch || '',
            remote: data.remote || '',
          },
        });
        return;

      default:
        console.warn(`[git-observer] unknown hook type: ${hook}`);
        return;
    }
  }

  /**
   * Heuristic: is this branch name new? (Never seen before by SEAL for this repo.)
   *
   * Stream A's queryEvents does not filter on data fields, so we pull the
   * recent slice of git events and scan in JS. Good enough for v0.3.0 —
   * robust pattern detection lives in v0.4.0.
   */
  async isBranchNew(repoPath, branchName) {
    const recent = await queryEvents({ source: 'git', limit: BRANCH_LOOKBACK });
    for (const evt of recent) {
      const d = evt.data;
      if (!d) continue;
      if (d.repo_path !== repoPath) continue;
      if (evt.kind === 'git.branch.created' && d.name === branchName) return false;
      if (
        (evt.kind === 'git.commit' || evt.kind === 'git.push') &&
        d.branch === branchName
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Drain the filesystem IPC queue. Atomic swap: rename the queue aside so
   * hooks writing concurrently don't lose writes, then process the staging
   * file, then delete it.
   *
   * Lines that fail to parse are logged and skipped — one bad line must not
   * poison the whole queue.
   */
  async drainIpcQueue() {
    const swapPath = this.ipcQueue + '.draining';

    // If a previous drain crashed mid-process, reuse the leftover staging file.
    if (!existsSync(swapPath)) {
      if (!existsSync(this.ipcQueue)) return;
      try {
        renameSync(this.ipcQueue, swapPath);
      } catch (err) {
        if (err.code === 'ENOENT') return; // race with another drain — fine
        console.warn('[git-observer] drain rename failed:', err.message);
        return;
      }
    }

    let contents = '';
    try {
      contents = readFileSync(swapPath, 'utf8');
    } catch (err) {
      console.warn('[git-observer] drain read failed:', err.message);
      return;
    }

    const lines = contents.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (err) {
        console.warn('[git-observer] failed to parse IPC line:', err.message);
        continue;
      }
      try {
        await this.ingestHookPayload(payload);
      } catch (err) {
        console.warn('[git-observer] failed to ingest IPC payload:', err.message);
      }
    }

    // Success — remove the staging file.
    try {
      unlinkSync(swapPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[git-observer] drain cleanup failed:', err.message);
      }
    }
  }

  /**
   * Fallback scraper — runs every 5 minutes. Iterates watched repos, runs
   * git log since last_scraped_at, emits git.commit events for any new
   * commits, and emits git.tag.created for any new tags.
   */
  async runFallbackScraper() {
    const repos = await listWatchedRepos();
    for (const repo of repos) {
      try {
        await this.scrapeRepo(repo);
      } catch (err) {
        console.warn(
          `[git-observer] scrape failed for ${repo.path}:`,
          err.message,
        );
      }
    }
  }

  async scrapeRepo(repo) {
    if (!repo || !repo.path) return;

    const since = repo.last_scraped_at || null;
    const sinceArg = since
      ? `--since="${since.replace(/"/g, '\\"')}"`
      : '--max-count=50';

    // ─── Commits ───────────────────────────────
    // %H=sha, %D=refs, %an=author name, %ae=author email, %aI=author date, %s=subject
    const logCmd =
      `git -C "${repo.path}" log --all ${sinceArg} ` +
      `--pretty=format:"%H|%D|%an|%ae|%aI|%s"`;

    let out = '';
    try {
      out = execSync(logCmd, { encoding: 'utf8', timeout: 10000 });
    } catch (err) {
      // Not a git repo, permission error, etc. — skip, don't mutate state.
      return;
    }

    // Pull the de-dup slice ONCE per repo scrape, not once per line.
    const recentCommits = await queryEvents({
      source: 'git',
      kind: 'git.commit',
      limit: SCRAPE_LOOKBACK,
    });
    const seenShas = new Set();
    for (const evt of recentCommits) {
      if (evt.data?.repo_path === repo.path && evt.data?.sha) {
        seenShas.add(evt.data.sha);
      }
    }

    const lines = out.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      // Format: SHA|refs|author_name|author_email|author_date|subject
      const parts = line.split('|');
      if (parts.length < 6) continue;
      const [sha, refs, authorName, authorEmail, authorDate, ...msgParts] = parts;
      const message = msgParts.join('|'); // subject may contain pipes
      if (!sha || seenShas.has(sha)) continue;
      seenShas.add(sha);

      this.emit({
        kind: 'git.commit',
        data: {
          repo: repo.name || repo.path,
          repo_path: repo.path,
          branch: '(scraped)',
          sha,
          message,
          refs: refs || '',
          author_name: authorName || '',
          author_email: authorEmail || '',
          author_date: authorDate || '',
          scraped: true,
        },
      });
    }

    // ─── Tags ──────────────────────────────────
    // Git has no post-tag hook — tags are always the scraper's job.
    try {
      const tagOut = execSync(
        `git -C "${repo.path}" for-each-ref --sort=-creatordate ` +
          `--format="%(refname:short)|%(objectname:short)|%(creatordate:iso8601)" ` +
          `refs/tags`,
        { encoding: 'utf8', timeout: 5000 },
      );
      const tagLines = tagOut
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .slice(0, 100);

      if (tagLines.length > 0) {
        const recentTags = await queryEvents({
          source: 'git',
          kind: 'git.tag.created',
          limit: SCRAPE_LOOKBACK,
        });
        const seenTags = new Set();
        for (const evt of recentTags) {
          if (evt.data?.repo_path === repo.path && evt.data?.name) {
            seenTags.add(evt.data.name);
          }
        }

        for (const line of tagLines) {
          const [name, ref, created] = line.split('|');
          if (!name || seenTags.has(name)) continue;
          seenTags.add(name);
          this.emit({
            kind: 'git.tag.created',
            data: {
              repo: repo.name || repo.path,
              repo_path: repo.path,
              name,
              ref: ref || '',
              created: created || '',
            },
          });
        }
      }
    } catch {
      // no tags / not a git repo — fine
    }

    // ─── Mark repo as scraped ──────────────────
    try {
      await db.run(
        `UPDATE watched_repos SET last_scraped_at = ? WHERE id = ?`,
        [new Date().toISOString(), repo.id],
      );
    } catch (err) {
      console.warn(
        '[git-observer] failed to update last_scraped_at:',
        err.message,
      );
    }
  }
}
