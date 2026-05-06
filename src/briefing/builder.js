/**
 * BriefingBuilder — assembles the daily briefing from multiple data sources.
 *
 * Pulls from SEAL tasks (SQLite), knowledge engine (bugs, decisions, work-items),
 * and pending actions. Formats as HTML for Telegram delivery.
 */

const WEEKDAYS_PT = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const MONTHS_PT = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
];

const PRIORITY_EMOJI = { high: '🔴', medium: '🟡', low: '🟢' };
const MAX_ITEMS = 20;

export class BriefingBuilder {
  /**
   * @param {object} db - SEAL database wrapper (better-sqlite3 async)
   * @param {import('../knowledge/engine.js').KnowledgeEngine} engine
   * @param {import('../actions/registry.js').ActionRegistry} [actionRegistry]
   */
  constructor(db, engine, actionRegistry) {
    this.db = db;
    this.engine = engine;
    this.actionRegistry = actionRegistry;
  }

  /**
   * Build the briefing payload.
   * @returns {Promise<{sections: BriefingSection[], actions: BriefingAction[], generatedAt: string}>}
   */
  async build() {
    const now = new Date();
    const sections = [];
    const actions = [];

    // Section 1: SEAL Tasks
    const taskSection = await this._buildTaskSection(now);
    if (taskSection) {
      sections.push(taskSection);
      actions.push(...(taskSection.actions || []));
    }

    // Section 2: Knowledge Highlights (bugs, decisions)
    const knowledgeSection = await this._buildKnowledgeSection(now);
    if (knowledgeSection) sections.push(knowledgeSection);

    // Section 3: Board Status (work-items, sprints)
    const boardSection = await this._buildBoardSection();
    if (boardSection) sections.push(boardSection);

    // Section 4: Pending Actions
    const pendingSection = await this._buildPendingActionsSection();
    if (pendingSection) sections.push(pendingSection);

    return { sections, actions, generatedAt: now.toISOString() };
  }

  /**
   * Format the briefing as a GatewayMessage (HTML for Telegram).
   * @param {{sections: BriefingSection[], actions: BriefingAction[], generatedAt: string}} briefing
   * @returns {import('../gateway/base.js').GatewayMessage}
   */
  formatForGateway(briefing) {
    const now = new Date(briefing.generatedAt);
    const header = `🌅 <b>Briefing Diário — ${_formatDateHeader(now)}</b>`;

    if (briefing.sections.length === 0) {
      return {
        text: `${header}\n\nTudo tranquilo hoje. Sem itens urgentes. ☀️`,
        html: `${header}\n\nTudo tranquilo hoje. Sem itens urgentes. ☀️`,
        level: 'info',
        category: 'briefing',
        actions: [],
      };
    }

    const parts = [header, ''];
    for (const section of briefing.sections) {
      parts.push(`${section.emoji} <b>${section.title}</b>`);
      for (const item of section.items) {
        parts.push(`• ${item}`);
      }
      parts.push('');
    }

    const text = parts.join('\n').trim();

    return {
      text,
      html: text,
      level: 'info',
      category: 'briefing',
      actions: briefing.actions,
    };
  }

  // ─── Section builders ─────────────────────────────────────

  async _buildTaskSection(now) {
    try {
      const tasks = await this.db.all(
        `SELECT * FROM tasks
         WHERE status IN ('pending','failed','firing')
         ORDER BY
           CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           execute_at ASC
         LIMIT ?`,
        [MAX_ITEMS]
      );

      if (!tasks || tasks.length === 0) return null;

      const items = [];
      const actions = [];

      for (const task of tasks) {
        const emoji = PRIORITY_EMOJI[task.priority] || '⚪';
        const statusTag = _taskStatusTag(task, now);
        const line = `${emoji} [${task.priority}] ${_escapeHtml(task.summary)}${statusTag}`;
        items.push(line);

        // Add quick-action buttons for actionable tasks
        if (task.status === 'firing' || task.status === 'pending') {
          actions.push({
            label: `✅ Done: ${_truncate(task.summary, 20)}`,
            callbackData: `briefing:done:${task.id}`,
          });
        }
      }

      // Add a snooze-all button if there are firing tasks
      const firingCount = tasks.filter(t => t.status === 'firing').length;
      if (firingCount > 0) {
        actions.push({
          label: '⏰ Snooze 1h (firing)',
          callbackData: 'briefing:snooze-all:firing',
        });
      }

      return { title: 'Tasks SEAL', emoji: '📋', items, actions };
    } catch (err) {
      console.error('[seal:briefing] Error building task section:', err.message);
      return null;
    }
  }

