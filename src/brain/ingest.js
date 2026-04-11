/**
 * SEAL Ingest Loop (v0.10.0 "SEAL asks back")
 *
 * The crown-jewel release: data arrives, SEAL tries to match it against
 * a handler skill, and if nothing matches it queues the data for teaching.
 * The TL teaches SEAL once → handler skill is born → all future similar
 * data is auto-handled (with optional post-run notification).
 *
 * Design — AGENT-SYSTEM-DESIGN.md §3.9. This implementation is the
 * minimal viable ingest loop:
 *   - Manual entry point via POST /api/ingest (plus future gateway hooks)
 *   - Handler matcher: flat criteria JSON, AND semantics
 *   - Teaching: one LLM call that drafts handler metadata + flow.yaml
 *   - Single-approval gate: TL clicks once, handler skill is created,
 *     all future matches run automatically
 *
 * The 4-round teaching dialogue in §3.9.3 is simplified into a single
 * round: the LLM drafts a complete handler proposal that the TL can
 * approve / modify / reject. Multi-round teaching is v0.10.1+.
 */

import crypto from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  listHandlerMatchersForSource,
  insertIngest,
  getIngest,
  listIngest,
  updateIngest,
  upsertHandlerMatcher,
  insertSkill,
  getSkillByName,
} from '../db.js';
import { getProvider } from '../providers/index.js';
import { runSkill } from './skills.js';

const SEAL_DIR = process.env.SEAL_DIR || join(homedir(), '.config', 'seal');
const SKILLS_DIR = join(SEAL_DIR, 'skills');

// ─── Public API ───────────────────────────────────────

/**
 * Route an incoming event. Tries to match against an active handler
 * skill first; if nothing matches, interprets the event via the LLM
 * and queues it for the TL to teach.
 *
 * @param {{ source: string, data: object }} event
 * @returns {Promise<{ matched: true, handler, result } | { matched: false, queued, ingest_id }>}
 */
export async function runIngest(event) {
  if (!event || !event.source) {
    throw new Error('ingest event requires { source, data }');
  }

  // 1. Try matching an existing handler for this source.
  const handlers = await listHandlerMatchersForSource(event.source);
  for (const h of handlers) {
    if (matchesCriteria(event, h.criteria)) {
      try {
        const result = await runSkill(h.name, [JSON.stringify(event.data ?? {})]);
        return { matched: true, handler: h.name, result };
      } catch (err) {
        console.warn(`[ingest] handler ${h.name} threw:`, err.message);
        // Fall through to teaching — a broken handler shouldn't swallow the data.
      }
    }
  }

  // 2. No match: queue it for teaching.
  const ingestId = await insertIngest({ source: event.source, data: event.data ?? {} });

  // 3. Best-effort: interpret the event and draft a handler suggestion
  //    via the LLM. This is fire-and-forget from the caller's perspective
  //    but we await it here so the dashboard has something to show on the
  //    first poll. Errors fall back to state='pending' with no interpretation.
  try {
    const { interpretation, suggestedActions, suggestedHandler } = await interpretAndDraft(event);
    await updateIngest(ingestId, {
      interpretation,
      suggested_actions: suggestedActions,
      suggested_handler: suggestedHandler,
      state: 'interpreted',
    });
  } catch (err) {
    console.warn(`[ingest] LLM interpretation failed:`, err.message);
    await updateIngest(ingestId, { state: 'pending' });
  }

  return { matched: false, queued: true, ingest_id: ingestId };
}

/**
 * Approve a queued ingest by materializing the suggested handler skill.
 * Creates a flow.yaml handler under ~/.config/seal/skills/<name>/ and
 * registers its match criteria in handler_matchers. Future data matching
 * the same criteria runs through the handler automatically.
 *
 * The caller may pass an edited handler (modified interpretation/flow/
 * criteria) via `override`. Missing fields fall back to the LLM's draft.
 */
