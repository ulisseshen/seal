import express from 'express';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import {
  addWatchedRepo,
  removeWatchedRepo,
  listWatchedRepos,
  getWatchedRepoByPath,
  queryEvents,
  insertChatMessage,
  listChatMessages,
  clearChatMessages,
  listMemories,
  insertMemory,
  listPatterns,
  setPatternState,
} from '../src/db.js';
import { runDetectors } from '../src/brain/detector.js';
import { installSealHooks, uninstallSealHooks, hasSealHooks } from './hooks-installer.js';
import { getProvider, listProviders } from '../src/providers/index.js';
import { hasSecret, backend as secretsBackend } from '../src/secrets.js';

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

function readChatConfig() {
  if (existsSync(chatConfigPath)) {
    try { return JSON.parse(readFileSync(chatConfigPath, 'utf-8')); } catch {}
  }
  return { provider: 'claude', model: null, system_prompt: 'You are SEAL, a personal tech-lead assistant.' };
}

app.get('/api/chat-config', (_req, res) => {
  try {
    const cfg = readChatConfig();
    // Report which providers are configured (without exposing secrets)
    const providers = listProviders().map((name) => {
      const p = getProvider(name);
      return { name, available: p.available(), is_default: cfg.provider === name };
    });
    res.json({
      provider: cfg.provider,
      model: cfg.model,
      system_prompt: cfg.system_prompt,
      providers,
      secrets_backend: secretsBackend(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/chat-config', (req, res) => {
  try {
    const current = readChatConfig();
    const next = { ...current, ...req.body };
    // Never store api_key here — secret store owns that
    delete next.api_key;
    writeFileSync(chatConfigPath, JSON.stringify(next, null, 2));
    res.json(next);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Workspaces (v0.3.0 "Eye" layer) ---
// Repos SEAL is watching for git activity. Add/list/remove + scan a parent
// directory for candidate child repos. All hook install/uninstall is
// synchronous and reversible — see dashboard/hooks-installer.js.

app.post('/api/pick-folder', async (_req, res) => {
  if (process.platform !== 'darwin') {
    return res.status(501).json({ error: 'Native folder picker is only supported on macOS' });
  }
  const { spawn } = await import('node:child_process');
  const script = 'POSIX path of (choose folder with prompt "Select a parent folder for SEAL to watch")';
  const child = spawn('osascript', ['-e', script]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => {
    if (code === 0) {
      const picked = stdout.trim().replace(/\/$/, '');
      return res.json({ path: picked });
    }
    if (/User canceled/i.test(stderr)) {
      return res.json({ cancelled: true });
    }
    return res.status(500).json({ error: stderr.trim() || `osascript exited ${code}` });
  });
});

app.post('/api/workspaces/scan', async (req, res) => {
  const { parent_path: parentPath } = req.body || {};
  if (!parentPath || typeof parentPath !== 'string') {
    return res.status(400).json({ error: 'parent_path is required' });
  }
  if (!isAbsolute(parentPath)) {
    return res.status(400).json({ error: 'parent_path must be absolute' });
  }
  if (!existsSync(parentPath)) {
    return res.status(404).json({ error: `parent_path does not exist: ${parentPath}` });
  }
  try {
    const watched = await listWatchedRepos();
    const watchedPaths = new Set(watched.map(r => r.path));

    let entries = [];
    try {
      entries = readdirSync(parentPath, { withFileTypes: true });
    } catch (err) {
      return res.status(500).json({ error: `cannot read parent_path: ${err.message}` });
    }

    const repos = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childPath = join(parentPath, entry.name);
      const gitDir = join(childPath, '.git');
      if (!existsSync(gitDir)) continue;
      // Some checkouts have .git as a file (worktrees) — accept dir or file.
      let valid = false;
      try { valid = statSync(gitDir) ? true : false; } catch { valid = false; }
      if (!valid) continue;

      repos.push({
        path: childPath,
        name: entry.name,
        already_watched: watchedPaths.has(childPath),
        has_seal_hooks: hasSealHooks(childPath),
      });
    }

    res.json({ parent_path: parentPath, repos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspaces', async (_req, res) => {
  try {
    const repos = await listWatchedRepos();
    const enriched = repos.map(r => ({
      ...r,
      has_seal_hooks: hasSealHooks(r.path),
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function addOneWorkspace(repoPath) {
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('path is required');
  }
  if (!isAbsolute(repoPath)) {
    throw new Error('path must be absolute');
  }
  if (!existsSync(repoPath)) {
    throw new Error(`path does not exist: ${repoPath}`);
  }

  let installResult = null;
  let installError = null;
  try {
    installResult = installSealHooks(repoPath);
  } catch (err) {
    installError = err.message;
  }

  const installedOk =
    installResult && installResult.installed.length > 0 && installResult.errors.length === 0;

  const row = await addWatchedRepo({
    path: repoPath,
    hooksInstalled: installedOk,
    fallbackScraper: !installedOk,
  });

  return {
    ...row,
    has_seal_hooks: hasSealHooks(repoPath),
    install_error: installError || (installResult?.errors?.length ? installResult.errors : null),
    installed_hooks: installResult?.installed || [],
  };
}

app.post('/api/workspaces', async (req, res) => {
  const { path: repoPath } = req.body || {};
  try {
    const row = await addOneWorkspace(repoPath);
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workspaces/bulk', async (req, res) => {
  const { paths } = req.body || {};
  if (!Array.isArray(paths)) {
    return res.status(400).json({ error: 'paths must be an array' });
  }
  const added = [];
  const failed = [];
  for (const repoPath of paths) {
    try {
      const row = await addOneWorkspace(repoPath);
      added.push(row);
    } catch (err) {
      failed.push({ path: repoPath, error: err.message });
    }
  }
  res.json({ added, failed });
});

app.delete('/api/workspaces/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const all = await listWatchedRepos({ includeRemoved: true });
    const repo = all.find(r => r.id === id);
    if (!repo) return res.status(404).json({ error: 'workspace not found' });

    let uninstall = null;
    try {
      uninstall = uninstallSealHooks(repo.path);
    } catch (err) {
      uninstall = { removed: [], restored: [], errors: [{ message: err.message }] };
    }

    const ok = await removeWatchedRepo(repo.path);
    if (!ok) {
      // Already removed — still report success so the UI can refresh.
      return res.json({ removed: true, already_removed: true, uninstall });
    }
    res.json({ removed: true, uninstall });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Events (v0.3.0 "Eye" layer) ---
// Read-only live tail of the events table. No actions, no buttons in v0.3.0.

app.get('/api/events', async (req, res) => {
  try {
    const { source, kind, since, until, limit } = req.query;
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
    const events = await queryEvents({
      source: source || undefined,
      kind: kind || undefined,
      since: since || undefined,
      until: until || undefined,
      limit: lim,
    });
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Chat (SSE streaming + persistence) ---

app.post('/api/chat', async (req, res) => {
  const cfg = readChatConfig();
  const providerName = req.body.provider || cfg.provider || 'claude';
  // cfg.model is only meaningful when the request uses the default provider.
  const cfgModel = providerName === cfg.provider ? cfg.model : null;
  const model = req.body.model || cfgModel || undefined;
  const systemPrompt = req.body.system_prompt || cfg.system_prompt;
  const messages = Array.isArray(req.body.messages) ? req.body.messages : null;
  const sessionId = req.body.session_id || 'default';

  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: 'messages[] required' });
  }

  let provider;
  try {
    provider = getProvider(providerName, { model });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!provider.available()) {
    return res.status(400).json({
      error: `${providerName} is not configured. Run: seal setup provider ${providerName}`,
    });
  }

  // Persist the latest user turn BEFORE streaming (so it survives a crash).
  const latest = messages[messages.length - 1];
  if (latest?.role === 'user') {
    try {
      await insertChatMessage({ sessionId, role: 'user', content: latest.content, provider: providerName, model });
    } catch (err) {
      console.warn('[chat] persist user turn failed:', err.message);
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sse = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sse('start', { provider: providerName, model, session_id: sessionId });

  let accumulated = '';
  try {
    for await (const chunk of provider.stream(messages, systemPrompt)) {
      accumulated += chunk;
      sse('chunk', { text: chunk });
    }
    sse('done', {});
    if (accumulated) {
      try {
        await insertChatMessage({ sessionId, role: 'assistant', content: accumulated, provider: providerName, model });
      } catch (err) {
        console.warn('[chat] persist assistant turn failed:', err.message);
      }
    }
  } catch (err) {
    sse('error', { message: err.message });
  } finally {
    res.end();
  }
});

// --- API: Chat history ---

app.get('/api/chat/history', async (req, res) => {
  const sessionId = req.query.session_id || 'default';
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  try {
    const rows = await listChatMessages({ sessionId, limit });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/chat/history', async (req, res) => {
  const sessionId = req.query.session_id || 'default';
  try {
    await clearChatMessages(sessionId);
    res.json({ cleared: true, session_id: sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Memories ---

app.get('/api/memories', async (req, res) => {
  const { type, project, limit } = req.query;
  try {
    const rows = await listMemories({
      type: type || undefined,
      project: project || undefined,
      limit: parseInt(limit, 10) || 50,
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Patterns (v0.4.0 "SEAL notices") ---

app.get('/api/patterns', async (req, res) => {
  const { state, kind, limit } = req.query;
  try {
    const rows = await listPatterns({
      state: state || undefined,
      kind: kind || undefined,
      limit: parseInt(limit, 10) || 100,
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/patterns/scan', async (_req, res) => {
  try {
    const result = await runDetectors();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/patterns/:id/state', async (req, res) => {
  const { state } = req.body || {};
  const valid = ['observing', 'proposed', 'approved', 'denied', 'active', 'retired'];
  if (!valid.includes(state)) {
    return res.status(400).json({ error: `state must be one of ${valid.join(', ')}` });
  }
  try {
    await setPatternState(req.params.id, state);
    res.json({ id: req.params.id, state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/memories', async (req, res) => {
  const { type, name, description, content, project } = req.body || {};
  const valid = ['user', 'feedback', 'project', 'reference'];
  if (!valid.includes(type)) {
    return res.status(400).json({ error: `type must be one of ${valid.join(', ')}` });
  }
  if (!name || !description || !content) {
    return res.status(400).json({ error: 'name, description, and content are required' });
  }
  try {
    await insertMemory({ type, name, description, content, project: project || null, source: 'explicit' });
    res.status(201).json({ created: true });
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