  async _buildKnowledgeSection(now) {
    try {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const items = [];

      // Recent bugs
      const bugs = await this.engine.listByType('bug', 10);
      const recentBugs = (bugs || []).filter(b => b.date && b.date >= sevenDaysAgo);

      for (const bug of recentBugs.slice(0, 5)) {
        const meta = _safeParseMeta(bug.meta);
        const status = meta.status || meta.state || '';
        const statusSuffix = status ? ` — <i>${_escapeHtml(status)}</i>` : '';
        const idSuffix = bug.external_id ? ` (#${_escapeHtml(bug.external_id)})` : '';
        items.push(`🐛 ${_escapeHtml(bug.title)}${idSuffix}${statusSuffix}`);
      }

      // Recent decisions
      const decisions = await this.engine.listByType('decision', 10);
      const recentDecisions = (decisions || []).filter(d => d.date && d.date >= sevenDaysAgo);

      for (const dec of recentDecisions.slice(0, 3)) {
        items.push(`📝 ${_escapeHtml(dec.title)}`);
      }

      if (items.length === 0) return null;
      return { title: 'Destaques Recentes', emoji: '🔍', items };
    } catch (err) {
      console.error('[seal:briefing] Error building knowledge section:', err.message);
      return null;
    }
  }

  async _buildBoardSection() {
    try {
      const items = [];

      // Active work items
      const workItems = await this.engine.search('', { type: 'work-item' });
      const active = (workItems || []).filter(wi => {
        const meta = _safeParseMeta(wi.meta);
        const state = (meta.state || meta.status || '').toLowerCase();
        return state === 'active' || state === 'in progress' || state === 'em progresso';
      });

      if (active.length > 0) {
        items.push(`Em progresso: ${active.length} work items`);
      }

      // Sprint info
      const sprints = await this.engine.listByType('sprint', 3);
      const currentSprint = (sprints || []).find(s => {
        const meta = _safeParseMeta(s.meta);
        return meta.isCurrent || meta.is_current || meta.state === 'current';
      });

      if (currentSprint) {
        const meta = _safeParseMeta(currentSprint.meta);
        const completed = meta.completedItems || meta.completed_items || 0;
        const total = meta.totalItems || meta.total_items || 0;
        const sprintName = _escapeHtml(currentSprint.title);
        if (total > 0) {
          items.push(`Sprint: ${sprintName} (${completed}/${total} items done)`);
        } else {
          items.push(`Sprint: ${sprintName}`);
        }
      }

      if (items.length === 0) return null;
      return { title: 'Board', emoji: '📊', items };
    } catch (err) {
      console.error('[seal:briefing] Error building board section:', err.message);
      return null;
    }
  }

  async _buildPendingActionsSection() {
    try {
      const pending = await this.db.all(
        `SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?`,
        [5]
      );

      if (!pending || pending.length === 0) return null;

      const items = pending.map(p => {
        const summary = _escapeHtml(p.preview_summary || p.action_name || 'Ação pendente');
        return summary;
      });

      return { title: 'Pendente de Confirmação', emoji: '⏳', items };
    } catch (err) {
      console.error('[seal:briefing] Error building pending actions section:', err.message);
      return null;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────

function _formatDateHeader(date) {
  const day = date.getDate();
  const month = MONTHS_PT[date.getMonth()];
  const year = date.getFullYear();
  return `${day} ${month} ${year}`;
}

function _taskStatusTag(task, now) {
  if (task.status === 'failed') return ' — <i>falhou</i>';
  if (task.status === 'firing') return ' — <i>aguardando ack</i>';

  if (!task.execute_at) return '';

  const executeAt = new Date(task.execute_at);
  const diffMs = executeAt.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));

  if (diffDays < -1) return ` — <i>atrasado ${Math.abs(diffDays)}d</i>`;
  if (diffDays === -1) return ' — <i>atrasado ontem</i>';
  if (diffDays === 0) return ' — <i>hoje</i>';
  if (diffDays === 1) return ' — <i>amanhã</i>';
  return '';
}

function _escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _truncate(str, len) {
  if (!str || str.length <= len) return str || '';
  return str.slice(0, len) + '…';
}

function _safeParseMeta(meta) {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try { return JSON.parse(meta); } catch { return {}; }
}
