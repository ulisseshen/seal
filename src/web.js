import http from 'http';
import fs from 'fs';
import { db } from './db.js';
import { loadConfig, CONFIG_PATH } from './config.js';

const PORT = parseInt(process.env.SEAL_WEB_PORT || '3457', 10);

// ─── Observer ingestion hooks ──────────────────────────
// Stream C — the GitObserver is wired by runner.js at startup via
// setGitIngester(). Keeping web.js observer-agnostic (no direct import of
// src/observers/git.js) avoids circular-import risk and keeps the web
// surface decoupled from the observer subsystem.
let gitIngester = null;
export function setGitIngester(fn) {
  gitIngester = typeof fn === 'function' ? fn : null;
}

async function getStats() {
  const [active, done, failed, firing] = await Promise.all([
    db.get(`SELECT count(*) as c FROM tasks WHERE status IN ('pending','running')`),
    db.get(`SELECT count(*) as c FROM tasks WHERE status = 'done'`),
    db.get(`SELECT count(*) as c FROM tasks WHERE status = 'failed'`),
    db.get(`SELECT count(*) as c FROM tasks WHERE status = 'firing'`),
  ]);
  return {
    active: active?.c || 0,
    done: done?.c || 0,
    failed: failed?.c || 0,
    firing: firing?.c || 0,
  };
}

async function getTasks(status, limit = 50) {
  if (status === 'active') {
    return db.all(`
      SELECT * FROM tasks WHERE status IN ('pending','running','firing')
      ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created DESC
      LIMIT ?
    `, [limit]);
  }
  return db.all(`
    SELECT * FROM tasks WHERE status = ?
    ORDER BY completed_at DESC, created DESC
    LIMIT ?
  `, [status, limit]);
}

async function getTask(id) {
  return db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
}

