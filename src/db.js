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

export { db, DB_PATH };
