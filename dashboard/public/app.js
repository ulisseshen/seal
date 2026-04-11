// ========================================
// SEAL Dashboard — Frontend Application
// ========================================

const API = '';
let allTasks = [];
let currentTypeFilter = 'all';
let currentStatusFilter = 'all';
let currentLogFilter = 'all';
let editingTaskId = null;

// --- Helpers ---

function relativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = date - now;
  const absDiff = Math.abs(diff);
  const mins = Math.floor(absDiff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (absDiff < 60000) return diff > 0 ? 'just now' : 'just now';
  if (mins < 60) return diff > 0 ? `in ${mins}m` : `${mins}m ago`;
  if (hours < 24) return diff > 0 ? `in ${hours}h` : `${hours}h ago`;
  if (days < 30) return diff > 0 ? `in ${days}d` : `${days}d ago`;
  return date.toLocaleDateString();
}

function formatDuration(start, end) {
  if (!start || !end) return '';
  const ms = new Date(end) - new Date(start);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function shortPath(path) {
  if (!path) return '';
  const parts = path.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : path;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Sidebar Navigation ---

// Restore sidebar collapse state
const sidebar = document.getElementById('sidebar');
if (localStorage.getItem('seal-sidebar-collapsed') === 'true') {
  sidebar.classList.add('collapsed');
}

// Toggle collapse
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  localStorage.setItem('seal-sidebar-collapsed', sidebar.classList.contains('collapsed'));
});

// Tab switching via sidebar items
document.querySelectorAll('.sidebar-item').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-item').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const page = document.getElementById(`page-${tab.dataset.tab}`);
    if (page) page.classList.add('active');

    // Load data for active tab
    const tabName = tab.dataset.tab;
    if (tabName === 'missions') loadMissions();
    if (tabName === 'channels') loadChannels();
    if (tabName === 'logs') loadLogs();
    if (tabName === 'calendar') loadCalendar();
    if (tabName === 'chat') loadChatConfig();
    if (tabName === 'workspaces') startWorkspacesTab();
    else stopWorkspacesPolling();
    if (tabName === 'events') startEventsTab();
    else stopEventsPolling();
  });
});

// --- Stats ---

