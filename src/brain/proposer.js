/**
 * SEAL Brain — proposal engine (v0.5.0 "SEAL proposes")
 *
 * Reads observing patterns past the promotion threshold, drafts a plan
 * via the LLM provider abstraction, writes a proposal row, and flips
 * the pattern state to 'proposed'. The dashboard (or Telegram, future)
 * delivers the proposal to the TL for approval.
 *
 * Design — AGENT-SYSTEM-DESIGN.md §3.3:
 *   - Draft via an LLM using the prompt spec in §3.3.1
 *   - 5 decision shapes: approved_saved, approved_once, modified,
 *     denied, suppressed (see §3.4.1)
 *   - 7-day TTL on delivered proposals (§3.4.2)
 *   - Max 3 proposals per day — proposal fatigue rate limit (§7 v0.5.0)
 *   - Boring-pattern filter: trivial self-sequences are ignored here,
 *     the detector itself stays dumb
 *
 * Provider selection: whatever is saved in chat-config.json as the
 * default. Proposals are short LLM calls — any provider works.
 */

import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  listPatterns,
  setPatternState,
  insertProposal,
  getProposal,
  setProposalDecision,
  insertDecision,
  expireOldProposals,
  countProposalsCreatedSince,
  getPattern,
} from '../db.js';
import { getProvider } from '../providers/index.js';

const CONFIDENCE_THRESHOLD = 0.75;       // §3.2.3
const EVIDENCE_THRESHOLD = 3;            // §3.2.3
const PROPOSALS_PER_DAY_MAX = 3;         // §7 v0.5.0 "max 3/day, configurable"
const SLOW_PATH_INTERVAL_MS = 15 * 60 * 1000;
const TTL_DAYS = 7;

const SEAL_DIR = process.env.SEAL_DIR || join(process.env.HOME, '.config', 'seal');
const CHAT_CONFIG = join(SEAL_DIR, 'chat-config.json');

// ─── Public API ──────────────────────────────────────

export async function runProposer() {
  const expired = await expireOldProposals().catch(() => 0);
  if (expired) console.log(`[brain] expired ${expired} stale proposals`);

  // Fatigue gate: count proposals delivered in the last 24h.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const already = await countProposalsCreatedSince(since);
  if (already >= PROPOSALS_PER_DAY_MAX) {
    console.log(`[brain] proposal fatigue gate: ${already}/${PROPOSALS_PER_DAY_MAX} today, skipping`);
    return { drafted: 0, skipped: 'fatigue' };
  }

  const candidates = await listPatterns({ state: 'observing', limit: 20 });
  const ready = candidates
    .filter((p) => p.confidence >= CONFIDENCE_THRESHOLD && p.evidence_count >= EVIDENCE_THRESHOLD)
    .filter((p) => !isBoringPattern(p))
    .sort((a, b) => b.confidence - a.confidence);

  if (ready.length === 0) return { drafted: 0 };

  const budget = PROPOSALS_PER_DAY_MAX - already;
  const pick = ready.slice(0, budget);

  let drafted = 0;
  const errors = [];
  for (const pattern of pick) {
    try {
      const proposal = await draftProposal(pattern);
      if (!proposal) continue;
      await insertProposal(proposal);
      await setPatternState(pattern.id, 'proposed');
      drafted++;
      console.log(`[brain] drafted proposal ${proposal.id} for pattern ${pattern.id}`);
    } catch (err) {
      errors.push({ pattern: pattern.id, error: err.message });
      console.warn(`[brain] proposal drafting failed for ${pattern.id}:`, err.message);
    }
  }

  return { drafted, errors };
}

export function startProposerLoop() {
  const timer = setInterval(() => {
    runProposer().catch((err) => console.warn('[brain] proposer tick failed:', err.message));
  }, SLOW_PATH_INTERVAL_MS);
  if (timer.unref) timer.unref();

  // First tick 30s after boot, giving the detector its 10s head start.
  const kickoff = setTimeout(() => {
    runProposer().catch((err) => console.warn('[brain] initial proposer run failed:', err.message));
  }, 30_000);
  if (kickoff.unref) kickoff.unref();

  console.log('[brain] proposer loop started (every 15m, max 3/day)');
  return () => { clearInterval(timer); clearTimeout(kickoff); };
}

