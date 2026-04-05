import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_DIR = path.join(os.homedir(), '.config', 'seal');
fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, 'tasks.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('task','reminder','ritual','deadline','person','decision')),
    summary TEXT NOT NULL,
    detail TEXT,

    -- Scheduling
    execute_at TEXT,
    recurrence TEXT,
    next_run TEXT,

    -- Execution
    prompt TEXT,
    project TEXT,
    allowed_tools TEXT DEFAULT '[]',
    permission_mode TEXT DEFAULT 'auto',

    -- Notification
    notify_type TEXT DEFAULT 'sound' CHECK(notify_type IN ('silent','sound','sticky','nuclear','supernova')),
    notify_channel TEXT DEFAULT 'system',
    last_notified_at TEXT,

    -- Metadata
    people TEXT DEFAULT '[]',
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','archived','firing','acknowledged')),
    result TEXT,
    created TEXT NOT NULL,
    completed_at TEXT,

    -- Loops
    run_count INTEGER DEFAULT 0,
    max_runs INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_execute_at ON tasks(execute_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run);
`);

export function insertTask(task) {
  const stmt = db.prepare(`
    INSERT INTO tasks (id, type, summary, detail, execute_at, recurrence, next_run,
      prompt, project, allowed_tools, permission_mode, notify_type, notify_channel,
      people, priority, status, created, max_runs)
    VALUES (@id, @type, @summary, @detail, @execute_at, @recurrence, @next_run,
      @prompt, @project, @allowed_tools, @permission_mode, @notify_type, @notify_channel,
      @people, @priority, @status, @created, @max_runs)
  `);
  return stmt.run(task);
}

export function getPendingTasks(limit = 5) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
      AND (execute_at IS NULL OR execute_at <= datetime('now'))
      AND type IN ('task', 'ritual')
    ORDER BY
      CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      execute_at ASC
    LIMIT ?
  `).all(limit);
}

export function getPendingReminders() {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
      AND type = 'reminder'
      AND execute_at <= datetime('now')
  `).all();
}

export function getFiringSupernova() {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'firing'
      AND notify_type = 'supernova'
      AND (last_notified_at IS NULL OR datetime(last_notified_at, '+5 minutes') <= datetime('now'))
  `).all();
}

export function getRunningCount() {
  return db.prepare(`SELECT count(*) as count FROM tasks WHERE status = 'running'`).get().count;
}

export function updateStatus(id, status, result = null) {
  db.prepare(`
    UPDATE tasks SET status = ?, result = ?,
      completed_at = CASE WHEN ? IN ('done','failed','acknowledged') THEN datetime('now') ELSE completed_at END
    WHERE id = ?
  `).run(status, result, status, id);
}

export function setFiring(id) {
  db.prepare(`UPDATE tasks SET status = 'firing', last_notified_at = datetime('now') WHERE id = ?`).run(id);
}

export function updateLastNotified(id) {
  db.prepare(`UPDATE tasks SET last_notified_at = datetime('now') WHERE id = ?`).run(id);
}

export function acknowledgeBySearch(search) {
  const result = db.prepare(`
    UPDATE tasks SET status = 'acknowledged', completed_at = datetime('now')
    WHERE (status = 'firing' OR status = 'pending')
      AND (summary LIKE ? OR id = ?)
  `).run(`%${search}%`, search);
  return result.changes;
}

export function advanceRecurring(id, nextRun) {
  db.prepare(`
    UPDATE tasks SET status = 'pending', execute_at = ?, next_run = ?,
      run_count = run_count + 1, result = NULL
    WHERE id = ?
  `).run(nextRun, nextRun, id);
}

export function checkMaxRuns(id) {
  const task = db.prepare(`SELECT run_count, max_runs FROM tasks WHERE id = ?`).get(id);
  return task && task.max_runs && task.run_count >= task.max_runs;
}

export function searchTasks(query, statusFilter = null) {
  let sql = `SELECT * FROM tasks WHERE (summary LIKE ? OR detail LIKE ? OR people LIKE ?)`;
  const params = [`%${query}%`, `%${query}%`, `%${query}%`];
  if (statusFilter) {
    sql += ` AND status = ?`;
    params.push(statusFilter);
  }
  sql += ` ORDER BY created DESC LIMIT 50`;
  return db.prepare(sql).all(...params);
}

export function listActive() {
  return db.prepare(`
    SELECT * FROM tasks WHERE status IN ('pending', 'running', 'firing')
    ORDER BY
      CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      execute_at ASC
  `).all();
}

export function getTaskById(id) {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
}

export { db, DB_PATH };
