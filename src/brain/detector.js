/**
 * SEAL Brain — pattern detector (v0.4.0 "SEAL notices")
 *
 * Two detectors on day one, both specified in AGENT-SYSTEM-DESIGN.md §3.2:
 *   - sequence: "within 10 minutes of event A, event B happens, >=80% of the time"
 *   - naming:   "branch/tag names match <regex> in recent history"
 *
 * No ML, no embeddings. Just scans of the events table written by the
 * v0.3.0 Eye layer. Writes candidates into `patterns` via upsertPattern().
 *
 * Promotion rule (design doc):
 *   confidence >= 0.75 AND evidence_count >= 3 AND state == 'observing'
 * The promotion itself happens in v0.5.0's proposal engine — this module
 * only stores observations.
 */

import crypto from 'node:crypto';
import { db, upsertPattern, listPatterns } from '../db.js';

// ─── Tunables ─────────────────────────────────────────

const SEQUENCE_WINDOW_MS = 10 * 60 * 1000;   // §3.2.1 "within 10 minutes"
const SEQUENCE_MIN_SUPPORT = 3;              // §3.2.1 "count(A) >= 3"
const SEQUENCE_MIN_CONFIDENCE = 0.8;         // §3.2.1 "P(B | A) > 0.8"
const NAMING_LOOKBACK = 50;                  // §3.2.1 "last 50"
const NAMING_MIN_MATCH_RATIO = 0.8;          // §3.2.1 "matches 80% of recent names"
const SLOW_PATH_INTERVAL_MS = 15 * 60 * 1000; // §3.2.3 "every 15 minutes"

// ─── Branch / tag naming regex library ────────────────
// Small, explicit, and tuned for the patterns the design doc calls out by
// name. Each entry's regex is the stored signature; `label` is display-only.

const NAMING_LIBRARY = [
  {
    field: 'branch',
    label: 'feature/<project>-<number>-<desc>',
    regex: /^feature\/[A-Z][A-Z0-9]+-\d+-[a-z0-9-]+$/i,
  },
  {
    field: 'branch',
    label: 'feature/<desc>',
    regex: /^feature\/[a-z0-9-]+$/i,
  },
  {
    field: 'branch',
    label: 'fix/<project>-<number>-<desc>',
    regex: /^fix\/[A-Z][A-Z0-9]+-\d+-[a-z0-9-]+$/i,
  },
  {
    field: 'branch',
    label: 'hotfix/<desc>',
    regex: /^hotfix\/[a-z0-9-]+$/i,
  },
  {
    field: 'branch',
    label: 'release/<semver>',
    regex: /^release\/\d+\.\d+\.\d+$/,
  },
  {
    field: 'branch',
    label: 'chore/<desc>',
    regex: /^chore\/[a-z0-9-]+$/i,
  },
  {
    field: 'tag',
    label: 'v<semver>',
    regex: /^v\d+\.\d+\.\d+$/,
  },
  {
    field: 'tag',
    label: 'v<semver>-<prerelease>',
    regex: /^v\d+\.\d+\.\d+-[a-z0-9.]+$/i,
  },
  {
    field: 'tag',
    label: 'release-<date>',
    regex: /^release-\d{4}-\d{2}-\d{2}$/,
  },
];

// ─── Public API ───────────────────────────────────────

/**
 * Run the full slow-path scan. Safe to call on a timer or on demand.
 * Errors are swallowed per-detector so a bad run never takes down the
 * daemon.
 */
export async function runDetectors() {
  const results = { sequence: 0, naming: 0, message: 0, workflow: 0, errors: [] };

  try {
    results.sequence = await detectSequences();
  } catch (err) {
    console.warn('[brain] sequence detector error:', err.message);
    results.errors.push({ detector: 'sequence', error: err.message });
  }

  try {
    results.naming = await detectNamingPatterns();
  } catch (err) {
    console.warn('[brain] naming detector error:', err.message);
    results.errors.push({ detector: 'naming', error: err.message });
  }

  try {
    results.message = await detectCommitMessagePatterns();
  } catch (err) {
    console.warn('[brain] message detector error:', err.message);
    results.errors.push({ detector: 'message', error: err.message });
  }

  try {
    results.workflow = await detectWorkflowPatterns();
  } catch (err) {
    console.warn('[brain] workflow detector error:', err.message);
    results.errors.push({ detector: 'workflow', error: err.message });
  }

  return results;
}

