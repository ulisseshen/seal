import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Allow test isolation / custom DB location via SEAL_DB_PATH.
// Production default: ~/.config/seal/tasks.db
const DB_PATH = process.env.SEAL_DB_PATH || path.join(os.homedir(), '.config', 'seal', 'tasks.db');
const DB_DIR = path.dirname(DB_PATH);
fs.mkdirSync(DB_DIR, { recursive: true });

// ─── Mode detection ─────────────────────────────────────
// Default: local SQLite (zero setup)
// Cloud:   SEAL_DB_URL=libsql://your-db.turso.io  SEAL_DB_TOKEN=xxx

const TURSO_URL = process.env.SEAL_DB_URL || '';
const TURSO_TOKEN = process.env.SEAL_DB_TOKEN || '';
const isCloud = TURSO_URL.startsWith('libsql://') || TURSO_URL.startsWith('https://');

let db;

if (isCloud) {
  const turso = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  // Wrap libSQL client into a better-sqlite3-like sync-style API
  // All SEAL db calls are in the polling loop (not hot path), so
  // we use a blocking pattern via top-level await for schema init
  // and return promises from queries that callers await.
  db = {
    isCloud: true,
    exec: (sql) => turso.executeMultiple(sql),
    run: (sql, params = []) => turso.execute({ sql, args: params }),
    get: (sql, params = []) => turso.execute({ sql, args: params }).then(r => {
      if (!r.rows.length) return undefined;
      const obj = {};
      r.columns.forEach((c, i) => { obj[c] = r.rows[0][i]; });
      return obj;
    }),
    all: (sql, params = []) => turso.execute({ sql, args: params }).then(r =>
      r.rows.map(row => {
        const obj = {};
        r.columns.forEach((c, i) => { obj[c] = row[i]; });
        return obj;
      })
    ),
  };
  console.log(`[db] Cloud → ${TURSO_URL.split('.')[0].replace('libsql://', '')}`);
} else {
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Wrap better-sqlite3 to always return promises (same interface as cloud)
  db = {
    isCloud: false,
    exec: (sql) => Promise.resolve(sqlite.exec(sql)),
    run: (sql, params = []) => Promise.resolve(sqlite.prepare(sql).run(...params)),
    get: (sql, params = []) => Promise.resolve(sqlite.prepare(sql).get(...params)),
    all: (sql, params = []) => Promise.resolve(sqlite.prepare(sql).all(...params)),
  };
  console.log(`[db] Local → ${DB_PATH}`);
}

// ─── Schema ─────────────────────────────────────────────

await db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('task','reminder','ritual','deadline','person','decision')),
    summary TEXT NOT NULL,
    detail TEXT,
    execute_at TEXT,
    recurrence TEXT,
    next_run TEXT,
    prompt TEXT,
    project TEXT,
    allowed_tools TEXT DEFAULT '[]',
    permission_mode TEXT DEFAULT 'auto',
    notify_type TEXT DEFAULT 'sound' CHECK(notify_type IN ('silent','sound','sticky','nuclear','supernova')),
    notify_channel TEXT DEFAULT 'system',
    notify_target TEXT,
    last_notified_at TEXT,
    people TEXT DEFAULT '[]',
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','archived','firing','acknowledged')),
    result TEXT,
    created TEXT NOT NULL,
    completed_at TEXT,
    run_count INTEGER DEFAULT 0,
    max_runs INTEGER,
    executor TEXT DEFAULT 'claude' CHECK(executor IN ('claude','shell'))
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_execute_at ON tasks(execute_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run);
`);

  // Migration: add executor column if missing (existing DBs)
  try {
    await db.run(`ALTER TABLE tasks ADD COLUMN executor TEXT DEFAULT 'claude' CHECK(executor IN ('claude','shell'))`);
  } catch {}


// Migration: add notify_target column to existing databases (SQLite doesn't support
// IF NOT EXISTS for ADD COLUMN, so swallow the "duplicate column" error)
try {
  await db.exec(`ALTER TABLE tasks ADD COLUMN notify_target TEXT`);
} catch (err) {
  // Column already exists — that's fine
}

// Migration: capabilities (JSON array of strings, e.g. ["fs:~/projects:write", "shell:*"])
try {
  await db.exec(`ALTER TABLE tasks ADD COLUMN capabilities TEXT DEFAULT '[]'`);
} catch (err) {
  // Column already exists — that's fine
}

// Migration: approved_at (set when a human approves an ack-required task)
try {
  await db.exec(`ALTER TABLE tasks ADD COLUMN approved_at TEXT`);
} catch (err) {
  // Column already exists — that's fine
}

// Audit trail of individual task runs (one task can run many times if recurring)
await db.exec(`
  CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    exit_code INTEGER,
    profile TEXT,
    capabilities TEXT,
    stdout_preview TEXT,
    stderr_preview TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id, started_at);
