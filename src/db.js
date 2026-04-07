import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_DIR = path.join(os.homedir(), '.config', 'seal');
fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, 'tasks.db');

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
    max_runs INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_execute_at ON tasks(execute_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run);
`);

// Migration: add notify_target column to existing databases (SQLite doesn't support
// IF NOT EXISTS for ADD COLUMN, so swallow the "duplicate column" error)
try {
  await db.exec(`ALTER TABLE tasks ADD COLUMN notify_target TEXT`);
} catch (err) {
  // Column already exists — that's fine
}

// ─── Public API (all async) ─────────────────────────────

export async function insertTask(task) {
  return db.run(`
    INSERT INTO tasks (id, type, summary, detail, execute_at, recurrence, next_run,
      prompt, project, allowed_tools, permission_mode, notify_type, notify_channel, notify_target,
      people, priority, status, created, max_runs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [task.id, task.type, task.summary, task.detail, task.execute_at, task.recurrence,
      task.next_run, task.prompt, task.project, task.allowed_tools, task.permission_mode,
      task.notify_type, task.notify_channel, task.notify_target || null, task.people, task.priority, task.status,
      task.created, task.max_runs]);
}

export async function getPendingTasks(limit = 5) {
  return db.all(`
    SELECT * FROM tasks
    WHERE status = 'pending'
      AND (execute_at IS NULL OR execute_at <= datetime('now'))
      AND type IN ('task', 'ritual')
    ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, execute_at ASC
    LIMIT ?
  `, [limit]);
}

export async function getPendingReminders() {
  return db.all(`
    SELECT * FROM tasks WHERE status = 'pending' AND type = 'reminder' AND execute_at <= datetime('now')
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

export { db, DB_PATH };