/**
 * Apply a user decision to a proposal. Writes the decisions audit row,
 * flips the pattern state accordingly, and (for approved_saved /
 * modified) returns the skill candidate so v0.6.0's skill factory can
 * persist it.
 */
export async function applyDecision(proposalId, decision, { finalScript = null, userNotes = null } = {}) {
  const valid = ['approved_once', 'approved_saved', 'modified', 'denied', 'suppressed'];
  if (!valid.includes(decision)) {
    throw new Error(`invalid decision "${decision}" (expected one of ${valid.join(', ')})`);
  }
  const proposal = await getProposal(proposalId);
  if (!proposal) throw new Error(`proposal ${proposalId} not found`);
  if (proposal.decided_at) throw new Error(`proposal ${proposalId} already decided (${proposal.decision})`);

  const originalScript = proposal.script;
  const effectiveScript = decision === 'modified' ? (finalScript ?? originalScript) : originalScript;

  await setProposalDecision(proposalId, decision, decision === 'modified' ? effectiveScript : null);
  await insertDecision({
    pattern_id: proposal.pattern_id,
    proposal_id: proposalId,
    decision,
    original_script: originalScript,
    final_script: decision === 'modified' ? effectiveScript : null,
    user_notes: userNotes,
  });

  // State machine (§3.4.1)
  let newPatternState;
  switch (decision) {
    case 'approved_saved':
    case 'modified':
      newPatternState = 'approved'; break;
    case 'approved_once':
      newPatternState = 'observing'; break; // may re-surface later
    case 'denied':
      newPatternState = 'observing'; break; // may re-propose with different draft
    case 'suppressed':
      newPatternState = 'retired'; break;   // never again for this signature
  }
  await setPatternState(proposal.pattern_id, newPatternState);

  return {
    proposal_id: proposalId,
    decision,
    pattern_state: newPatternState,
    script: effectiveScript,
    saves_skill: decision === 'approved_saved' || decision === 'modified',
  };
}

// ─── Drafting ────────────────────────────────────────