async function loadStats() {
  try {
    const res = await fetch(`${API}/api/stats`);
    const stats = await res.json();
    const el = document.getElementById('header-stats');
    const statusMap = {};
    stats.byStatus.forEach(s => statusMap[s.status] = s.count);

    el.innerHTML = `
      <div class="stat-item">
        <span class="stat-value">${stats.total}</span>
        <span class="stat-label">Total</span>
      </div>
      <div class="stat-item">
        <span class="stat-value" style="color: var(--warning)">${statusMap.running || 0}</span>
        <span class="stat-label">Running</span>
      </div>
      <div class="stat-item">
        <span class="stat-value" style="color: var(--primary-strong)">${statusMap.pending || 0}</span>
        <span class="stat-label">Pending</span>
      </div>
      <div class="stat-item">
        <span class="stat-value" style="color: var(--accent)">${stats.upcomingIn24h}</span>
        <span class="stat-label">Next 24h</span>
      </div>
    `;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// --- Missions ---

function showSkeleton(container, count = 5) {
  container.innerHTML = Array.from({ length: count },
    () => '<div class="skeleton skeleton-card"></div>').join('');
}

async function loadMissions() {
  const list = document.getElementById('missions-list');
  showSkeleton(list);

  try {
    const res = await fetch(`${API}/api/tasks`);
    allTasks = await res.json();
    renderMissions();
  } catch (err) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">&#x26A0;</div>
      <h3>Connection Error</h3>
      <p>Could not load missions. Make sure the server is running.</p>
    </div>`;
  }
}

function renderMissions() {
  const list = document.getElementById('missions-list');
  const search = document.getElementById('search-input').value.toLowerCase();

  let filtered = allTasks;

  if (currentTypeFilter !== 'all') {
    filtered = filtered.filter(t => t.type === currentTypeFilter);
  }
  if (currentStatusFilter !== 'all') {
    filtered = filtered.filter(t => t.status === currentStatusFilter);
  }
  if (search) {
    filtered = filtered.filter(t =>
      (t.summary || '').toLowerCase().includes(search) ||
      (t.detail || '').toLowerCase().includes(search)
    );
  }

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">&#x1F9AD;</div>
      <h3>No missions found</h3>
      <p>${allTasks.length === 0 ? 'Create your first mission using the button above.' : 'Try adjusting your filters or search query.'}</p>
    </div>`;
    return;
  }

  list.innerHTML = filtered.map(task => `
    <div class="mission-card" data-id="${task.id}" data-priority="${task.priority}" onclick="toggleMission(this)">
      <div class="mission-top">
        <div class="mission-info">
          <span class="badge badge-type" data-type="${task.type}">${task.type}</span>
          <span class="mission-summary">${escapeHtml(task.summary)}</span>
        </div>
        <div class="mission-meta">
          ${task.recurrence ? `<span class="mission-recurrence">${escapeHtml(task.recurrence)}</span>` : ''}
          ${task.next_run ? `<span class="mission-time">${relativeTime(task.next_run)}</span>` : ''}
          ${task.project ? `<span class="badge badge-project">${escapeHtml(shortPath(task.project))}</span>` : ''}
          <span class="badge badge-status" data-status="${task.status}">${task.status}</span>
        </div>
      </div>
      <div class="mission-detail">
        ${task.detail ? `<div class="detail-text">${escapeHtml(task.detail)}</div>` : ''}
        ${task.prompt ? `<div class="detail-prompt">${escapeHtml(task.prompt)}</div>` : ''}
        <div class="detail-actions">
          ${task.status !== 'done' ? `<button class="btn btn-success btn-sm" onclick="event.stopPropagation(); markDone('${task.id}')">Mark Done</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); editMission('${task.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteMission('${task.id}')">Delete</button>
        </div>
      </div>
    </div>
  `).join('');
}

function toggleMission(el) {
  el.classList.toggle('expanded');
}

// Search
document.getElementById('search-input').addEventListener('input', renderMissions);

// Type filters
document.querySelectorAll('.filter-chip[data-filter]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip[data-filter]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentTypeFilter = chip.dataset.filter;
    renderMissions();
  });
});

// Status filters
document.querySelectorAll('.status-chip[data-status]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.status-chip[data-status]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentStatusFilter = chip.dataset.status;
    renderMissions();
  });
});

// --- CRUD ---

async function markDone(id) {
  try {
    await fetch(`${API}/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done', completed_at: new Date().toISOString() })
    });
    loadMissions();
    loadStats();
  } catch (err) {
    console.error('Failed to mark done:', err);
  }
}

async function deleteMission(id) {
  if (!confirm('Delete this mission?')) return;
  try {
    await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' });
    loadMissions();
    loadStats();
  } catch (err) {
    console.error('Failed to delete:', err);
  }
}

function editMission(id) {
  const task = allTasks.find(t => t.id === id);
  if (!task) return;

  editingTaskId = id;
  document.getElementById('modal-title').textContent = 'Edit Mission';
  document.getElementById('form-summary').value = task.summary || '';
  document.getElementById('form-type').value = task.type || 'task';
  document.getElementById('form-priority').value = task.priority || 'medium';
  document.getElementById('form-detail').value = task.detail || '';
  document.getElementById('form-recurrence').value = task.recurrence || '';
  document.getElementById('form-prompt').value = task.prompt || '';
  document.getElementById('form-project').value = task.project || '';
  document.getElementById('form-notify-type').value = task.notify_type || 'sound';

  if (task.next_run) {
    const d = new Date(task.next_run);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('form-next-run').value = local;
  } else {
    document.getElementById('form-next-run').value = '';
  }

  document.getElementById('modal-overlay').classList.add('open');
}