export async function approveIngestTeaching(ingestId, { override = null, userNotes = null } = {}) {
  const item = await getIngest(ingestId);
  if (!item) throw new Error(`ingest ${ingestId} not found`);
  if (item.decided_at) throw new Error(`ingest ${ingestId} already decided`);

  const draft = override || item.suggested_handler;
  if (!draft || !draft.name) {
    throw new Error('no handler draft available — run teaching first');
  }

  const slug = slugify(draft.name);
  const unique = await uniqueSlug(slug);
  const dir = join(SKILLS_DIR, unique);
  const flowPath = join(dir, 'flow.yaml');
  const metaPath = join(dir, 'skill.json');
  const readmePath = join(dir, 'README.md');
  const runsPath = join(dir, 'runs.jsonl');

  mkdirSync(dir, { recursive: true });

  const flowYaml = draft.flow_yaml || fallbackFlowYaml(unique, draft);
  writeFileSync(flowPath, flowYaml);

  const now = new Date().toISOString();
  const skillId = 's_' + crypto.createHash('sha1').update('handler:' + unique + now).digest('hex').slice(0, 12);

  const criteria = draft.match_criteria || {};
  const source = criteria.source || item.source;

  const meta = {
    id: skillId,
    name: unique,
    backend: 'flow',
    description: draft.description || item.interpretation || `Handler for ${item.source}`,
    invocation: `/seal ${unique}`,
    trigger: { kind: 'data_match', source, criteria },
    created_from: 'ingest_conversation',
    created_from_ingest: ingestId,
    notify_on_run: draft.notify_on_run ?? true,
    created_at: now,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  writeFileSync(readmePath, buildHandlerReadme(meta, item));
  writeFileSync(runsPath, '');

  await insertSkill({
    id: skillId,
    name: unique,
    description: meta.description,
    script_path: flowPath,
    pattern_id: null,
    proposal_id: null,
    parameters: [],
    triggers: { manual: true, pattern_match: false, cron: null, data_match: true },
    requires_ack: false,
    sandbox_profile: 'project-write',
  });

  await upsertHandlerMatcher({
    skill_id: skillId,
    source,
    priority: draft.priority ?? 0,
    criteria,
  });

  await updateIngest(ingestId, {
    state: 'taught',
    handler_skill_id: skillId,
    decided_at: now,
  });

  console.log(`[ingest] taught SEAL a new handler "${unique}" (skill ${skillId})`);
  return { skill_id: skillId, name: unique, dir, source, criteria };
}

/** Ignore a queued ingest without creating a handler. */
export async function ignoreIngest(ingestId) {
  const now = new Date().toISOString();
  await updateIngest(ingestId, { state: 'ignored', decided_at: now });
  return { ingest_id: ingestId, state: 'ignored' };
}

/** Browse the queue. */
export async function listIngestQueue(filter = {}) {
  return listIngest(filter);
}

// ─── Matching ─────────────────────────────────────────

function matchesCriteria(event, criteria) {
  if (!criteria || typeof criteria !== 'object') return false;
  const d = event.data || {};

  const str = (v) => (v == null ? '' : String(v));

  // source gate
  if (criteria.source && criteria.source !== event.source) return false;

  // from_matches / subject_matches / content_matches — regex on specific fields
  const regexChecks = [
    ['from_matches', str(d.from)],
    ['subject_matches', str(d.subject)],
    ['content_matches', str(d.body || d.content)],
  ];
  for (const [key, val] of regexChecks) {
    const pat = criteria[key];
    if (!pat) continue;
    const safe = sanitizeRegex(pat);
    try {
      if (!new RegExp(safe, 'i').test(val)) return false;
    } catch (err) {
      console.warn(`[ingest] invalid regex for ${key}: ${pat} (${err.message})`);
      return false;
    }
  }

  // keyword gates
  const anyOf = criteria.body_contains_any || criteria.content_contains_any;
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const hay = (str(d.body) + ' ' + str(d.content) + ' ' + str(d.subject)).toLowerCase();
    if (!anyOf.some((k) => hay.includes(String(k).toLowerCase()))) return false;
  }

  const allOf = criteria.body_contains_all || criteria.content_contains_all;
  if (Array.isArray(allOf) && allOf.length > 0) {
    const hay = (str(d.body) + ' ' + str(d.content) + ' ' + str(d.subject)).toLowerCase();
    if (!allOf.every((k) => hay.includes(String(k).toLowerCase()))) return false;
  }

  // equals gate (arbitrary keys)
  if (criteria.equals && typeof criteria.equals === 'object') {
    for (const [k, v] of Object.entries(criteria.equals)) {
      if (d[k] !== v) return false;
    }
  }

  return true;
}

// ─── LLM teaching drafter ─────────────────────────────

async function interpretAndDraft(event) {
  const cfg = readChatConfig();
  const providerName = cfg.provider || 'claude';
  const model = cfg.model || undefined;
  const provider = getProvider(providerName, { model });
  if (!provider.available()) {
    throw new Error(`provider ${providerName} not configured`);
  }

  const systemPrompt = INTERPRET_SYSTEM_PROMPT;
  const userPrompt = buildInterpretPrompt(event);

  let raw = '';
  for await (const chunk of provider.stream([{ role: 'user', content: userPrompt }], systemPrompt)) {
    raw += chunk;
  }

  const parsed = extractJson(raw);
  if (!parsed) throw new Error(`drafter returned unparseable output: ${raw.slice(0, 200)}`);

  return {
    interpretation: parsed.interpretation || '',
    suggestedActions: Array.isArray(parsed.actions) ? parsed.actions : [],
    suggestedHandler: parsed.handler || null,
  };
}