/**
 * Start the background scheduler. Returns a stop() function so tests
 * and graceful-shutdown paths can cancel the interval.
 */
export function startDetectorLoop() {
  const timer = setInterval(() => {
    runDetectors()
      .then((r) => {
        const total = (r.sequence || 0) + (r.naming || 0);
        if (total > 0) {
          console.log(`[brain] detector tick: ${r.sequence} sequence, ${r.naming} naming`);
        }
      })
      .catch((err) => console.warn('[brain] detector tick failed:', err.message));
  }, SLOW_PATH_INTERVAL_MS);
  if (timer.unref) timer.unref();

  // First run after 10s so boot isn't blocked but we don't wait 15m
  // before the first pattern scan.
  const kickoff = setTimeout(() => {
    runDetectors().catch((err) => console.warn('[brain] initial detector scan failed:', err.message));
  }, 10_000);
  if (kickoff.unref) kickoff.unref();

  console.log('[brain] detector loop started (slow path every 15m)');

  return () => {
    clearInterval(timer);
    clearTimeout(kickoff);
  };
}

// ─── Sequence detector ────────────────────────────────
//
// For every (source, kind) pair A observed recently, count how often
// each (source, kind) pair B follows within SEQUENCE_WINDOW_MS. If any
// P(B|A) clears SEQUENCE_MIN_CONFIDENCE with at least SEQUENCE_MIN_SUPPORT
// observations of A, upsert a sequence pattern.
//
// "Trivial" pairs (same kind, known-boring chains like branch→commit)
// are NOT filtered here — the proposal engine later decides what's
// worth surfacing. The detector stays dumb.

async function detectSequences() {
  const rows = await db.all(`
    SELECT id, source, kind, timestamp
    FROM events
    ORDER BY timestamp ASC
    LIMIT 2000
  `);
  if (!rows || rows.length < 2) return 0;

  // Count occurrences of each A and the count of each (A, B) follow.
  const countA = new Map();
  const countAB = new Map();

  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    const keyA = `${a.source}:${a.kind}`;
    countA.set(keyA, (countA.get(keyA) || 0) + 1);

    const aMs = Date.parse(a.timestamp);
    if (!Number.isFinite(aMs)) continue;

    // Walk forward until we exit the 10-minute window. Dedup B kinds so
    // one A doesn't double-count the same B kind firing twice.
    const seenBKinds = new Set();
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      const bMs = Date.parse(b.timestamp);
      if (!Number.isFinite(bMs)) continue;
      if (bMs - aMs > SEQUENCE_WINDOW_MS) break;
      // Cross-source follow-ups are interesting too (git → calendar etc.)
      const keyB = `${b.source}:${b.kind}`;
      if (seenBKinds.has(keyB)) continue;
      seenBKinds.add(keyB);
      const pair = `${keyA}→${keyB}`;
      countAB.set(pair, (countAB.get(pair) || 0) + 1);
    }
  }

  let upserts = 0;
  for (const [pair, count] of countAB.entries()) {
    const [keyA] = pair.split('→');
    const supportA = countA.get(keyA) || 0;
    if (supportA < SEQUENCE_MIN_SUPPORT) continue;
    const confidence = count / supportA;
    if (confidence < SEQUENCE_MIN_CONFIDENCE) continue;

    const signature = `sequence:${pair}`;
    const id = hashId(signature);
    await upsertPattern({
      id,
      kind: 'sequence',
      signature,
      evidenceCount: count,
      confidence,
      metadata: {
        a: keyA,
        b: pair.split('→')[1],
        window_ms: SEQUENCE_WINDOW_MS,
        support_a: supportA,
      },
    });
    upserts++;
  }
  return upserts;
}

// ─── Naming detector ──────────────────────────────────
//
// Pull the most recent NAMING_LOOKBACK branch-created and tag-created
// events, extract their names, and try each regex in NAMING_LIBRARY.
// A regex that matches ≥ NAMING_MIN_MATCH_RATIO of the sample becomes
// a naming pattern.