`);

// ─── v0.3.0 "Eye" tables ────────────────────────────────
// events: mechanical observations from observers (git, calendar, telegram, ...)
// watched_repos: repos SEAL is observing for git activity
await db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_source_kind ON events(source, kind);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS watched_repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    installed_at TEXT NOT NULL,
    hooks_installed INTEGER NOT NULL DEFAULT 0,
    fallback_scraper INTEGER NOT NULL DEFAULT 0,
    last_scraped_at TEXT,
    removed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_watched_repos_active ON watched_repos(removed_at);
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL DEFAULT 'default',
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
`);

// ─── Memory layer (typed durable + ephemeral scratch + FTS5) ───
// Design synthesized from Claude Code (typed frontmatter), Hermes
// (prefetch/sync lifecycle), and OpenClaw (dreaming sweep). See
// docs/AGENT-SYSTEM-DESIGN.md §"Memory Layer" for the rationale.

await db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')),
    name         TEXT NOT NULL,
    description  TEXT NOT NULL,
    content      TEXT NOT NULL,
    project      TEXT,
    source       TEXT NOT NULL DEFAULT 'auto' CHECK(source IN ('explicit','auto','consolidated')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    use_count    INTEGER NOT NULL DEFAULT 0,
    pinned       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_memories_type_project ON memories(type, project);
  CREATE INDEX IF NOT EXISTS idx_memories_last_used ON memories(last_used_at);
  CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned) WHERE pinned = 1;
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS memory_scratch (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    day             TEXT NOT NULL,
    kind            TEXT NOT NULL,
    ref_type        TEXT,
    ref_id          TEXT,
    content         TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    consolidated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_scratch_day ON memory_scratch(day, consolidated_at);
  CREATE INDEX IF NOT EXISTS idx_scratch_kind ON memory_scratch(kind);
`);

// Team model — auto-populated from git author metadata.
// SEAL builds a contributor graph from the events it observes. When a
// new author appears, an ingest_queued alert asks the TL "who is this?"

await db.exec(`
  CREATE TABLE IF NOT EXISTS team_members (
    email          TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    first_seen     TEXT NOT NULL,
    last_seen      TEXT NOT NULL,
    repos          TEXT NOT NULL DEFAULT '[]',
    commit_count   INTEGER NOT NULL DEFAULT 0,
    role           TEXT,
    notes          TEXT,
    is_me          INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_team_members_name ON team_members(name);
`);

// v0.10.0 "SEAL asks back" — ingest loop storage.
// See docs/AGENT-SYSTEM-DESIGN.md §3.9. Two tables:
//  - handler_matchers: indexed match criteria per handler skill,
//    so incoming events don't scan every skill in the db.
//  - ingest_queue: unmatched data waiting for the TL to teach SEAL
//    how to handle it. Becomes a handler skill once the TL approves.

await db.exec(`
  CREATE TABLE IF NOT EXISTS handler_matchers (
    skill_id   TEXT NOT NULL,
    source     TEXT NOT NULL,
    priority   INTEGER NOT NULL DEFAULT 0,
    criteria   TEXT NOT NULL,
    PRIMARY KEY (skill_id, source)
  );
  CREATE INDEX IF NOT EXISTS idx_handler_matchers_source ON handler_matchers(source, priority DESC);
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS ingest_queue (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    source            TEXT NOT NULL,
    received_at       TEXT NOT NULL,
    data              TEXT NOT NULL,
    interpretation    TEXT,
    suggested_actions TEXT,
    suggested_handler TEXT,
    state             TEXT NOT NULL DEFAULT 'pending'
                      CHECK(state IN ('pending','interpreted','taught','ignored','failed')),
    handler_skill_id  TEXT,
    decided_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ingest_state ON ingest_queue(state);
  CREATE INDEX IF NOT EXISTS idx_ingest_source ON ingest_queue(source);
`);

// v0.6.0 "SEAL remembers" — skill factory storage.
// See docs/AGENT-SYSTEM-DESIGN.md §3.5, §6. Approved proposals become
// rows here and get persisted to ~/.config/seal/skills/<name>/ on disk.
// Runs are tracked inline (run_count, success_count, last_run_at) with
// the full jsonl history living next to the script on disk.

await db.exec(`
  CREATE TABLE IF NOT EXISTS skills (
    id               TEXT PRIMARY KEY,
    name             TEXT UNIQUE NOT NULL,
    description      TEXT,
    script_path      TEXT NOT NULL,
    pattern_id       TEXT,
    proposal_id      TEXT,
    parameters       TEXT NOT NULL DEFAULT '[]',
    triggers         TEXT NOT NULL DEFAULT '{"manual":true,"pattern_match":false,"cron":null}',
    requires_ack     INTEGER NOT NULL DEFAULT 0,
    sandbox_profile  TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    last_run_at      TEXT,
    run_count        INTEGER NOT NULL DEFAULT 0,
    success_count    INTEGER NOT NULL DEFAULT 0,
    failure_count    INTEGER NOT NULL DEFAULT 0,
    state            TEXT NOT NULL DEFAULT 'active'
                     CHECK(state IN ('active','dormant','retired'))
  );
  CREATE INDEX IF NOT EXISTS idx_skills_state ON skills(state);
  CREATE INDEX IF NOT EXISTS idx_skills_pattern ON skills(pattern_id);
`);

// v0.5.0 "SEAL proposes" — proposals + decisions (permission gate).
// See docs/AGENT-SYSTEM-DESIGN.md §3.3, §3.4, §6. A proposal is a
// draft automation the Brain wrote from an observing pattern. The
// decisions table is the audit log of every approve/deny/modify so
// future proposals can learn from them (§3.7).

await db.exec(`
  CREATE TABLE IF NOT EXISTS proposals (
    id             TEXT PRIMARY KEY,
    pattern_id     TEXT NOT NULL,
    name           TEXT NOT NULL,
    script         TEXT NOT NULL,
    explanation    TEXT NOT NULL,
    risks          TEXT NOT NULL DEFAULT '[]',
    parameters     TEXT NOT NULL DEFAULT '[]',
    invocation     TEXT,
    provider       TEXT,
    model          TEXT,
    delivered_via  TEXT NOT NULL DEFAULT 'dashboard',
    delivered_at   TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    decision       TEXT,
    decided_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_pattern ON proposals(pattern_id);
  CREATE INDEX IF NOT EXISTS idx_proposals_pending
    ON proposals(decided_at) WHERE decided_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_proposals_expires ON proposals(expires_at);
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS decisions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_id      TEXT NOT NULL,
    proposal_id     TEXT NOT NULL,
    decision        TEXT NOT NULL
                    CHECK(decision IN ('approved_once','approved_saved','modified','denied','suppressed','expired','auto_escalated')),
    original_script TEXT,
    final_script    TEXT,
    user_notes      TEXT,
    decided_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_pattern ON decisions(pattern_id);
  CREATE INDEX IF NOT EXISTS idx_decisions_proposal ON decisions(proposal_id);
`);

// v0.4.0 "SEAL notices" — pattern detector storage.
// See docs/AGENT-SYSTEM-DESIGN.md §3.2.2. The detector writes here,
// the proposal engine (v0.5.0) reads from here, the dashboard renders
// the observing/proposed/active rows.

await db.exec(`
  CREATE TABLE IF NOT EXISTS patterns (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK(kind IN ('sequence','temporal','naming','reaction','usage')),
    signature       TEXT NOT NULL UNIQUE,
    evidence_count  INTEGER NOT NULL DEFAULT 0,
    confidence      REAL NOT NULL DEFAULT 0.0,
    first_seen      TEXT NOT NULL,
    last_seen       TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'observing'
                    CHECK(state IN ('observing','proposed','approved','denied','active','retired')),
    metadata        TEXT NOT NULL DEFAULT '{}',
    proposed_at     TEXT,
    skill_id        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_patterns_state ON patterns(state);
  CREATE INDEX IF NOT EXISTS idx_patterns_kind ON patterns(kind);
  CREATE INDEX IF NOT EXISTS idx_patterns_confidence_observing
    ON patterns(confidence) WHERE state='observing';
`);

// FTS5 is only available on local better-sqlite3; libSQL cloud builds
// disable the extension. Guard the virtual tables behind the mode check.
if (!db.isCloud) {
  await db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      name, description, content,
      content='memories', content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, name, description, content)
      VALUES (new.id, new.name, new.description, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, description, content)
      VALUES ('delete', old.id, old.name, old.description, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, description, content)
      VALUES ('delete', old.id, old.name, old.description, old.content);
      INSERT INTO memories_fts(rowid, name, description, content)
      VALUES (new.id, new.name, new.description, new.content);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
      content,
      content='chat_messages', content_rowid='id',
      tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
    END;
  `);
}

// ─── Public API (all async) ─────────────────────────────

export async function insertTask(task) {
  return db.run(`
    INSERT INTO tasks (id, type, summary, detail, execute_at, recurrence, next_run,
      prompt, project, allowed_tools, permission_mode, notify_type, notify_channel, notify_target,
      people, priority, status, created, max_runs, executor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [task.id, task.type, task.summary, task.detail, task.execute_at, task.recurrence,
      task.next_run, task.prompt, task.project, task.allowed_tools, task.permission_mode,
      task.notify_type, task.notify_channel, task.notify_target || null, task.people, task.priority, task.status,
      task.created, task.max_runs, task.executor || 'claude']);
}

export async function getPendingTasks(limit = 5) {
  return db.all(`
    SELECT * FROM tasks
    WHERE status = 'pending'
      AND (execute_at IS NULL OR datetime(execute_at) <= datetime('now'))
      AND type IN ('task', 'ritual')
      AND prompt IS NOT NULL AND prompt != ''
    ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, execute_at ASC
    LIMIT ?
  `, [limit]);
}

export async function getPendingReminders() {
  return db.all(`
    SELECT * FROM tasks WHERE status = 'pending' AND type = 'reminder' AND datetime(execute_at) <= datetime('now')
  `);
}

export async function getFiringSupernova() {
  return db.all(`
    SELECT * FROM tasks WHERE status = 'firing' AND notify_type = 'supernova'
      AND (last_notified_at IS NULL OR datetime(last_notified_at, '+5 minutes') <= datetime('now'))
  `);
}

export async function getRunningCount() {
  const row = await db.get(`SELECT count(*) as count FROM tasks WHERE status = 'running'`);
  return row?.count || 0;
}

export async function updateStatus(id, status, result = null) {
  return db.run(`
    UPDATE tasks SET status = ?, result = ?,
      completed_at = CASE WHEN ? IN ('done','failed','acknowledged') THEN datetime('now') ELSE completed_at END
    WHERE id = ?
  `, [status, result, status, id]);
}

export async function setFiring(id) {
  return db.run(`UPDATE tasks SET status = 'firing', last_notified_at = datetime('now') WHERE id = ?`, [id]);
}

export async function updateLastNotified(id) {
  return db.run(`UPDATE tasks SET last_notified_at = datetime('now') WHERE id = ?`, [id]);
}

export async function acknowledgeBySearch(search) {
  return db.run(`
    UPDATE tasks SET status = 'acknowledged', completed_at = datetime('now')
    WHERE (status = 'firing' OR status = 'pending') AND (summary LIKE ? OR id = ?)
  `, [`%${search}%`, search]);
}

export async function advanceRecurring(id, nextRun) {
  return db.run(`
    UPDATE tasks SET status = 'pending', execute_at = ?, next_run = ?, run_count = run_count + 1, result = NULL
    WHERE id = ?
  `, [nextRun, nextRun, id]);
}

export async function checkMaxRuns(id) {
  const task = await db.get(`SELECT run_count, max_runs FROM tasks WHERE id = ?`, [id]);
  return task && task.max_runs && task.run_count >= task.max_runs;
}

export async function searchTasks(query, statusFilter = null) {
  let sql = `SELECT * FROM tasks WHERE (summary LIKE ? OR detail LIKE ? OR people LIKE ?)`;
  const params = [`%${query}%`, `%${query}%`, `%${query}%`];
  if (statusFilter) { sql += ` AND status = ?`; params.push(statusFilter); }
  sql += ` ORDER BY created DESC LIMIT 50`;
  return db.all(sql, params);
}

export async function listActive() {
  return db.all(`
    SELECT * FROM tasks WHERE status IN ('pending', 'running', 'firing')
    ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, execute_at ASC
  `);
}

export async function getTaskById(id) {
  return db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
}

// ─── Task run audit log ─────────────────────────────────

export async function insertTaskRun(row) {
  const res = await db.run(`
    INSERT INTO task_runs (task_id, started_at, profile, capabilities)
    VALUES (?, ?, ?, ?)
  `, [
    row.task_id,
    row.started_at,
    row.profile || null,
    row.capabilities || null,
  ]);
  // better-sqlite3 returns lastInsertRowid; libsql returns lastInsertRowid too
  return res?.lastInsertRowid ?? res?.lastInsertRowId ?? null;
}

export async function finishTaskRun(id, { exit_code, finished_at, stdout_preview, stderr_preview }) {
  if (id == null) return;
  return db.run(`
    UPDATE task_runs
    SET finished_at = ?, exit_code = ?, stdout_preview = ?, stderr_preview = ?
    WHERE id = ?
  `, [
    finished_at || new Date().toISOString(),
    exit_code ?? null,
    (stdout_preview || '').slice(0, 4000),
    (stderr_preview || '').slice(0, 4000),
    id,
  ]);
}

export async function getRecentRuns(taskId, limit = 10) {
  return db.all(`
    SELECT * FROM task_runs WHERE task_id = ?
    ORDER BY started_at DESC LIMIT ?
  `, [taskId, limit]);
}

// ─── Policy approval ────────────────────────────────────

export async function approveTask(id) {
  return db.run(`
    UPDATE tasks SET status = 'pending', approved_at = datetime('now')
    WHERE id = ?
  `, [id]);
}

// ─── v0.3.0: events (Eye layer) ─────────────────────────
// Mechanical observation log. Inserts are fire-and-forget — observers
// (Stream B) call insertEvent without awaiting the result. A DB write
// failure must NEVER bubble up and crash an observer.

export async function insertEvent({ source, kind, timestamp, data }) {
  try {
    if (!source || !kind) {
      console.error('[db] insertEvent: source and kind are required');
      return null;
    }
    let payload;
    try {
      payload = JSON.stringify(data ?? {});
    } catch (err) {
      console.error('[db] insertEvent: failed to serialize data —', err.message);
      return null;
    }
    const ts = timestamp || new Date().toISOString();
    const res = await db.run(`
      INSERT INTO events (source, kind, timestamp, data)
      VALUES (?, ?, ?, ?)
    `, [source, kind, ts, payload]);
    return res?.lastInsertRowid ?? res?.lastInsertRowId ?? null;
  } catch (err) {
    console.error('[db] insertEvent failed —', err.message);
    return null;
  }
}

export async function queryEvents({ source, kind, since, until, limit } = {}) {
  const clauses = [];
  const params = [];
  if (source) { clauses.push(`source = ?`); params.push(source); }
  if (kind)   { clauses.push(`kind = ?`);   params.push(kind); }
  if (since)  { clauses.push(`timestamp >= ?`); params.push(since); }
  if (until)  { clauses.push(`timestamp <= ?`); params.push(until); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const clamped = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
  const rows = await db.all(`
    SELECT id, source, kind, timestamp, data FROM events
    ${where}
    ORDER BY timestamp DESC
    LIMIT ?
  `, [...params, clamped]);
  return (rows || []).map(r => {
    let parsed = null;
    try { parsed = JSON.parse(r.data); } catch { parsed = null; }
    return { ...r, data: parsed };
  });
}

// ─── v0.3.0: watched_repos ──────────────────────────────
// Repos SEAL is actively observing. Soft-delete (removed_at) preserves
// historical event references after a repo is removed.

export async function addWatchedRepo({ path: repoPath, name, hooksInstalled = false, fallbackScraper = false }) {
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('addWatchedRepo: path is required');
  }
  if (!path.isAbsolute(repoPath)) {
    throw new Error(`addWatchedRepo: path must be absolute, got "${repoPath}"`);
  }
  const displayName = name || path.basename(repoPath);
  const now = new Date().toISOString();
  const hooksFlag = hooksInstalled ? 1 : 0;
  const scraperFlag = fallbackScraper ? 1 : 0;

  const existing = await db.get(`SELECT * FROM watched_repos WHERE path = ?`, [repoPath]);

  if (existing) {
    if (existing.removed_at != null) {
      // Un-delete: clear removed_at, refresh installed_at and flags.
      await db.run(`
        UPDATE watched_repos
        SET removed_at = NULL,
            installed_at = ?,
            name = ?,
            hooks_installed = ?,
            fallback_scraper = ?
        WHERE path = ?
      `, [now, displayName, hooksFlag, scraperFlag, repoPath]);
    } else {
      // Active row — just update flags (and name if provided).
      await db.run(`
        UPDATE watched_repos
        SET name = ?,
            hooks_installed = ?,
            fallback_scraper = ?
        WHERE path = ?
      `, [displayName, hooksFlag, scraperFlag, repoPath]);
    }
  } else {
    await db.run(`
      INSERT INTO watched_repos (path, name, installed_at, hooks_installed, fallback_scraper)
      VALUES (?, ?, ?, ?, ?)
    `, [repoPath, displayName, now, hooksFlag, scraperFlag]);
  }

  return db.get(`SELECT * FROM watched_repos WHERE path = ?`, [repoPath]);
}

export async function removeWatchedRepo(repoPath) {
  if (!repoPath) return false;
  const now = new Date().toISOString();
  const res = await db.run(`
    UPDATE watched_repos SET removed_at = ?
    WHERE path = ? AND removed_at IS NULL
  `, [now, repoPath]);
  // better-sqlite3 → res.changes; libsql → res.rowsAffected
  const changes = res?.changes ?? res?.rowsAffected ?? 0;
  return changes > 0;
}

export async function listWatchedRepos({ includeRemoved = false } = {}) {
  if (includeRemoved) {
    return db.all(`SELECT * FROM watched_repos ORDER BY installed_at DESC`);
  }
  return db.all(`
    SELECT * FROM watched_repos
    WHERE removed_at IS NULL
    ORDER BY installed_at DESC
  `);
}

export async function getWatchedRepoByPath(repoPath) {
  if (!repoPath) return null;
  const row = await db.get(`SELECT * FROM watched_repos WHERE path = ?`, [repoPath]);
  return row || null;
}

// ─── Memory queries ────────────────────────────────────
// Typed durable memories + ephemeral scratch + FTS5 recall.

export async function insertMemory({ type, name, description, content, project = null, source = 'auto' }) {
  const now = Date.now();
  return db.run(`
    INSERT INTO memories (type, name, description, content, project, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [type, name, description, content, project, source, now, now]);
}

export async function insertScratch({ kind, refType = null, refId = null, content }) {
  const now = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  return db.run(`
    INSERT INTO memory_scratch (day, kind, ref_type, ref_id, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [day, kind, refType, refId, content, now]);
}

export async function searchMemoriesFts(query, limit = 5) {
  if (db.isCloud) return []; // FTS5 local-only
  return db.all(`
    SELECT m.id, m.type, m.name, m.description, m.content, m.project
    FROM memories_fts
    JOIN memories m ON memories_fts.rowid = m.id
    WHERE memories_fts MATCH ?
    ORDER BY bm25(memories_fts)
    LIMIT ?
  `, [query, limit]);
}

export async function searchChatMessagesFts(query, limit = 3) {
  if (db.isCloud) return [];
  return db.all(`
    SELECT cm.id, cm.role, cm.content, cm.session_id, cm.created_at
    FROM chat_messages_fts
    JOIN chat_messages cm ON chat_messages_fts.rowid = cm.id
    WHERE chat_messages_fts MATCH ?
    ORDER BY bm25(chat_messages_fts)
    LIMIT ?
  `, [query, limit]);
}

export async function pinnedMemories(project) {
  if (project) {
    return db.all(`
      SELECT id, type, name, description, content, project
      FROM memories
      WHERE pinned = 1 AND (project IS NULL OR project = ?)
    `, [project]);
  }
  return db.all(`
    SELECT id, type, name, description, content, project
    FROM memories WHERE pinned = 1
  `);
}

export async function touchMemory(id) {
  return db.run(`
    UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?
  `, [Date.now(), id]);
}

export async function listMemories({ type, project, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (type)    { where.push('type = ?');    params.push(type); }
  if (project) { where.push('project = ?'); params.push(project); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);
  return db.all(`
    SELECT id, type, name, description, content, project, source,
           created_at, updated_at, last_used_at, use_count, pinned
    FROM memories ${clause}
    ORDER BY pinned DESC, last_used_at DESC NULLS LAST, created_at DESC
    LIMIT ?
  `, params);
}

// ─── Chat message queries ──────────────────────────────

export async function insertChatMessage({ sessionId = 'default', role, content, provider = null, model = null }) {
  const now = new Date().toISOString();
  return db.run(`
    INSERT INTO chat_messages (session_id, role, content, provider, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [sessionId, role, content, provider, model, now]);
}

export async function listChatMessages({ sessionId = 'default', limit = 100 } = {}) {
  return db.all(`
    SELECT id, session_id, role, content, provider, model, created_at
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY id ASC
    LIMIT ?
  `, [sessionId, limit]);
}

export async function clearChatMessages(sessionId = 'default') {
  return db.run(`DELETE FROM chat_messages WHERE session_id = ?`, [sessionId]);
}

// ─── Pattern detector queries (v0.4.0 "SEAL notices") ───

export async function upsertPattern({ id, kind, signature, evidenceCount, confidence, metadata }) {
  const now = new Date().toISOString();
  const metaStr = JSON.stringify(metadata ?? {});
  // Insert-or-update semantics: new patterns start as "observing",
  // existing rows get their counts/confidence/last_seen refreshed
  // without disturbing state transitions driven by the proposal engine.
  return db.run(`
    INSERT INTO patterns (id, kind, signature, evidence_count, confidence,
                          first_seen, last_seen, state, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'observing', ?)
    ON CONFLICT(signature) DO UPDATE SET
      evidence_count = excluded.evidence_count,
      confidence     = excluded.confidence,
      last_seen      = excluded.last_seen,
      metadata       = excluded.metadata
  `, [id, kind, signature, evidenceCount, confidence, now, now, metaStr]);
}

export async function listPatterns({ state, kind, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (state) { where.push('state = ?'); params.push(state); }
  if (kind)  { where.push('kind = ?');  params.push(kind); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  const rows = await db.all(`
    SELECT id, kind, signature, evidence_count, confidence, state,
           first_seen, last_seen, metadata, proposed_at, skill_id
    FROM patterns ${clause}
    ORDER BY
      CASE state
        WHEN 'proposed' THEN 1
        WHEN 'observing' THEN 2
        WHEN 'active' THEN 3
        WHEN 'approved' THEN 4
        WHEN 'denied' THEN 5
        WHEN 'retired' THEN 6
      END,
      confidence DESC,
      last_seen DESC
    LIMIT ?
  `, params);
  return (rows || []).map((r) => {
    let meta = null;
    try { meta = JSON.parse(r.metadata); } catch { meta = null; }
    return { ...r, metadata: meta };
  });
}

export async function setPatternState(id, state) {
  const now = new Date().toISOString();
  const proposedAt = state === 'proposed' ? now : null;
  return db.run(`
    UPDATE patterns SET state = ?, proposed_at = COALESCE(?, proposed_at)
    WHERE id = ?
  `, [state, proposedAt, id]);
}

export async function getPattern(id) {
  const row = await db.get(`SELECT * FROM patterns WHERE id = ?`, [id]);
  if (!row) return null;
  let meta = null;
  try { meta = JSON.parse(row.metadata); } catch {}
  return { ...row, metadata: meta };
}

// ─── Proposal queries (v0.5.0 "SEAL proposes") ──────────

export async function insertProposal(p) {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + (p.ttl_ms ?? 7 * 24 * 60 * 60 * 1000)).toISOString();
  return db.run(`
    INSERT INTO proposals (id, pattern_id, name, script, explanation, risks, parameters,
                           invocation, provider, model, delivered_via, delivered_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    p.id, p.pattern_id, p.name, p.script, p.explanation,
    JSON.stringify(p.risks ?? []),
    JSON.stringify(p.parameters ?? []),
    p.invocation ?? null, p.provider ?? null, p.model ?? null,
    p.delivered_via ?? 'dashboard', now, expires,
  ]);
}

export async function listProposals({ decided, limit = 100 } = {}) {
  let sql = `SELECT * FROM proposals`;
  const params = [];
  if (decided === false) sql += ` WHERE decided_at IS NULL`;
  else if (decided === true) sql += ` WHERE decided_at IS NOT NULL`;
  sql += ` ORDER BY delivered_at DESC LIMIT ?`;
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  const rows = await db.all(sql, params);
  return (rows || []).map((r) => ({
    ...r,
    risks: safeJson(r.risks, []),
    parameters: safeJson(r.parameters, []),
  }));
}

export async function getProposal(id) {
  const row = await db.get(`SELECT * FROM proposals WHERE id = ?`, [id]);
  if (!row) return null;
  return { ...row, risks: safeJson(row.risks, []), parameters: safeJson(row.parameters, []) };
}

export async function setProposalDecision(id, decision, finalScript = null) {
  const now = new Date().toISOString();
  if (finalScript === null) {
    return db.run(`
      UPDATE proposals SET decision = ?, decided_at = ? WHERE id = ?
    `, [decision, now, id]);
  }
  return db.run(`
    UPDATE proposals SET decision = ?, decided_at = ?, script = ? WHERE id = ?
  `, [decision, now, finalScript, id]);
}

export async function insertDecision(d) {
  const now = new Date().toISOString();
  return db.run(`
    INSERT INTO decisions (pattern_id, proposal_id, decision, original_script, final_script, user_notes, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    d.pattern_id, d.proposal_id, d.decision,
    d.original_script ?? null, d.final_script ?? null, d.user_notes ?? null, now,
  ]);
}

export async function countProposalsCreatedSince(sinceIso) {
  const row = await db.get(`
    SELECT COUNT(*) as c FROM proposals WHERE delivered_at >= ?
  `, [sinceIso]);
  return row?.c ?? 0;
}

export async function expireOldProposals() {
  const now = new Date().toISOString();
  const rows = await db.all(`
    SELECT id, pattern_id, script FROM proposals
    WHERE decided_at IS NULL AND expires_at < ?
  `, [now]);
  for (const r of rows) {
    await db.run(`UPDATE proposals SET decision = 'expired', decided_at = ? WHERE id = ?`, [now, r.id]);
    await db.run(`
      INSERT INTO decisions (pattern_id, proposal_id, decision, original_script, decided_at)
      VALUES (?, ?, 'expired', ?, ?)
    `, [r.pattern_id, r.id, r.script, now]);
    // Pattern returns to observing so the detector can re-promote later.
    await db.run(`UPDATE patterns SET state = 'observing' WHERE id = ?`, [r.pattern_id]);
  }
  return rows.length;
}

function safeJson(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// ─── Skill queries (v0.6.0 "SEAL remembers") ────────────

export async function insertSkill(s) {
  const now = new Date().toISOString();
  return db.run(`
    INSERT INTO skills (id, name, description, script_path, pattern_id, proposal_id,
                        parameters, triggers, requires_ack, sandbox_profile,
                        created_at, updated_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `, [
    s.id, s.name, s.description ?? null, s.script_path,
    s.pattern_id ?? null, s.proposal_id ?? null,
    JSON.stringify(s.parameters ?? []),
    JSON.stringify(s.triggers ?? { manual: true, pattern_match: false, cron: null }),
    s.requires_ack ? 1 : 0,
    s.sandbox_profile ?? null,
    now, now,
  ]);
}

export async function getSkillByName(name) {
  const row = await db.get(`SELECT * FROM skills WHERE name = ?`, [name]);
  if (!row) return null;
  return {
    ...row,
    parameters: safeJson(row.parameters, []),
    triggers: safeJson(row.triggers, { manual: true }),
  };
}

export async function getSkillById(id) {
  const row = await db.get(`SELECT * FROM skills WHERE id = ?`, [id]);
  if (!row) return null;
  return {
    ...row,
    parameters: safeJson(row.parameters, []),
    triggers: safeJson(row.triggers, { manual: true }),
  };
}

export async function listSkills({ state, limit = 100 } = {}) {
  let sql = `SELECT * FROM skills`;
  const params = [];
  if (state) { sql += ` WHERE state = ?`; params.push(state); }
  sql += ` ORDER BY
    CASE state WHEN 'active' THEN 1 WHEN 'dormant' THEN 2 WHEN 'retired' THEN 3 END,
    last_run_at DESC NULLS LAST,
    created_at DESC
    LIMIT ?`;
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  const rows = await db.all(sql, params);
  return (rows || []).map((r) => ({
    ...r,
    parameters: safeJson(r.parameters, []),
    triggers: safeJson(r.triggers, { manual: true }),
  }));
}

export async function recordSkillRun(id, { success }) {
  const now = new Date().toISOString();
  const successInc = success ? 1 : 0;
  const failInc = success ? 0 : 1;
  return db.run(`
    UPDATE skills
    SET run_count = run_count + 1,
        success_count = success_count + ?,
        failure_count = failure_count + ?,
        last_run_at = ?,
        updated_at = ?
    WHERE id = ?
  `, [successInc, failInc, now, now, id]);
}

// ─── Team model queries ─────────────────────────────

export async function upsertTeamMember({ email, name, repo }) {
  const now = new Date().toISOString();
  const reposJson = JSON.stringify(repo ? [repo] : []);
  // Single atomic upsert — no check-then-insert race.
  // On conflict, bump commit_count and merge the repo into the JSON array.
  await db.run(`
    INSERT INTO team_members (email, name, first_seen, last_seen, repos, commit_count)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(email) DO UPDATE SET
      name = CASE WHEN team_members.name = '' OR team_members.name = team_members.email THEN excluded.name ELSE team_members.name END,
      last_seen = excluded.last_seen,
      commit_count = team_members.commit_count + 1
  `, [email, name || email, now, now, reposJson]);

  // Merge repo into the existing repos array (can't do JSON array ops in SQLite easily).
  if (repo) {
    const row = await db.get(`SELECT repos FROM team_members WHERE email = ?`, [email]);
    if (row) {
      let repos = [];
      try { repos = JSON.parse(row.repos); } catch { repos = []; }
      if (!repos.includes(repo)) {
        repos.push(repo);
        await db.run(`UPDATE team_members SET repos = ? WHERE email = ?`, [JSON.stringify(repos), email]);
      }
    }
  }
}

export async function getTeamMember(email) {
  const row = await db.get(`SELECT * FROM team_members WHERE email = ?`, [email]);
  if (!row) return null;
  return { ...row, repos: safeJson(row.repos, []) };
}

export async function listTeamMembers({ limit = 100 } = {}) {
  const rows = await db.all(`
    SELECT * FROM team_members
    ORDER BY commit_count DESC, last_seen DESC
    LIMIT ?
  `, [limit]);
  return (rows || []).map((r) => ({ ...r, repos: safeJson(r.repos, []) }));
}

export async function setTeamMemberInfo(email, { role, notes, is_me }) {
  const sets = [];
  const params = [];
  if (role !== undefined) { sets.push('role = ?'); params.push(role); }
  if (notes !== undefined) { sets.push('notes = ?'); params.push(notes); }
  if (is_me !== undefined) { sets.push('is_me = ?'); params.push(is_me ? 1 : 0); }
  if (sets.length === 0) return;
  params.push(email);
  return db.run(`UPDATE team_members SET ${sets.join(', ')} WHERE email = ?`, params);
}

export async function setSkillState(id, state) {
  const now = new Date().toISOString();
  return db.run(`UPDATE skills SET state = ?, updated_at = ? WHERE id = ?`, [state, now, id]);
}

// ─── Ingest queries (v0.10.0 "SEAL asks back") ────────

export async function upsertHandlerMatcher({ skill_id, source, priority = 0, criteria }) {
  return db.run(`
    INSERT INTO handler_matchers (skill_id, source, priority, criteria)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(skill_id, source) DO UPDATE SET
      priority = excluded.priority,
      criteria = excluded.criteria
  `, [skill_id, source, priority, JSON.stringify(criteria || {})]);
}

export async function listHandlerMatchersForSource(source) {
  const rows = await db.all(`
    SELECT hm.skill_id, hm.source, hm.priority, hm.criteria,
           s.name, s.script_path, s.state
    FROM handler_matchers hm
    JOIN skills s ON s.id = hm.skill_id
    WHERE hm.source = ? AND s.state = 'active'
    ORDER BY hm.priority DESC, s.created_at ASC
  `, [source]);
  return (rows || []).map((r) => ({
    ...r,
    criteria: safeJson(r.criteria, {}),
  }));
}

export async function insertIngest({ source, data, interpretation = null, suggestedActions = null, suggestedHandler = null }) {
  const now = new Date().toISOString();
  const res = await db.run(`
    INSERT INTO ingest_queue (source, received_at, data, interpretation, suggested_actions, suggested_handler)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    source, now, JSON.stringify(data ?? {}),
    interpretation,
    suggestedActions ? JSON.stringify(suggestedActions) : null,
    suggestedHandler ? JSON.stringify(suggestedHandler) : null,
  ]);
  return res?.lastInsertRowid ?? res?.lastInsertRowId ?? null;
}

export async function getIngest(id) {
  const row = await db.get(`SELECT * FROM ingest_queue WHERE id = ?`, [id]);
  if (!row) return null;
  return {
    ...row,
    data: safeJson(row.data, {}),
    suggested_actions: safeJson(row.suggested_actions, []),
    suggested_handler: safeJson(row.suggested_handler, null),
  };
}

export async function listIngest({ state, limit = 50 } = {}) {
  let sql = `SELECT * FROM ingest_queue`;
  const params = [];
  if (state) { sql += ` WHERE state = ?`; params.push(state); }
  sql += ` ORDER BY received_at DESC LIMIT ?`;
  params.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500));
  const rows = await db.all(sql, params);
  return (rows || []).map((r) => ({
    ...r,
    data: safeJson(r.data, {}),
    suggested_actions: safeJson(r.suggested_actions, []),
    suggested_handler: safeJson(r.suggested_handler, null),
  }));
}

export async function updateIngest(id, patch) {
  const sets = [];
  const params = [];
  for (const k of ['interpretation', 'state', 'handler_skill_id', 'decided_at']) {
    if (patch[k] !== undefined) { sets.push(`${k} = ?`); params.push(patch[k]); }
  }
  if (patch.suggested_actions !== undefined) {
    sets.push(`suggested_actions = ?`);
    params.push(JSON.stringify(patch.suggested_actions));
  }
  if (patch.suggested_handler !== undefined) {
    sets.push(`suggested_handler = ?`);
    params.push(JSON.stringify(patch.suggested_handler));
  }
  if (sets.length === 0) return null;
  params.push(id);
  return db.run(`UPDATE ingest_queue SET ${sets.join(', ')} WHERE id = ?`, params);
}

export { db, DB_PATH };