const INTERPRET_SYSTEM_PROMPT = [
  'You are SEAL\'s Ingest Interpreter.',
  'You read incoming data the TL\'s assistant does not yet know how to handle, and you draft a complete handler proposal the TL can approve in one click.',
  'You never act. You propose.',
  'You never auto-send, auto-commit, or take any irreversible action — every drafted flow must either save-as-draft, ask_user, or output information.',
  'Respond with a single JSON object, nothing else.',
].join(' ');

function buildInterpretPrompt(event) {
  const d = event.data || {};
  const dataSummary = JSON.stringify(d, null, 2).slice(0, 2000);

  return [
    'INCOMING DATA',
    `source: ${event.source}`,
    `data: ${dataSummary}`,
    '',
    'TASK',
    '1. Interpret what this data is and what the sender likely wants (one paragraph).',
    '2. Suggest 3-5 reasonable actions the TL might want. Each action is a short label.',
    '3. Draft a handler skill that would handle this and future similar data:',
    '   - `name`: short-slug like "newclient-proposal-review"',
    '   - `description`: one sentence',
    '   - `match_criteria`: JSON specifying when this handler should run for future events.',
    '     Supported keys: source, from_matches (regex), subject_matches (regex),',
    '     content_matches (regex), body_contains_any (array), body_contains_all (array),',
    '     equals (object of exact-match fields). Only include keys that make the match',
    '     specific enough to avoid false positives but general enough to catch similar data.',
    '   - `flow_yaml`: a minimal flow.yaml body using SEAL step types (llm.ask, shell.run,',
    '     ask_user.prompt, set.key). Event fields are available as {event.source},',
    '     {event.from}, {event.subject}, {event.body}. Never include auto-send or irreversible',
    '     steps. Always end with either an ask_user or an output that lands in the dashboard.',
    '4. If the data is spam / noise / genuinely nothing worth handling, output:',
    '   {"interpretation":"...","actions":["Ignore"],"handler":null}',
    '',
    'OUTPUT',
    'Respond with a single JSON object of this shape:',
    '{',
    '  "interpretation": "...",',
    '  "actions": ["Draft reply", "Create task", "Ignore", ...],',
    '  "handler": {',
    '    "name": "newclient-proposal-review",',
    '    "description": "...",',
    '    "match_criteria": { "source": "gmail", "from_matches": "@newclient\\\\.com$" },',
    '    "flow_yaml": "name: newclient-proposal-review\\ndescription: ...\\nsteps:\\n  - id: ..."',
    '  }',
    '}',
  ].join('\n');
}

// ─── Helpers ──────────────────────────────────────────

function readChatConfig() {
  const path = join(SEAL_DIR, 'chat-config.json');
  if (!existsSync(path)) return { provider: 'claude' };
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return { provider: 'claude' }; }
}

function extractJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw.trim()); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function slugify(name) {
  return String(name || 'handler')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'handler';
}

async function uniqueSlug(base) {
  let candidate = base;
  let n = 2;
  while (await getSkillByName(candidate)) {
    candidate = `${base}-${n++}`;
    if (n > 99) break;
  }
  return candidate;
}

function buildHandlerReadme(meta, ingest) {
  return [
    `# ${meta.name}`,
    '',
    meta.description,
    '',
    '## Trigger',
    '',
    `Source: \`${meta.trigger.source}\``,
    '',
    '```json',
    JSON.stringify(meta.trigger.criteria, null, 2),
    '```',
    '',
    '## Provenance',
    '',
    `- Taught via ingest #${meta.created_from_ingest} at ${meta.created_at}`,
    `- Example data: \`${truncate(JSON.stringify(ingest.data || {}), 200)}\``,
  ].join('\n');
}

function truncate(s, n) { return String(s).length > n ? String(s).slice(0, n) + '…' : String(s); }

// LLMs (especially Claude) sometimes draft regexes with Perl-style inline
// flags like `(?i)...` which JavaScript's RegExp doesn't accept. Strip them
// since we always pass the 'i' flag on the constructor anyway. Also strip
// other common unsupported flag groups to keep the matcher forgiving.
function sanitizeRegex(pat) {
  return String(pat || '')
    .replace(/^\(\?[imsxuy-]+\)/, '')        // leading inline flag group
    .replace(/\(\?[imsxuy-]+:/g, '(?:')      // scoped inline flags -> non-capturing
    .replace(/\(\?P<([^>]+)>/g, '(?<$1>');   // Python-style named groups -> JS style
}

function fallbackFlowYaml(name, draft) {
  // If the drafter didn't return a flow_yaml, emit a safe no-op flow that
  // just echoes the event back through an ask_user pause. Better than
  // creating a handler that does nothing silently.
  return [
    `name: ${name}`,
    `description: ${draft.description || 'Drafted handler'}`,
    'steps:',
    '  - id: inspect',
    '    action: set.event_source',
    '    value: "{event.source}"',
    '  - id: ask',
    '    action: ask_user.prompt',
    `    question: "I received an event I don't know how to handle. Review and tell me what to do."`,
    '',
  ].join('\n');
}