async function detectNamingPatterns() {
  const rows = await db.all(`
    SELECT id, kind, timestamp, data
    FROM events
    WHERE kind IN ('git.branch.created', 'git.tag.created')
    ORDER BY timestamp DESC
    LIMIT ?
  `, [NAMING_LOOKBACK]);
  if (!rows || rows.length < 3) return 0;

  const branches = [];
  const tags = [];
  for (const r of rows) {
    let data = {};
    try { data = JSON.parse(r.data); } catch { /* ignore */ }
    const name = extractName(data);
    if (!name) continue;
    if (r.kind === 'git.branch.created') branches.push(name);
    else if (r.kind === 'git.tag.created') tags.push(name);
  }

  let upserts = 0;

  for (const entry of NAMING_LIBRARY) {
    const sample = entry.field === 'branch' ? branches : tags;
    if (sample.length < 3) continue;

    const matches = sample.filter((n) => entry.regex.test(n));
    const ratio = matches.length / sample.length;
    if (ratio < NAMING_MIN_MATCH_RATIO) continue;

    const signature = `naming:${entry.field}:${entry.regex.source}`;
    const id = hashId(signature);
    await upsertPattern({
      id,
      kind: 'naming',
      signature,
      evidenceCount: matches.length,
      confidence: ratio,
      metadata: {
        field: entry.field,
        label: entry.label,
        regex: entry.regex.source,
        examples: matches.slice(0, 5),
        sample_size: sample.length,
      },
    });
    upserts++;
  }
  return upserts;
}

// ─── Helpers ──────────────────────────────────────────

function extractName(data) {
  if (!data || typeof data !== 'object') return null;
  // GitObserver normalizes branch/tag names under a handful of keys;
  // accept any of the common ones.
  return data.name || data.branch || data.ref || data.tag || null;
}

function hashId(signature) {
  return crypto.createHash('sha1').update(signature).digest('hex').slice(0, 12);
}

// ─── Commit message pattern detector ──────────────────
//
// Scans recent git.commit events for recurring commit-message shapes:
//   - Conventional commits (feat:, fix:, chore:, refactor:, etc.)
//   - Ticket references (PROJ-123, #456)
//   - Author-specific habits (who commits what kind of work)
//
// These are "naming patterns for messages" — the same 80%-match
// threshold applies, but the field is the commit message instead of
// the branch name.

const MESSAGE_LOOKBACK = 100;
const MESSAGE_MIN_MATCH_RATIO = 0.6; // lower than naming because messages are noisier

const MESSAGE_PATTERNS = [
  {
    label: 'conventional commit (type: subject)',
    regex: /^(feat|fix|chore|refactor|docs|test|style|perf|ci|build|revert)(\(.+?\))?!?:\s/i,
  },
  {
    label: 'conventional commit with scope',
    regex: /^(feat|fix|chore|refactor|docs|test|style|perf|ci|build|revert)\(.+?\):\s/i,
  },
  {
    label: 'ticket reference in message (PROJ-NNN)',
    regex: /[A-Z]{2,}-\d+/,
  },
  {
    label: 'GitHub issue reference (#NNN)',
    regex: /#\d+/,
  },
  {
    label: 'merge commit',
    regex: /^Merge (branch|pull request|remote-tracking)/i,
  },
];

async function detectCommitMessagePatterns() {
  const rows = await db.all(`
    SELECT id, kind, timestamp, data
    FROM events
    WHERE kind = 'git.commit'
    ORDER BY timestamp DESC
    LIMIT ?
  `, [MESSAGE_LOOKBACK]);
  if (!rows || rows.length < 5) return 0;

  const messages = [];
  const authorStats = new Map();
  for (const r of rows) {
    let data = {};
    try { data = JSON.parse(r.data); } catch { continue; }
    if (data.message) messages.push(data.message);
    // Track per-author commit shape distribution for team insights
    const email = data.author_email;
    if (email) {
      if (!authorStats.has(email)) authorStats.set(email, { total: 0, types: {} });
      const stat = authorStats.get(email);
      stat.total++;
      const typeMatch = data.message?.match(/^(\w+)(?:\(.*?\))?:/);
      if (typeMatch) {
        const type = typeMatch[1].toLowerCase();
        stat.types[type] = (stat.types[type] || 0) + 1;
      }
    }
  }

  let upserts = 0;

  for (const entry of MESSAGE_PATTERNS) {
    const matches = messages.filter((m) => entry.regex.test(m));
    const ratio = matches.length / messages.length;
    if (ratio < MESSAGE_MIN_MATCH_RATIO) continue;

    const signature = `naming:message:${entry.regex.source}`;
    const id = hashId(signature);
    await upsertPattern({
      id,
      kind: 'naming',
      signature,
      evidenceCount: matches.length,
      confidence: ratio,
      metadata: {
        field: 'commit_message',
        label: entry.label,
        regex: entry.regex.source,
        examples: matches.slice(0, 5),
        sample_size: messages.length,
      },
    });
    upserts++;
  }

  // Author activity pattern: if any author has >10 commits, surface
  // their type distribution as a usage-kind pattern the proposer can read.
  for (const [email, stat] of authorStats.entries()) {
    if (stat.total < 5) continue;
    const topTypes = Object.entries(stat.types)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    if (topTypes.length === 0) continue;

    const signature = `usage:author:${email}`;
    const id = hashId(signature);
    await upsertPattern({
      id,
      kind: 'usage',
      signature,
      evidenceCount: stat.total,
      confidence: 1.0,
      metadata: {
        field: 'author_activity',
        author_email: email,
        commit_count: stat.total,
        type_distribution: Object.fromEntries(topTypes),
      },
    });
    upserts++;
  }

  return upserts;
}