// New mission
document.getElementById('btn-new-mission').addEventListener('click', () => {
  editingTaskId = null;
  document.getElementById('modal-title').textContent = 'New Mission';
  document.getElementById('form-summary').value = '';
  document.getElementById('form-type').value = 'task';
  document.getElementById('form-priority').value = 'medium';
  document.getElementById('form-detail').value = '';
  document.getElementById('form-recurrence').value = '';
  document.getElementById('form-next-run').value = '';
  document.getElementById('form-prompt').value = '';
  document.getElementById('form-project').value = '';
  document.getElementById('form-notify-type').value = 'sound';
  document.getElementById('modal-overlay').classList.add('open');
});

// Close modal
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// Save mission
document.getElementById('modal-save').addEventListener('click', async () => {
  const summary = document.getElementById('form-summary').value.trim();
  if (!summary) return;

  const body = {
    type: document.getElementById('form-type').value,
    summary,
    detail: document.getElementById('form-detail').value || null,
    recurrence: document.getElementById('form-recurrence').value || null,
    next_run: document.getElementById('form-next-run').value ? new Date(document.getElementById('form-next-run').value).toISOString() : null,
    prompt: document.getElementById('form-prompt').value || null,
    project: document.getElementById('form-project').value || null,
    priority: document.getElementById('form-priority').value,
    notify_type: document.getElementById('form-notify-type').value,
  };

  try {
    if (editingTaskId) {
      await fetch(`${API}/api/tasks/${editingTaskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } else {
      await fetch(`${API}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    }
    closeModal();
    loadMissions();
    loadStats();
  } catch (err) {
    console.error('Failed to save mission:', err);
  }
});

// --- Channels ---

const channelDefs = [
  { key: 'discord', name: 'Discord', icon: '🟣', fields: [{ key: 'webhook_url', label: 'Webhook URL', type: 'text' }] },
  { key: 'telegram', name: 'Telegram', icon: '🔵', fields: [{ key: 'bot_token', label: 'Bot Token', type: 'password' }, { key: 'chat_id', label: 'Chat ID', type: 'text' }] },
  { key: 'slack', name: 'Slack', icon: '🟢', fields: [{ key: 'webhook_url', label: 'Webhook URL', type: 'text' }] },
  { key: 'system', name: 'System', icon: '💻', fields: [] }
];

let channelsData = {};

async function loadChannels() {
  const grid = document.getElementById('channels-grid');
  try {
    const res = await fetch(`${API}/api/channels`);
    channelsData = await res.json();
  } catch {
    channelsData = {
      discord: { enabled: false, webhook_url: '' },
      telegram: { enabled: false, bot_token: '', chat_id: '' },
      slack: { enabled: false, webhook_url: '' },
      system: { enabled: true }
    };
  }

  grid.innerHTML = channelDefs.map(ch => {
    const data = channelsData[ch.key] || {};
    const enabled = data.enabled || false;
    return `
      <div class="channel-card">
        <div class="channel-header">
          <span class="channel-name">
            <span class="channel-icon">${ch.icon}</span>
            ${ch.name}
          </span>
          <div class="channel-status ${enabled ? 'connected' : ''}" title="${enabled ? 'Connected' : 'Disconnected'}"></div>
        </div>
        ${ch.fields.length > 0 ? `
          <div class="channel-fields">
            ${ch.fields.map(f => `
              <div class="channel-field">
                <label>${f.label}</label>
                <input type="${f.type}" data-channel="${ch.key}" data-field="${f.key}" value="${escapeHtml(data[f.key] || '')}" placeholder="Enter ${f.label.toLowerCase()}...">
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="channel-fields">
            <p style="font-size: 13px; color: var(--text-muted)">System notifications use macOS native alerts. No configuration needed.</p>
          </div>
        `}
        <div class="channel-actions">
          <div class="toggle ${enabled ? 'active' : ''}" data-channel="${ch.key}" onclick="toggleChannel(this, '${ch.key}')"></div>
          <button class="btn btn-ghost btn-sm" onclick="saveChannels()">Save</button>
          <button class="btn btn-ghost btn-sm" onclick="testChannel('${ch.key}')">Test</button>
        </div>
      </div>
    `;
  }).join('');
}

function toggleChannel(el, key) {
  el.classList.toggle('active');
  if (!channelsData[key]) channelsData[key] = {};
  channelsData[key].enabled = el.classList.contains('active');
}

async function saveChannels() {
  document.querySelectorAll('.channel-field input').forEach(input => {
    const ch = input.dataset.channel;
    const field = input.dataset.field;
    if (!channelsData[ch]) channelsData[ch] = {};
    channelsData[ch][field] = input.value;
  });

  try {
    await fetch(`${API}/api/channels`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(channelsData)
    });
    loadChannels();
  } catch (err) {
    console.error('Failed to save channels:', err);
  }
}

async function testChannel(channel) {
  try {
    const res = await fetch(`${API}/api/channels/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel })
    });
    const data = await res.json();
    alert(data.message || 'Test sent!');
  } catch (err) {
    alert('Test failed: ' + err.message);
  }
}

