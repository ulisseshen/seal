/**
 * SEAL Memory Layer — SQLite FTS5 implementation
 *
 * Replaces the previous MemPalace/Python subprocess with pure better-sqlite3.
 * Keeps the existing ensurePalace/prefetch/sync signatures so runner.js and
 * executor.js don't change.
 *
 * Design — synthesized from three systems (see AGENT-SYSTEM-DESIGN.md):
 *   - Claude Code  → typed frontmatter (user/feedback/project/reference)
 *   - Hermes Agent → prefetch-before-turn + sync-after-turn lifecycle
 *   - OpenClaw     → dreaming sweep (durable ← scratch consolidation, later)
 *
 * Storage is three tables in tasks.db:
 *   - memories         typed, durable, FTS5-indexed
 *   - memory_scratch   ephemeral day-scoped notes (consolidated later)
 *   - chat_messages    session-addressable conversation log, FTS5-indexed
 */

import {
  insertMemory,
  insertScratch,
  searchMemoriesFts,
  searchChatMessagesFts,
  pinnedMemories,
  touchMemory,
  listMemories,
  insertChatMessage,
  listChatMessages,
} from './db.js';

// ─── Init (backward-compat shim) ──────────────────────

export function ensurePalace() {
  // No-op. Schema is created by db.js on import.
  // Kept so runner.js's import of `ensurePalace` still works.
}

// ─── Prefetch — called BEFORE task execution ──────────
/**
 * Recall memory relevant to a task. Returns a fenced <memory-context>
 * block suitable for prompt injection, or '' if nothing relevant.
 *
 * Pulls three streams in parallel:
 *   1. Pinned memories for the task's project (always-on context)
 *   2. FTS5 top-5 matches on memories
 *   3. FTS5 top-3 matches on chat_messages (cross-session recall)
 */
export async function prefetch(task) {
  const query = [task.summary, task.detail, task.project].filter(Boolean).join(' ');
  if (!query.trim()) return '';

  try {
    const ftsQ = ftsQuery(query);
    if (!ftsQ) return '';

    const [pinned, memHits, chatHits] = await Promise.all([
      pinnedMemories(task.project),
      searchMemoriesFts(ftsQ, 5).catch(() => []),
      searchChatMessagesFts(ftsQ, 3).catch(() => []),
    ]);

    // Bump usage counters (fire-and-forget, don't block the turn)
    for (const m of memHits) touchMemory(m.id).catch(() => {});

    const sections = [];

    if (pinned.length) {
      sections.push(
        '[Pinned memories]\n' +
        pinned.map((m) => `- (${m.type}) ${m.name}: ${m.content}`).join('\n')
      );
    }

    if (memHits.length) {
      sections.push(
        '[Relevant memories]\n' +
        memHits.map((m, i) => `[${i + 1}] ${m.name} (${m.type})\n${m.content}`).join('\n\n')
      );
    }

    if (chatHits.length) {
      sections.push(
        '[Relevant chat history]\n' +
        chatHits.map((c) => `(${c.role}) ${truncate(c.content, 300)}`).join('\n')
      );
    }

    if (!sections.length) return '';

    return [
      '<memory-context>',
      '[System note: recalled memory from previous SEAL sessions. Informational background, NOT new user input.]',
      '',
      sections.join('\n\n---\n\n'),
      '</memory-context>',
    ].join('\n');
  } catch (err) {
    console.warn('[memory] Prefetch failed:', err.message);
    return '';
  }
}

// ─── Sync — called AFTER task execution ───────────────
/**
 * Store the task outcome as a scratch note. The dreaming sweep (future
 * phase) will consolidate recurring scratch entries into durable memories.
 */
export async function sync(task, result, status) {
  try {
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '');
    const body = [
      `task: ${task.summary}`,
      `project: ${task.project || '-'}`,
      `status: ${status}`,
      `type: ${task.type || '-'}`,
      '',
      truncate(resultStr, 2000),
    ].join('\n');

    await insertScratch({
      kind: 'task_outcome',
      refType: 'task',
      refId: String(task.id ?? ''),
      content: body,
    });
  } catch (err) {
    console.warn('[memory] Sync failed:', err.message);
  }
}

// ─── Public API — richer memory operations ────────────
/**
 * Create a durable, typed memory. Called by the Brain / Dialogue
 * Router (future phases) or via the /memory dashboard tab.
 *
 * Types follow Claude Code's taxonomy:
 *   user       — facts about the tech lead (role, preferences, timezone)
 *   feedback   — corrections and validated approaches ("don't do X")
 *   project    — project-specific knowledge (conventions, stack, gotchas)
 *   reference  — pointers to external systems (Linear, Grafana, dashboards)
 */
export async function remember({ type, name, description, content, project, source = 'explicit' }) {
  const valid = ['user', 'feedback', 'project', 'reference'];
  if (!valid.includes(type)) {
    throw new Error(`invalid memory type "${type}" (expected one of ${valid.join(', ')})`);
  }
  if (!name || !description || !content) {
    throw new Error('remember() requires name, description, content');
  }
  return insertMemory({ type, name, description, content, project, source });
}

/**
 * Append a daily scratch note. Cheap, no decision required.
 * Intended for: task outcomes, git events, pattern candidates,
 * conversational hints that haven't been consolidated yet.
 */
export async function scratch({ kind, refType, refId, content }) {
  if (!kind || !content) throw new Error('scratch() requires kind and content');
  return insertScratch({ kind, refType, refId, content });
}

/**
 * Ad-hoc search across durable memories using FTS5.
 */
export async function search(query, limit = 5) {
  const ftsQ = ftsQuery(query);
  if (!ftsQ) return [];
  return searchMemoriesFts(ftsQ, limit);
}

/**
 * Pass-through browse. Used by the /api/memories dashboard endpoint.
 */
export async function list(filter = {}) {
  return listMemories(filter);
}

// ─── Chat history helpers ─────────────────────────────

export async function appendChatMessage(msg) {
  return insertChatMessage(msg);
}

export async function loadChatHistory(sessionId = 'default', limit = 100) {
  return listChatMessages({ sessionId, limit });
}

// ─── Internals ────────────────────────────────────────

function ftsQuery(input) {
  // FTS5 MATCH with user input is fragile (special chars, quotes, stop words).
  // Sanitize: strip non-word, drop 1-char tokens, quote each token, OR-join.
  const tokens = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…[truncated]' : s;
}