// ─── Workflow (multi-step sequence) detector ──────────
//
// Extends the 2-step sequence detector to find 3-step and 4-step
// chains that represent developer workflows. Examples:
//   git.checkout → git.merge → git.commit → git.push  (pull-rebase-push)
//   git.checkout → git.branch.created → git.commit     (start feature)
//   git.rebase → git.commit → git.push                 (rebase-and-ship)
//
// Algorithm: slide a window of 3-4 events (within WORKFLOW_WINDOW_MS),
// extract the kind chain, count occurrences, emit as a sequence pattern
// with the full chain in metadata.

const WORKFLOW_WINDOW_MS = 15 * 60 * 1000; // 15 minutes for multi-step
const WORKFLOW_MIN_SUPPORT = 2;
const WORKFLOW_MIN_CONFIDENCE = 0.7;

async function detectWorkflowPatterns() {
  const rows = await db.all(`
    SELECT id, source, kind, timestamp
    FROM events
    WHERE source = 'git'
    ORDER BY timestamp ASC
    LIMIT 2000
  `);
  if (!rows || rows.length < 4) return 0;

  // Count 3-step and 4-step chains within the window.
  const chains3 = new Map();
  const chains4 = new Map();

  for (let i = 0; i < rows.length - 2; i++) {
    const a = rows[i];
    const aMs = Date.parse(a.timestamp);
    if (!Number.isFinite(aMs)) continue;

    const b = rows[i + 1];
    const bMs = Date.parse(b.timestamp);
    if (!Number.isFinite(bMs) || bMs - aMs > WORKFLOW_WINDOW_MS) continue;

    const c = rows[i + 2];
    const cMs = Date.parse(c.timestamp);
    if (!Number.isFinite(cMs) || cMs - aMs > WORKFLOW_WINDOW_MS) continue;

    const key3 = `${a.kind}→${b.kind}→${c.kind}`;
    chains3.set(key3, (chains3.get(key3) || 0) + 1);

    if (i + 3 < rows.length) {
      const d = rows[i + 3];
      const dMs = Date.parse(d.timestamp);
      if (Number.isFinite(dMs) && dMs - aMs <= WORKFLOW_WINDOW_MS) {
        const key4 = `${key3}→${d.kind}`;
        chains4.set(key4, (chains4.get(key4) || 0) + 1);
      }
    }
  }

  let upserts = 0;

  // Emit interesting chains. Skip boring ones (all same kind, purely
  // commit sequences).
  const allChains = [...chains3.entries(), ...chains4.entries()];
  for (const [chain, count] of allChains) {
    if (count < WORKFLOW_MIN_SUPPORT) continue;
    const steps = chain.split('→');
    // Skip if all steps are the same kind (e.g., commit→commit→commit)
    if (new Set(steps).size === 1) continue;

    const signature = `workflow:${chain}`;
    const id = hashId(signature);
    await upsertPattern({
      id,
      kind: 'sequence',
      signature,
      evidenceCount: count,
      confidence: Math.min(count / 3, 1.0), // normalize to 1.0 at 3 occurrences
      metadata: {
        workflow: true,
        steps,
        step_count: steps.length,
        window_ms: WORKFLOW_WINDOW_MS,
      },
    });
    upserts++;
  }

  return upserts;
}

// Re-export for convenience so callers can import everything from `brain/detector.js`.
export { listPatterns };