async function draftProposal(pattern) {
  const cfg = readChatConfig();
  const providerName = cfg.provider || 'claude';
  const model = cfg.model || undefined;

  const provider = getProvider(providerName, { model });
  if (!provider.available()) {
    throw new Error(`provider ${providerName} not available for drafting`);
  }

  const systemPrompt = DRAFT_SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(pattern);

  let raw = '';
  for await (const chunk of provider.stream(
    [{ role: 'user', content: userPrompt }],
    systemPrompt,
  )) {
    raw += chunk;
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    throw new Error(`drafter returned unparseable output: ${raw.slice(0, 200)}`);
  }
  if (!parsed.name || !parsed.script || !parsed.explanation) {
    throw new Error(`drafter output missing required fields`);
  }

  const signature = `proposal:${pattern.id}:${parsed.name}`;
  const id = 'p_' + crypto.createHash('sha1').update(signature + Date.now()).digest('hex').slice(0, 12);

  return {
    id,
    pattern_id: pattern.id,
    name: String(parsed.name).slice(0, 64),
    script: String(parsed.script),
    explanation: String(parsed.explanation),
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
    parameters: Array.isArray(parsed.parameters) ? parsed.parameters : [],
    invocation: parsed.invocation ? String(parsed.invocation) : null,
    provider: providerName,
    model: model ?? null,
    delivered_via: 'dashboard',
    ttl_ms: TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

function buildUserPrompt(pattern) {
  const meta = pattern.metadata || {};
  const examplesLines = [];
  if (pattern.kind === 'sequence') {
    examplesLines.push(`Trigger: ${meta.a}`);
    examplesLines.push(`Follows: ${meta.b}`);
    examplesLines.push(`Window: ${Math.round((meta.window_ms || 0) / 60000)} minutes`);
  } else if (pattern.kind === 'naming') {
    examplesLines.push(`Field: ${meta.field}`);
    examplesLines.push(`Convention: ${meta.label}`);
    examplesLines.push(`Regex: ${meta.regex}`);
    if (Array.isArray(meta.examples) && meta.examples.length) {
      examplesLines.push('Recent matches:');
      for (const ex of meta.examples.slice(0, 5)) examplesLines.push(`  - ${ex}`);
    }
  } else {
    examplesLines.push(JSON.stringify(meta));
  }

  return [
    'PATTERN DETECTED',
    `Kind: ${pattern.kind}`,
    `Evidence: ${pattern.evidence_count} occurrences`,
    `Confidence: ${(pattern.confidence * 100).toFixed(0)}%`,
    `Signature: ${pattern.signature}`,
    '',
    'Details:',
    examplesLines.join('\n'),
    '',
    'TASK',
    '1. Write a shell script (or node/python if clearly more appropriate) that automates this pattern.',
    '2. Parameterize where it makes sense.',
    '3. Write a one-paragraph plain-language explanation.',
    '4. Identify any risks (data loss, irreversible actions, network calls).',
    '5. Suggest a short invocation name (for /seal <name>).',
    '',
    'CONSTRAINTS',
    '- The Tech Lead will see your output and must approve it before it runs.',
    '- Prefer safety over cleverness. Echo commands before running them.',
    '- Do NOT include auto-commit, auto-push, or any destructive default unless the evidence clearly requires it.',
    '- If the pattern is boring or not worth automating, output {"skip": true, "reason": "..."} and nothing else.',
    '',
    'OUTPUT',
    'Respond with ONLY a single JSON object, no prose before or after, matching this exact shape:',
    '{',
    '  "name": "short-slug",',
    '  "script": "#!/bin/bash\\nset -euo pipefail\\n...",',
    '  "explanation": "one paragraph",',
    '  "risks": ["...", "..."],',
    '  "parameters": [{"name": "ticket_id", "example": "SEAL-456"}],',
    '  "invocation": "/seal short-slug SEAL-456"',
    '}',
  ].join('\n');
}

const DRAFT_SYSTEM_PROMPT = [
  'You are SEAL\'s Proposal Drafter.',
  'You draft safe, minimal shell (or node/python) scripts to automate patterns the SEAL Eye observed.',
  'Every output is plan-only — the Tech Lead must click approve before anything runs.',
  'Your job is to propose; his job is to decide.',
  'Prefer boring, echo-first scripts. Never include auto-commit, auto-push, or irreversible defaults unless the pattern evidence explicitly requires it.',
  'Respond with a single JSON object, nothing else.',
].join(' ');

// ─── Helpers ─────────────────────────────────────────

function isBoringPattern(pattern) {
  if (pattern.kind === 'sequence') {
    const meta = pattern.metadata || {};
    if (meta.a && meta.b && meta.a === meta.b) return true; // self-loop
    // "Commit follows commit" / "branch follows branch" — noise, skip.
    const trivial = new Set([
      'git:git.commit->git:git.commit',
      'git:git.branch.created->git:git.branch.created',
    ]);
    const key = `${meta.a}->${meta.b}`;
    if (trivial.has(key)) return true;
  }
  return false;
}

function readChatConfig() {
  if (!existsSync(CHAT_CONFIG)) return { provider: 'claude' };
  try { return JSON.parse(readFileSync(CHAT_CONFIG, 'utf-8')); }
  catch { return { provider: 'claude' }; }
}

function extractJson(raw) {
  if (!raw) return null;
  // Try direct parse.
  try { return JSON.parse(raw.trim()); } catch {}
  // Strip ``` fences if the model ignored "no code fence" and wrapped the JSON.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  // Last-ditch: find the first { ... } block.
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    try { return JSON.parse(raw.slice(braceStart, braceEnd + 1)); } catch {}
  }
  return null;
}

// Re-export for tests and the dashboard.
export { getPattern };