async function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/stats') {
    const stats = await getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return true;
  }

  if (url.pathname === '/api/tasks') {
    const status = url.searchParams.get('status') || 'active';
    const tasks = await getTasks(status);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tasks));
    return true;
  }

  if (url.pathname.startsWith('/api/task/')) {
    const id = url.pathname.split('/').pop();
    const task = await getTask(id);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    }
    return true;
  }

  // Config API
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const config = loadConfig();
    // Mask secrets — show only whether they're set
    const safe = JSON.parse(JSON.stringify(config));
    if (safe.telegram?.token) safe.telegram.token = safe.telegram.token ? '***set***' : '';
    if (safe.discord?.token) safe.discord.token = safe.discord.token ? '***set***' : '';
    if (safe.email?.appPassword) safe.email.appPassword = safe.email.appPassword ? '***set***' : '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
    return true;
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const updates = JSON.parse(body);
      // Load current config from disk (not merged defaults)
      let current = {};
      try { current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
      // Deep merge updates into current
      for (const section of Object.keys(updates)) {
        if (typeof updates[section] === 'object' && !Array.isArray(updates[section])) {
          current[section] = { ...(current[section] || {}), ...updates[section] };
          // Remove masked values so we don't overwrite real secrets
          for (const [k, v] of Object.entries(current[section])) {
            if (v === '***set***') delete current[section][k];
          }
        } else {
          current[section] = updates[section];
        }
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Config saved. Restart SEAL to apply.' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ─── Stream C: Git hook ingestion endpoint ──────────
  // Receives payloads from git hooks installed by Stream D. Normalization
  // and event emission happen in GitObserver.ingestHookPayload, wired in
  // by runner.js via setGitIngester(). This endpoint only handles HTTP
  // framing + dispatch.
  if (url.pathname === '/api/observe/git' && req.method === 'POST') {
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON: ' + err.message }));
      return true;
    }
    if (!gitIngester) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'git observer not ready' }));
      return true;
    }
    try {
      await gitIngester(payload);
      res.writeHead(204);
      res.end();
    } catch (err) {
      console.warn('[web] git ingestion failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  return false;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

export function startWeb() {
  const server = http.createServer(async (req, res) => {
    try {
      if (await handleAPI(req, res)) return;

      // Serve dashboard for all other routes
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(dashboardHTML());
    } catch (err) {
      console.error('[web] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[web] Port ${PORT} in use — dashboard skipped (run standalone with: node src/web.js)`);
    } else {
      console.error('[web] Server error:', err.message);
    }
  });

  server.listen(PORT, () => {
    console.log(`[web] SEAL Dashboard → http://localhost:${PORT}`);
  });

  return server;
}

// Auto-start when run directly: node src/web.js
if (process.argv[1]?.endsWith('web.js')) {
  startWeb();
}

function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SEAL Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #09090b;
      --surface: #18181b;
      --surface2: #1f1f23;
      --border: #27272a;
      --text: #fafafa;
      --muted: #71717a;
      --accent: #3b82f6;
      --accent-dim: rgba(59,130,246,0.15);
      --green: #22c55e;
      --green-dim: rgba(34,197,94,0.15);
      --red: #ef4444;
      --red-dim: rgba(239,68,68,0.15);
      --orange: #f97316;
      --orange-dim: rgba(249,115,22,0.15);
      --purple: #a855f7;
      --purple-dim: rgba(168,85,247,0.15);
      --yellow: #eab308;
      --yellow-dim: rgba(234,179,8,0.15);
    }

    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
    }

    .mono { font-family: 'JetBrains Mono', monospace; }

    /* Layout */
    .shell {
      max-width: 1080px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
    }

    .logo {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .logo span { color: var(--accent); }

    .header-meta {
      display: flex;
      gap: 16px;
      align-items: center;
      font-size: 13px;
      color: var(--muted);
    }

    .pulse {
      width: 8px; height: 8px;
      background: var(--green);
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* Stats */
    .stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 28px;
    }

    @media (max-width: 600px) {
      .stats { grid-template-columns: repeat(2, 1fr); }
    }

    .stat {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }

    .stat-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .stat-value.accent { color: var(--accent); }
    .stat-value.green { color: var(--green); }
    .stat-value.red { color: var(--red); }
    .stat-value.orange { color: var(--orange); }

    /* Tabs */
    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0;
    }

    .tab {
      padding: 10px 18px;
      font-size: 13px;
      font-weight: 500;
      color: var(--muted);
      background: none;
      border: none;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: all 0.15s;
    }

    .tab:hover { color: var(--text); }
    .tab.active { color: var(--text); border-bottom-color: var(--accent); }

    /* Task list */
    .tasks {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .task-row {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 20px;
      display: grid;
      grid-template-columns: 72px 1fr auto auto auto;
      gap: 16px;
      align-items: center;
      cursor: pointer;
      transition: border-color 0.15s;
    }

    .task-row:hover { border-color: var(--accent); }

    @media (max-width: 700px) {
      .task-row {
        grid-template-columns: 1fr;
        gap: 8px;
      }
    }

    .task-id {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--muted);
      background: var(--surface2);
      padding: 3px 8px;
      border-radius: 4px;
      text-align: center;
    }

    .task-summary {
      font-size: 14px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .badge {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    .badge-pending { background: var(--accent-dim); color: var(--accent); }
    .badge-running { background: var(--purple-dim); color: var(--purple); }
    .badge-done { background: var(--green-dim); color: var(--green); }
    .badge-failed { background: var(--red-dim); color: var(--red); }
    .badge-firing { background: var(--orange-dim); color: var(--orange); animation: pulse 1s infinite; }
    .badge-acknowledged { background: var(--green-dim); color: var(--green); }

    .badge-high { background: var(--red-dim); color: var(--red); }
    .badge-medium { background: var(--yellow-dim); color: var(--yellow); }
    .badge-low { background: var(--surface2); color: var(--muted); }

    .task-type {
      font-size: 12px;
      color: var(--muted);
    }

    /* Task detail modal */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 100;
      justify-content: center;
      align-items: center;
      padding: 24px;
    }

    .modal-overlay.open { display: flex; }

    .modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
      max-width: 640px;
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
    }

    .modal h2 {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-close {
      background: none;
      border: none;
      color: var(--muted);
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
    }

    .modal-close:hover { color: var(--text); }

    .detail-grid {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 8px 16px;
      font-size: 13px;
      margin-bottom: 20px;
    }

    .detail-label {
      color: var(--muted);
      font-weight: 500;
    }

    .detail-value {
      color: var(--text);
      word-break: break-word;
    }

    .result-box {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      line-height: 1.6;
      color: var(--muted);
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .empty {
      text-align: center;
      padding: 60px 20px;
      color: var(--muted);
      font-size: 14px;
    }

    .empty-icon { font-size: 32px; margin-bottom: 12px; }

    /* Channel icons */
    .channel {
      font-size: 12px;
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* Settings */
    .settings { display: none; }
    .settings.visible { display: block; }

    .settings-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 16px;
    }

    .settings-section h3 {
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .settings-section h3 .ch-icon {
      font-size: 20px;
    }

    .field {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: 8px 16px;
      align-items: center;
      margin-bottom: 12px;
    }

    @media (max-width: 540px) {
      .field { grid-template-columns: 1fr; }
    }

    .field label {
      font-size: 13px;
      font-weight: 500;
      color: var(--muted);
    }

    .field input[type="text"],
    .field input[type="password"],
    .field input[type="number"] {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 12px;
      color: var(--text);
      font-size: 13px;
      font-family: 'JetBrains Mono', monospace;
      outline: none;
      width: 100%;
    }

    .field input:focus { border-color: var(--accent); }

    .toggle-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }

    .toggle {
      position: relative;
      width: 44px;
      height: 24px;
      flex-shrink: 0;
    }

    .toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .toggle-slider {
      position: absolute;
      inset: 0;
      background: var(--surface2);
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .toggle-slider::before {
      content: '';
      position: absolute;
      width: 18px;
      height: 18px;
      left: 3px;
      top: 3px;
      background: var(--muted);
      border-radius: 50%;
      transition: all 0.2s;
    }

    .toggle input:checked + .toggle-slider {
      background: var(--accent-dim);
    }

    .toggle input:checked + .toggle-slider::before {
      transform: translateX(20px);
      background: var(--accent);
    }

    .toggle-label {
      font-size: 14px;
      font-weight: 600;
    }

    .save-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 24px;
    }

    .save-btn {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 10px 28px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }

    .save-btn:hover { opacity: 0.9; }
    .save-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .save-msg {
      font-size: 13px;
      color: var(--green);
      opacity: 0;
      transition: opacity 0.3s;
    }

    .save-msg.show { opacity: 1; }

    .hint {
      font-size: 11px;
      color: var(--muted);
      margin-top: 4px;
      grid-column: 2;
    }

    @media (max-width: 540px) {
      .hint { grid-column: 1; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="header">
      <div class="logo">SEAL <span>Dashboard</span></div>
      <div class="header-meta">
        <button class="tab" style="border:none;margin:0;padding:6px 14px" onclick="showPage('tasks')">Tasks</button>
        <button class="tab" style="border:none;margin:0;padding:6px 14px" onclick="showPage('settings')">Settings</button>
        <div class="pulse"></div>
      </div>
    </div>

    <div id="page-tasks">
    <div class="stats" id="stats">
      <div class="stat">
        <div class="stat-label">Active</div>
        <div class="stat-value accent" id="stat-active">-</div>
      </div>
      <div class="stat">
        <div class="stat-label">Completed</div>
        <div class="stat-value green" id="stat-done">-</div>
      </div>
      <div class="stat">
        <div class="stat-label">Failed</div>
        <div class="stat-value red" id="stat-failed">-</div>
      </div>
      <div class="stat">
        <div class="stat-label">Firing</div>
        <div class="stat-value orange" id="stat-firing">-</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab active" data-status="active">Active</button>
      <button class="tab" data-status="done">Completed</button>
      <button class="tab" data-status="failed">Failed</button>
      <button class="tab" data-status="acknowledged">Acknowledged</button>
    </div>

    <div class="tasks" id="tasks"></div>
    </div>

    <div id="page-settings" class="settings">
      <div class="settings-section">
        <h3><span class="ch-icon">&#9993;</span> Telegram</h3>
        <div class="toggle-row">
          <label class="toggle"><input type="checkbox" id="cfg-telegram-enabled"><span class="toggle-slider"></span></label>
          <span class="toggle-label">Enabled</span>
        </div>
        <div class="field">
          <label>Bot Token</label>
          <input type="password" id="cfg-telegram-token" placeholder="123456:ABC-DEF...">
        </div>
        <div class="hint">From @BotFather on Telegram. Or set SEAL_TELEGRAM_TOKEN env var.</div>
        <div class="field">
          <label>Allowed Users</label>
          <input type="text" id="cfg-telegram-allowedUsers" placeholder="123456789, @username">
        </div>
        <div class="hint">Comma-separated user IDs or @usernames. Empty = allow all.</div>
      </div>

      <div class="settings-section">
        <h3><span class="ch-icon">&#127918;</span> Discord</h3>
        <div class="toggle-row">
          <label class="toggle"><input type="checkbox" id="cfg-discord-enabled"><span class="toggle-slider"></span></label>
          <span class="toggle-label">Enabled</span>
        </div>
        <div class="field">
          <label>Bot Token</label>
          <input type="password" id="cfg-discord-token" placeholder="MTIz...your-token">
        </div>
        <div class="hint">From Discord Developer Portal &rarr; Bot &rarr; Token. Or set SEAL_DISCORD_TOKEN env var.</div>
        <div class="field">
          <label>Allowed Users</label>
          <input type="text" id="cfg-discord-allowedUsers" placeholder="123456789012345678, username">
        </div>
        <div class="hint">Comma-separated Discord user IDs or usernames. Empty = allow all.</div>
        <div class="toggle-row" style="margin-top:12px">
          <label class="toggle"><input type="checkbox" id="cfg-discord-dmOnly" checked><span class="toggle-slider"></span></label>
          <span class="toggle-label">DM Only</span>
        </div>
      </div>

      <div class="settings-section">
        <h3><span class="ch-icon">&#128172;</span> WhatsApp</h3>
        <div class="toggle-row">
          <label class="toggle"><input type="checkbox" id="cfg-whatsapp-enabled"><span class="toggle-slider"></span></label>
          <span class="toggle-label">Enabled</span>
        </div>
        <div class="hint" style="grid-column:1">Scan QR code in terminal on first run. No token needed.</div>
      </div>

      <div class="settings-section">
        <h3><span class="ch-icon">&#128231;</span> Email</h3>
        <div class="toggle-row">
          <label class="toggle"><input type="checkbox" id="cfg-email-enabled"><span class="toggle-slider"></span></label>
          <span class="toggle-label">Enabled</span>
        </div>
        <div class="field">
          <label>Mode</label>
          <input type="text" id="cfg-email-mode" placeholder="gmail" value="gmail">
        </div>
        <div class="hint">"gmail" (IMAP polling) or "webhook" (Cloudflare Worker)</div>
        <div class="field">
          <label>Gmail Address</label>
          <input type="text" id="cfg-email-user" placeholder="you@gmail.com">
        </div>
        <div class="field">
          <label>App Password</label>
          <input type="password" id="cfg-email-appPassword" placeholder="xxxx xxxx xxxx xxxx">
        </div>
        <div class="hint">From myaccount.google.com/apppasswords. Or set SEAL_GMAIL_PASS env var.</div>
        <div class="field">
          <label>SEAL Address</label>
          <input type="text" id="cfg-email-sealAddress" placeholder="seal@yourdomain.com">
        </div>
        <div class="field">
          <label>Poll Interval (ms)</label>
          <input type="number" id="cfg-email-pollInterval" placeholder="300000" value="300000">
        </div>
      </div>

      <div class="settings-section">
        <h3><span class="ch-icon">&#127908;</span> Transcription</h3>
        <div class="toggle-row">
          <label class="toggle"><input type="checkbox" id="cfg-transcription-enabled" checked><span class="toggle-slider"></span></label>
          <span class="toggle-label">Enabled</span>
        </div>
        <div class="field">
          <label>Binary</label>
          <input type="text" id="cfg-transcription-binary" placeholder="whisper-cli" value="whisper-cli">
        </div>
        <div class="field">
          <label>Model Path</label>
          <input type="text" id="cfg-transcription-model" placeholder="~/.config/seal/models/ggml-small.bin">
        </div>
        <div class="field">
          <label>Language</label>
          <input type="text" id="cfg-transcription-language" placeholder="pt" value="pt">
        </div>
        <div class="hint">"pt", "en", or "auto" (slower)</div>
      </div>

      <div class="save-bar">
        <button class="save-btn" onclick="saveConfig()">Save &amp; Restart Required</button>
        <span class="save-msg" id="save-msg">Saved! Restart SEAL to apply.</span>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="modal-overlay">
    <div class="modal" id="modal"></div>
  </div>

  <script>
    let currentTab = 'active';

    // Stats
    async function loadStats() {
      try {
        const r = await fetch('/api/stats');
        const s = await r.json();
        document.getElementById('stat-active').textContent = s.active;
        document.getElementById('stat-done').textContent = s.done;
        document.getElementById('stat-failed').textContent = s.failed;
        document.getElementById('stat-firing').textContent = s.firing;
      } catch {}
    }

    // Tasks
    async function loadTasks() {
      try {
        const r = await fetch('/api/tasks?status=' + currentTab);
        const tasks = await r.json();
        const el = document.getElementById('tasks');

        if (!tasks.length) {
          el.innerHTML = '<div class="empty"><div class="empty-icon">&#128737;</div>No tasks here. Standing by.</div>';
          return;
        }

        el.innerHTML = tasks.map(t => \`
          <div class="task-row" onclick="openTask('\${t.id}')">
            <div class="task-id">\${t.id}</div>
            <div class="task-summary">\${esc(t.summary)}</div>
            <span class="badge badge-\${t.status}">\${t.status}</span>
            <span class="badge badge-\${t.priority}">\${t.priority}</span>
            <span class="task-type">\${t.type}</span>
          </div>
        \`).join('');
      } catch {}
    }

    // Task detail
    async function openTask(id) {
      try {
        const r = await fetch('/api/task/' + id);
        const t = await r.json();
        if (t.error) return;

        const modal = document.getElementById('modal');
        modal.innerHTML = \`
          <h2>
            Task \${t.id}
            <button class="modal-close" onclick="closeModal()">&times;</button>
          </h2>
          <div class="detail-grid">
            <div class="detail-label">Type</div>
            <div class="detail-value">\${t.type}</div>
            <div class="detail-label">Summary</div>
            <div class="detail-value">\${esc(t.summary)}</div>
            <div class="detail-label">Status</div>
            <div class="detail-value"><span class="badge badge-\${t.status}">\${t.status}</span></div>
            <div class="detail-label">Priority</div>
            <div class="detail-value"><span class="badge badge-\${t.priority}">\${t.priority}</span></div>
            <div class="detail-label">Project</div>
            <div class="detail-value">\${t.project || '—'}</div>
            <div class="detail-label">Channel</div>
            <div class="detail-value">\${t.notify_channel || 'system'}</div>
            <div class="detail-label">Notification</div>
            <div class="detail-value">\${t.notify_type || 'sound'}</div>
            <div class="detail-label">Schedule</div>
            <div class="detail-value">\${t.execute_at || 'immediate'}</div>
            <div class="detail-label">Recurrence</div>
            <div class="detail-value">\${t.recurrence || '—'}</div>
            <div class="detail-label">People</div>
            <div class="detail-value">\${t.people || '—'}</div>
            <div class="detail-label">Created</div>
            <div class="detail-value">\${t.created}</div>
            <div class="detail-label">Completed</div>
            <div class="detail-value">\${t.completed_at || '—'}</div>
          </div>
          \${t.detail ? '<div class="detail-label" style="margin-bottom:8px">Detail</div><div class="result-box">' + esc(t.detail) + '</div>' : ''}
          \${t.prompt ? '<div class="detail-label" style="margin:16px 0 8px">Prompt</div><div class="result-box">' + esc(t.prompt) + '</div>' : ''}
          \${t.result ? '<div class="detail-label" style="margin:16px 0 8px">Result</div><div class="result-box">' + esc(t.result) + '</div>' : ''}
        \`;

        document.getElementById('modal-overlay').classList.add('open');
      } catch {}
    }

    function closeModal() {
      document.getElementById('modal-overlay').classList.remove('open');
    }

    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentTab = tab.dataset.status;
        loadTasks();
      });
    });

    // Escape HTML
    function esc(s) {
      if (!s) return '';
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Page switching
    function showPage(page) {
      document.getElementById('page-tasks').style.display = page === 'tasks' ? 'block' : 'none';
      document.getElementById('page-settings').className = page === 'settings' ? 'settings visible' : 'settings';
      if (page === 'settings') loadConfigUI();
    }

    // Config loading
    async function loadConfigUI() {
      try {
        const r = await fetch('/api/config');
        const c = await r.json();

        // Telegram
        el('cfg-telegram-enabled').checked = c.telegram?.enabled || false;
        el('cfg-telegram-token').value = c.telegram?.token || '';
        el('cfg-telegram-allowedUsers').value = (c.telegram?.allowedUsers || []).join(', ');

        // Discord
        el('cfg-discord-enabled').checked = c.discord?.enabled || false;
        el('cfg-discord-token').value = c.discord?.token || '';
        el('cfg-discord-allowedUsers').value = (c.discord?.allowedUsers || []).join(', ');
        el('cfg-discord-dmOnly').checked = c.discord?.dmOnly !== false;

        // WhatsApp
        el('cfg-whatsapp-enabled').checked = c.whatsapp?.enabled || false;

        // Email
        el('cfg-email-enabled').checked = c.email?.enabled || false;
        el('cfg-email-mode').value = c.email?.mode || 'gmail';
        el('cfg-email-user').value = c.email?.user || '';
        el('cfg-email-appPassword').value = c.email?.appPassword || '';
        el('cfg-email-sealAddress').value = c.email?.sealAddress || '';
        el('cfg-email-pollInterval').value = c.email?.pollInterval || 300000;

        // Transcription
        el('cfg-transcription-enabled').checked = c.transcription?.enabled !== false;
        el('cfg-transcription-binary').value = c.transcription?.binary || 'whisper-cli';
        el('cfg-transcription-model').value = c.transcription?.model || '';
        el('cfg-transcription-language').value = c.transcription?.language || 'pt';
      } catch (e) {
        console.error('Failed to load config:', e);
      }
    }

    // Config saving
    async function saveConfig() {
      const parseList = (s) => s.split(',').map(x => x.trim()).filter(Boolean);

      const config = {
        telegram: {
          enabled: el('cfg-telegram-enabled').checked,
          token: el('cfg-telegram-token').value,
          allowedUsers: parseList(el('cfg-telegram-allowedUsers').value),
        },
        discord: {
          enabled: el('cfg-discord-enabled').checked,
          token: el('cfg-discord-token').value,
          allowedUsers: parseList(el('cfg-discord-allowedUsers').value),
          dmOnly: el('cfg-discord-dmOnly').checked,
        },
        whatsapp: {
          enabled: el('cfg-whatsapp-enabled').checked,
        },
        email: {
          enabled: el('cfg-email-enabled').checked,
          mode: el('cfg-email-mode').value,
          user: el('cfg-email-user').value,
          appPassword: el('cfg-email-appPassword').value,
          sealAddress: el('cfg-email-sealAddress').value,
          pollInterval: parseInt(el('cfg-email-pollInterval').value) || 300000,
        },
        transcription: {
          enabled: el('cfg-transcription-enabled').checked,
          binary: el('cfg-transcription-binary').value,
          model: el('cfg-transcription-model').value,
          language: el('cfg-transcription-language').value,
        },
      };

      try {
        const r = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        const result = await r.json();
        const msg = el('save-msg');
        msg.textContent = result.ok ? 'Saved! Restart SEAL to apply.' : 'Error: ' + result.error;
        msg.style.color = result.ok ? 'var(--green)' : 'var(--red)';
        msg.classList.add('show');
        setTimeout(() => msg.classList.remove('show'), 4000);
      } catch (e) {
        console.error('Save failed:', e);
      }
    }

    function el(id) { return document.getElementById(id); }

    // Init + auto-refresh
    loadStats();
    loadTasks();
    setInterval(() => { loadStats(); loadTasks(); }, 10000);
  </script>
</body>
</html>`;
}