// --- Chat ---

const chatHistory = [];
let currentProvider = null;
let currentModel = null;
let chatBusy = false;

async function loadChatConfig() {
  try {
    const res = await fetch(`${API}/api/chat-config`);
    const config = await res.json();
    currentProvider = config.provider;
    currentModel = config.model;

    document.getElementById('chat-system-prompt').value = config.system_prompt || '';
    document.getElementById('chat-model-input').value = config.model || '';

    // Populate provider select from server-side registry
    const sel = document.getElementById('chat-provider');
    sel.innerHTML = '';
    (config.providers || []).forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = `${p.name}${p.available ? '' : ' (not configured)'}`;
      opt.disabled = !p.available;
      if (p.is_default) opt.selected = true;
      sel.appendChild(opt);
    });

    document.getElementById('chat-secrets-backend').textContent = config.secrets_backend || '';
  } catch (err) {
    console.error('Failed to load chat config:', err);
  }
}

document.getElementById('btn-save-chat-config').addEventListener('click', async () => {
  const body = {
    provider: document.getElementById('chat-provider').value,
    model: document.getElementById('chat-model-input').value || null,
    system_prompt: document.getElementById('chat-system-prompt').value,
  };
  try {
    await fetch(`${API}/api/chat-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    currentProvider = body.provider;
    currentModel = body.model;
  } catch (err) {
    console.error('Failed to save chat config:', err);
  }
});

function addChatMessage(text, role) {
  const container = document.getElementById('chat-messages');
  const welcome = container.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  const msg = document.createElement('div');
  msg.className = `chat-message ${role}`;
  msg.textContent = text;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  return msg;
}

document.getElementById('btn-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

async function sendChat() {
  if (chatBusy) return;
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  chatHistory.push({ role: 'user', content: text });
  addChatMessage(text, 'user');
  input.value = '';

  const assistantEl = addChatMessage('', 'ai');
  assistantEl.classList.add('streaming');
  chatBusy = true;

  const provider = document.getElementById('chat-provider').value || currentProvider;
  const model = document.getElementById('chat-model-input').value || currentModel || undefined;
  const systemPrompt = document.getElementById('chat-system-prompt').value || undefined;

  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        model,
        system_prompt: systemPrompt,
        messages: chatHistory,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      assistantEl.textContent = `⚠ ${err.error}`;
      chatHistory.pop(); // drop the user turn so they can retry
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';
    let hadError = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const lines = raw.split('\n');
        let event = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;

        let payload;
        try { payload = JSON.parse(data); } catch { continue; }

        if (event === 'chunk' && payload.text) {
          accumulated += payload.text;
          assistantEl.textContent = accumulated;
          document.getElementById('chat-messages').scrollTop = 1e9;
        } else if (event === 'error') {
          hadError = payload.message;
        }
      }
    }

    assistantEl.classList.remove('streaming');
    if (hadError) {
      assistantEl.textContent = `⚠ ${hadError}`;
      chatHistory.pop();
    } else {
      chatHistory.push({ role: 'assistant', content: accumulated });
    }
  } catch (err) {
    assistantEl.textContent = `⚠ ${err.message}`;
    chatHistory.pop();
  } finally {
    chatBusy = false;
  }
}

// --- Logs ---

async function loadLogs() {
  const list = document.getElementById('logs-list');
  showSkeleton(list);

  try {
    const statusParam = currentLogFilter !== 'all' ? `?status=${currentLogFilter}` : '';
    const res = await fetch(`${API}/api/logs${statusParam}`);
    const logs = await res.json();

    if (logs.length === 0) {
      list.innerHTML = `<div class="empty-state">
        <div class="empty-state-icon">&#x1F4CB;</div>
        <h3>No execution logs yet</h3>
        <p>Logs will appear here as SEAL runs your missions.</p>
      </div>`;
      return;
    }

    list.innerHTML = logs.map(log => {
      const success = log.exit_code === 0 || log.exit_code === null;
      return `
        <div class="log-entry" onclick="this.classList.toggle('expanded')">
          <div class="log-status-dot ${success ? 'success' : 'failed'}"></div>
          <div class="log-info">
            <div class="log-summary">${escapeHtml(log.summary || log.task_id)}</div>
            <div class="log-time">${new Date(log.started_at).toLocaleString()}</div>
          </div>
          ${log.type ? `<span class="badge badge-type" data-type="${log.type}">${log.type}</span>` : ''}
          <span class="log-duration">${formatDuration(log.started_at, log.finished_at)}</span>
          <div class="log-detail">
            ${log.stdout_preview ? `<div class="log-output">${escapeHtml(log.stdout_preview)}</div>` : ''}
            ${log.stderr_preview ? `<div class="log-output" style="color: var(--error)">${escapeHtml(log.stderr_preview)}</div>` : ''}
            ${!log.stdout_preview && !log.stderr_preview ? '<div class="log-output">No output captured.</div>' : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">&#x26A0;</div>
      <h3>Failed to load logs</h3>
      <p>${escapeHtml(err.message)}</p>
    </div>`;
  }
}

// Log filters
document.querySelectorAll('[data-log-status]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('[data-log-status]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentLogFilter = chip.dataset.logStatus;
    loadLogs();
  });
});

// --- Calendar ---

async function loadCalendar() {
  const grid = document.getElementById('calendar-grid');

  try {
    const res = await fetch(`${API}/api/tasks?status=pending`);
    const tasks = await res.json();
    const recurring = tasks.filter(t => t.recurrence || t.next_run);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    grid.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      const dayOfWeek = date.getDay();
      const isToday = i === 0;

      // Match tasks for this day
      const dayTasks = recurring.filter(t => {
        // Check next_run date
        if (t.next_run) {
          const nr = new Date(t.next_run);
          nr.setHours(0, 0, 0, 0);
          if (nr.getTime() === date.getTime()) return true;
        }
        // Check cron recurrence (simple weekday matching)
        if (t.recurrence) {
          return matchesCronDay(t.recurrence, dayOfWeek);
        }
        return false;
      });

      const dayEl = document.createElement('div');
      dayEl.className = `calendar-day ${isToday ? 'today' : ''}`;
      dayEl.innerHTML = `
        <div class="calendar-day-header">
          <span class="calendar-day-name">${days[dayOfWeek]}</span>
          <span class="calendar-day-number">${date.getDate()}</span>
        </div>
        ${dayTasks.length > 0 ? dayTasks.map(t => `
          <div class="calendar-task" data-type="${t.type}" title="${escapeHtml(t.summary)}">
            ${escapeHtml(t.summary)}
          </div>
        `).join('') : ''}
      `;
      grid.appendChild(dayEl);
    }
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">&#x1F4C5;</div>
      <h3>Calendar unavailable</h3>
      <p>Could not load task schedule.</p>
    </div>`;
  }
}

function matchesCronDay(cron, dayOfWeek) {
  // Parse the day-of-week field from cron expression
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const dowField = parts[4];
  if (dowField === '*') return true;

  // Handle ranges (1-5), lists (1,3,5), and single values
  const segments = dowField.split(',');
  for (const seg of segments) {
    if (seg.includes('-')) {
      const [start, end] = seg.split('-').map(Number);
      if (dayOfWeek >= start && dayOfWeek <= end) return true;
    } else {
      if (parseInt(seg) === dayOfWeek) return true;
    }
  }
  return false;
}

// --- Workspaces (v0.3.0 "Eye" layer) ---

let workspacesPollTimer = null;
let workspaceScanResults = [];

function startWorkspacesTab() {
  loadWorkspaces();
  stopWorkspacesPolling();
  workspacesPollTimer = setInterval(loadWorkspaces, 10000);
}

function stopWorkspacesPolling() {
  if (workspacesPollTimer) {
    clearInterval(workspacesPollTimer);
    workspacesPollTimer = null;
  }
}

async function loadWorkspaces() {
  const list = document.getElementById('workspaces-list');
  if (!list) return;
  try {
    const res = await fetch(`${API}/api/workspaces`);
    const repos = await res.json();
    renderWorkspaces(repos);
  } catch (err) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">&#x26A0;</div>
      <h3>Could not load workspaces</h3>
      <p>${escapeHtml(err.message)}</p>
    </div>`;
  }
}

function renderWorkspaces(repos) {
  const list = document.getElementById('workspaces-list');
  if (!Array.isArray(repos) || repos.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">&#x1F4C1;</div>
      <h3>No workspaces watched yet</h3>
      <p>Click "Add workspace" above to scan a parent folder for git repositories.</p>
    </div>`;
    return;
  }

  list.innerHTML = `
    <table class="workspaces-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Path</th>
          <th>Installed</th>
          <th>Hook status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${repos.map(r => {
          const installed = r.installed_at ? new Date(r.installed_at).toLocaleString() : '—';
          const hooksOk = r.hooks_installed && r.has_seal_hooks;
          const statusLabel = hooksOk ? 'installed' : (r.fallback_scraper ? 'fallback only' : 'missing');
          const statusClass = hooksOk ? 'ok' : (r.fallback_scraper ? 'warn' : 'err');
          return `
            <tr>
              <td><strong>${escapeHtml(r.name)}</strong></td>
              <td class="ws-path" title="${escapeHtml(r.path)}">${escapeHtml(r.path)}</td>
              <td>${escapeHtml(installed)}</td>
              <td><span class="ws-hook-badge ${statusClass}">${statusLabel}</span></td>
              <td class="ws-actions">
                <button class="btn btn-danger btn-sm" onclick="removeWorkspace(${r.id})">Remove</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function removeWorkspace(id) {
  if (!confirm('Stop watching this workspace? SEAL will uninstall its git hooks (and restore any backup).')) return;
  try {
    const res = await fetch(`${API}/api/workspaces/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    loadWorkspaces();
  } catch (err) {
    alert(`Failed to remove workspace: ${err.message}`);
  }
}

// Add panel toggle
let pickedParentPath = null;

document.getElementById('btn-add-workspace')?.addEventListener('click', () => {
  const panel = document.getElementById('workspace-add-panel');
  panel.hidden = !panel.hidden;
});

document.getElementById('btn-cancel-add-workspace')?.addEventListener('click', () => {
  document.getElementById('workspace-add-panel').hidden = true;
  document.getElementById('workspace-scan-results').innerHTML = '';
  document.getElementById('workspace-scan-actions').hidden = true;
  document.getElementById('workspace-scan-status').textContent = '';
  document.getElementById('workspace-picked-path').hidden = true;
  document.getElementById('workspace-picked-path').textContent = '';
  pickedParentPath = null;
  workspaceScanResults = [];
});

document.getElementById('btn-pick-folder')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('workspace-scan-status');
  const pickedEl = document.getElementById('workspace-picked-path');
  try {
    const res = await fetch(`${API}/api/pick-folder`, { method: 'POST' });
    const data = await res.json();
    if (data.cancelled) return;
    if (!res.ok || !data.path) throw new Error(data.error || 'pick failed');
    pickedParentPath = data.path;
    pickedEl.textContent = data.path;
    pickedEl.hidden = false;
    await scanWorkspaces(data.path);
  } catch (err) {
    statusEl.textContent = `Picker failed: ${err.message}`;
  }
});

async function scanWorkspaces(parentPath) {
  if (!parentPath) return;
  const resultsEl = document.getElementById('workspace-scan-results');
  const actionsEl = document.getElementById('workspace-scan-actions');
  const statusEl = document.getElementById('workspace-scan-status');
  resultsEl.innerHTML = '<div class="ws-scan-loading">Scanning…</div>';
  statusEl.textContent = '';
  actionsEl.hidden = true;

  try {
    const res = await fetch(`${API}/api/workspaces/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_path: parentPath }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    workspaceScanResults = data.repos || [];
    if (workspaceScanResults.length === 0) {
      resultsEl.innerHTML = `<div class="ws-scan-empty">No git repositories found directly under <code>${escapeHtml(parentPath)}</code>.</div>`;
      return;
    }
    resultsEl.innerHTML = workspaceScanResults.map((r, i) => `
      <label class="ws-scan-row${r.already_watched ? ' watching' : ''}">
        <input type="checkbox" data-idx="${i}" ${r.already_watched ? 'disabled' : ''}>
        <span class="ws-scan-name">${escapeHtml(r.name)}</span>
        <span class="ws-scan-path">${escapeHtml(r.path)}</span>
        ${r.already_watched ? '<span class="ws-scan-tag">watching</span>' : ''}
      </label>
    `).join('');
    actionsEl.hidden = false;
  } catch (err) {
    resultsEl.innerHTML = `<div class="ws-scan-error">Scan failed: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById('btn-watch-selected')?.addEventListener('click', async () => {
  const checked = document.querySelectorAll('#workspace-scan-results input[type=checkbox]:checked');
  const paths = Array.from(checked).map(cb => workspaceScanResults[parseInt(cb.dataset.idx, 10)].path);
  if (paths.length === 0) return;
  const statusEl = document.getElementById('workspace-scan-status');
  statusEl.textContent = `Installing hooks in ${paths.length} repo(s)…`;
  try {
    const res = await fetch(`${API}/api/workspaces/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    const data = await res.json();
    const ok = (data.added || []).length;
    const failed = (data.failed || []).length;
    statusEl.textContent = `Added ${ok}${failed ? `, ${failed} failed` : ''}.`;
    if (failed > 0) {
      const lines = data.failed.map(f => `${f.path}: ${f.error}`).join('\n');
      console.warn('[workspaces] failed:', lines);
    }
    loadWorkspaces();
  } catch (err) {
    statusEl.textContent = `Bulk install failed: ${err.message}`;
  }
});

// --- Events (v0.3.0 "Eye" layer) ---

let eventsPollTimer = null;
let lastEventsPayload = [];

function startEventsTab() {
  loadEvents();
  stopEventsPolling();
  eventsPollTimer = setInterval(loadEvents, 5000);
}

function stopEventsPolling() {
  if (eventsPollTimer) {
    clearInterval(eventsPollTimer);
    eventsPollTimer = null;
  }
}

async function loadEvents() {
  const list = document.getElementById('events-list');
  if (!list) return;
  const params = new URLSearchParams();
  const source = document.getElementById('events-source').value;
  const kind = document.getElementById('events-kind').value;
  const since = document.getElementById('events-since').value;
  const limit = document.getElementById('events-limit').value || '100';
  if (source) params.set('source', source);
  if (kind) params.set('kind', kind);
  if (since) params.set('since', new Date(since).toISOString());
  params.set('limit', limit);

  try {
    const res = await fetch(`${API}/api/events?${params.toString()}`);
    const events = await res.json();
    lastEventsPayload = events;
    refreshEventDropdowns(events);
    renderEvents(events);
  } catch (err) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">&#x26A0;</div>
      <h3>Could not load events</h3>
      <p>${escapeHtml(err.message)}</p>
    </div>`;
  }
}

function refreshEventDropdowns(events) {
  const sourceSel = document.getElementById('events-source');
  const kindSel = document.getElementById('events-kind');
  const currentSource = sourceSel.value;
  const currentKind = kindSel.value;

  const sources = Array.from(new Set(events.map(e => e.source))).sort();
  sourceSel.innerHTML = '<option value="">All</option>' +
    sources.map(s => `<option value="${escapeHtml(s)}"${s === currentSource ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');

  // Kinds cascade from selected source.
  const filteredForKinds = currentSource ? events.filter(e => e.source === currentSource) : events;
  const kinds = Array.from(new Set(filteredForKinds.map(e => e.kind))).sort();
  kindSel.innerHTML = '<option value="">All</option>' +
    kinds.map(k => `<option value="${escapeHtml(k)}"${k === currentKind ? ' selected' : ''}>${escapeHtml(k)}</option>`).join('');
}

function renderEvents(events) {
  const list = document.getElementById('events-list');
  const search = document.getElementById('events-search').value.toLowerCase().trim();

  let filtered = events;
  if (search) {
    filtered = filtered.filter(e => {
      try {
        return JSON.stringify(e.data).toLowerCase().includes(search);
      } catch {
        return false;
      }
    });
  }

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">&#x1F441;</div>
      <h3>No events yet</h3>
      <p>Events will appear here as SEAL observers (git, calendar, ...) emit them.</p>
    </div>`;
    return;
  }

  list.innerHTML = `
    <table class="events-table">
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Source</th>
          <th>Kind</th>
          <th>Data</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map(e => {
          let summary = '';
          let full = '';
          try {
            full = JSON.stringify(e.data, null, 2);
            const oneLine = JSON.stringify(e.data);
            summary = oneLine && oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : (oneLine || '');
          } catch {
            full = String(e.data);
            summary = full.slice(0, 80);
          }
          const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
          return `
            <tr class="event-row" onclick="this.classList.toggle('expanded')">
              <td class="event-ts">${escapeHtml(ts)}</td>
              <td><span class="event-source">${escapeHtml(e.source)}</span></td>
              <td><span class="event-kind">${escapeHtml(e.kind)}</span></td>
              <td>
                <span class="event-summary">${escapeHtml(summary)}</span>
                <pre class="event-full">${escapeHtml(full)}</pre>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// Filter wiring (re-render from cached payload, no extra fetch).
document.getElementById('events-search')?.addEventListener('input', () => renderEvents(lastEventsPayload));
document.getElementById('events-source')?.addEventListener('change', () => loadEvents());
document.getElementById('events-kind')?.addEventListener('change', () => renderEvents(lastEventsPayload));
document.getElementById('events-since')?.addEventListener('change', () => loadEvents());
document.getElementById('events-limit')?.addEventListener('change', () => loadEvents());

// --- Init ---

loadStats();
loadMissions();
