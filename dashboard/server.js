import express from 'express';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3333;
const DB_PATH = process.env.SEAL_DB || join(process.env.HOME, '.config', 'seal', 'tasks.db');
const SEAL_DIR = process.env.SEAL_DIR || join(process.env.HOME, '.config', 'seal');

const db = new Database(DB_PATH, { readonly: false });
db.pragma('journal_mode = WAL');

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// --- API: Tasks ---

app.get('/api/tasks', (req, res) => {
  const { status, type, project, priority, search } = req.query;
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (project) { sql += ' AND project LIKE ?'; params.push(`%${project}%`); }
  if (priority) { sql += ' AND priority = ?'; params.push(priority); }
  if (search) {
    sql += ' AND (summary LIKE ? OR detail LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  sql += ` ORDER BY CASE status
    WHEN 'running' THEN 1 WHEN 'firing' THEN 2 WHEN 'pending' THEN 3
    WHEN 'acknowledged' THEN 4 WHEN 'failed' THEN 5 WHEN 'done' THEN 6
    WHEN 'archived' THEN 7 ELSE 8 END, created DESC`;

  try {
    const tasks = db.prepare(sql).all(...params);
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  res.json(task);
});

app.post('/api/tasks', (req, res) => {
  const { id, type, summary, detail, execute_at, recurrence, next_run, prompt, project,
    allowed_tools, permission_mode, notify_type, notify_channel, people, priority, status } = req.body;

  const taskId = id || crypto.randomUUID().slice(0, 8);
  try {
    db.prepare(`INSERT INTO tasks (id, type, summary, detail, execute_at, recurrence, next_run,
      prompt, project, allowed_tools, permission_mode, notify_type, notify_channel,
      people, priority, status, created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      taskId, type || 'task', summary, detail || null, execute_at || null,
      recurrence || null, next_run || null, prompt || null, project || null,
      allowed_tools || '[]', permission_mode || 'auto',
      notify_type || 'sound', notify_channel || 'system',
      people || '[]', priority || 'medium', status || 'pending',
      new Date().toISOString()
    );
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = ['type', 'summary', 'detail', 'execute_at', 'recurrence', 'next_run',
    'prompt', 'project', 'allowed_tools', 'permission_mode', 'notify_type',
    'notify_channel', 'people', 'priority', 'status', 'result', 'completed_at'];

  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.json(existing);

  params.push(req.params.id);
  try {
    db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true });
});

// --- API: Stats ---

app.get('/api/stats', (_req, res) => {
  try {
    const byStatus = db.prepare(
      `SELECT status, COUNT(*) as count FROM tasks GROUP BY status`
    ).all();
    const byType = db.prepare(
      `SELECT type, COUNT(*) as count FROM tasks GROUP BY type`
    ).all();

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const upcoming = db.prepare(
      `SELECT COUNT(*) as count FROM tasks WHERE next_run IS NOT NULL AND next_run <= ? AND status IN ('pending', 'running')`
    ).get(tomorrow);

    const total = db.prepare('SELECT COUNT(*) as count FROM tasks').get();

    res.json({ total: total.count, byStatus, byType, upcomingIn24h: upcoming.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Logs (task_runs) ---

app.get('/api/logs', (req, res) => {
  const { status, task_id, limit: lim } = req.query;
  const limit = parseInt(lim) || 50;

  let sql = `SELECT tr.*, t.summary, t.type, t.project
    FROM task_runs tr LEFT JOIN tasks t ON tr.task_id = t.id WHERE 1=1`;
  const params = [];

  if (status === 'failed') { sql += ' AND tr.exit_code != 0'; }
  else if (status === 'success') { sql += ' AND (tr.exit_code = 0 OR tr.exit_code IS NULL)'; }
  if (task_id) { sql += ' AND tr.task_id = ?'; params.push(task_id); }

  sql += ' ORDER BY tr.started_at DESC LIMIT ?';
  params.push(limit);

  try {
    const logs = db.prepare(sql).all(...params);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Channels ---

const channelsPath = join(SEAL_DIR, 'channels.json');

app.get('/api/channels', (_req, res) => {
  try {
    if (existsSync(channelsPath)) {
      res.json(JSON.parse(readFileSync(channelsPath, 'utf-8')));
    } else {
      res.json({
        discord: { enabled: false, webhook_url: '' },
        telegram: { enabled: false, bot_token: '', chat_id: '' },
        slack: { enabled: false, webhook_url: '' },
        system: { enabled: true }
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/channels', (req, res) => {
  try {
    writeFileSync(channelsPath, JSON.stringify(req.body, null, 2));
    res.json(req.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/channels/test', (req, res) => {
  // Placeholder — would integrate with actual notification dispatch
  res.json({ success: true, message: `Test notification sent to ${req.body.channel || 'system'}` });
});

// --- API: Chat config ---

const chatConfigPath = join(SEAL_DIR, 'chat-config.json');

app.get('/api/chat-config', (_req, res) => {
  try {
    if (existsSync(chatConfigPath)) {
      res.json(JSON.parse(readFileSync(chatConfigPath, 'utf-8')));
    } else {
      res.json({ model: 'claude', api_key: '', system_prompt: 'You are SEAL, a personal tech-lead assistant.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/chat-config', (req, res) => {
  try {
    writeFileSync(chatConfigPath, JSON.stringify(req.body, null, 2));
    res.json(req.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Fallback: serve index.html for SPA ---

app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  🦭 SEAL Dashboard running at http://localhost:${PORT}\n`);
});
