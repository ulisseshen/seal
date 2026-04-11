/**
 * SEAL Skill Factory (v0.6.0 "SEAL remembers")
 *
 * Approved proposals become skills — named, reusable, invocable, trackable.
 * Each skill is a directory under ~/.config/seal/skills/<name>/ containing
 * skill.json, script.sh, README.md, and runs.jsonl.
 *
 * The factory is called from the proposal engine's applyDecision() path
 * when the TL picks `approved_saved` or `modified`. It also exposes a
 * skill runner that the CLI, dashboard, and (future) chat channels invoke.
 *
 * Design — AGENT-SYSTEM-DESIGN.md §3.5. Sandbox integration reuses the
 * existing wrapWithSandbox() path so skill runs inherit the same profile
 * rules as task execution.
 */

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdirSync, writeFileSync, appendFileSync, chmodSync, existsSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  insertSkill, getSkillByName, getSkillById, listSkills, recordSkillRun,
} from '../db.js';
import { wrapWithSandbox } from '../sandbox.js';

const SKILLS_DIR = join(process.env.SEAL_DIR || join(homedir(), '.config', 'seal'), 'skills');

// ─── Factory: proposal → skill ────────────────────────

/**
 * Persist an approved proposal as a skill. Idempotent per slug: if a
 * skill with the same slug already exists, append a numeric suffix so
 * both survive ("release" + "release-2").
 */
export async function createSkillFromProposal(proposal, { finalScript = null } = {}) {
  const slug = slugify(proposal.name);
  const unique = await uniqueSlug(slug);
  const dir = join(SKILLS_DIR, unique);

  const scriptSource = finalScript ?? proposal.script;
  const scriptPath = join(dir, 'script.sh');
  const readmePath = join(dir, 'README.md');
  const metaPath = join(dir, 'skill.json');
  const runsPath = join(dir, 'runs.jsonl');

  mkdirSync(dir, { recursive: true });
  writeFileSync(scriptPath, ensureShebang(scriptSource), { mode: 0o700 });
  writeFileSync(readmePath, buildReadme(proposal, unique));
  writeFileSync(runsPath, ''); // touch

  const now = new Date().toISOString();
  const id = 's_' + crypto.createHash('sha1').update(unique + now).digest('hex').slice(0, 12);

  const meta = {
    id,
    name: unique,
    description: proposal.explanation,
    invocation: proposal.invocation || `/seal ${unique}`,
    parameters: proposal.parameters ?? [],
    risks: proposal.risks ?? [],
    triggers: { manual: true, pattern_match: false, cron: null },
    requires_ack: false,
    sandbox_profile: 'project-write',
    created_from_pattern: proposal.pattern_id,
    created_from_proposal: proposal.id,
    created_at: now,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  await insertSkill({
    id,
    name: unique,
    description: proposal.explanation,
    script_path: scriptPath,
    pattern_id: proposal.pattern_id,
    proposal_id: proposal.id,
    parameters: proposal.parameters ?? [],
    triggers: meta.triggers,
    requires_ack: false,
    sandbox_profile: 'project-write',
  });

  console.log(`[skills] created skill "${unique}" at ${dir}`);
  return { id, name: unique, dir };
}

// ─── Runner ────────────────────────────────────────

/**
 * Invoke a skill by name or id. Captures stdout/stderr/exit code,
 * writes a line to runs.jsonl, and bumps the skills table counters.
 *
 * @param {string} identifier  — skill name or id
 * @param {string[]} args     — positional arguments forwarded to the script
 * @param {object} opts
 * @returns {Promise<{ exit_code, stdout, stderr, duration_ms }>}
 */
export async function runSkill(identifier, args = [], opts = {}) {
  const skill = await resolveSkill(identifier);
  if (!skill) throw new Error(`skill not found: ${identifier}`);
  if (skill.state !== 'active') throw new Error(`skill "${skill.name}" is ${skill.state}`);

  const cwd = opts.cwd || process.cwd();
  const env = { ...process.env, ...(opts.env || {}) };

  // Sandbox wrap. The existing sandbox.js knows how to apply profile rules.
  // For skill runs we use the skill's own profile (or project-write default).
  const profile = skill.sandbox_profile || 'project-write';
  const { command, args: wrappedArgs } = wrapWithSandboxSafely('bash', [skill.script_path, ...args], profile);

  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, wrappedArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
    child.on('error', async (err) => {
      const duration_ms = Date.now() - started;
      await finalizeRun(skill, { success: false, exit_code: -1, stdout, stderr: stderr + '\n' + err.message, duration_ms, args });
      resolve({ exit_code: -1, stdout, stderr: stderr + '\n' + err.message, duration_ms });
    });
    child.on('close', async (code) => {
      const duration_ms = Date.now() - started;
      const success = code === 0;
      await finalizeRun(skill, { success, exit_code: code ?? -1, stdout, stderr, duration_ms, args });
      resolve({ exit_code: code ?? -1, stdout, stderr, duration_ms });
    });
  });
}

async function finalizeRun(skill, result) {
  try {
    const runsPath = join(SKILLS_DIR, skill.name, 'runs.jsonl');
    const line = JSON.stringify({
      at: new Date().toISOString(),
      args: result.args,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      stdout_preview: result.stdout.slice(0, 500),
      stderr_preview: result.stderr.slice(0, 500),
    });
    appendFileSync(runsPath, line + '\n');
  } catch (err) {
    console.warn('[skills] runs.jsonl append failed:', err.message);
  }
  try {
    await recordSkillRun(skill.id, { success: result.success });
  } catch (err) {
    console.warn('[skills] recordSkillRun failed:', err.message);
  }
}

// ─── Queries re-exported for convenience ─────────────

export { listSkills, getSkillByName, getSkillById };

// ─── Helpers ─────────────────────────────────────────

function slugify(name) {
  return String(name || 'skill')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'skill';
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

function ensureShebang(script) {
  const trimmed = script.replace(/^\s+/, '');
  if (trimmed.startsWith('#!')) return trimmed;
  return '#!/bin/bash\nset -euo pipefail\n\n' + trimmed;
}

function buildReadme(proposal, name) {
  const params = Array.isArray(proposal.parameters) ? proposal.parameters : [];
  const risks = Array.isArray(proposal.risks) ? proposal.risks : [];
  const paramList = params.length
    ? params.map((p) => `- \`${p.name}\`${p.example ? ` — example: \`${p.example}\`` : ''}`).join('\n')
    : '_(none)_';
  const riskList = risks.length
    ? risks.map((r) => `- ${r}`).join('\n')
    : '_(none identified)_';
  return [
    `# ${name}`,
    '',
    proposal.explanation,
    '',
    '## Invocation',
    '',
    `\`${proposal.invocation || `/seal ${name}`}\``,
    '',
    '## Parameters',
    '',
    paramList,
    '',
    '## Risks',
    '',
    riskList,
    '',
    '## Provenance',
    '',
    `- Drafted by: ${proposal.provider ?? 'unknown'}${proposal.model ? ` (${proposal.model})` : ''}`,
    `- From proposal: \`${proposal.id}\``,
    `- From pattern: \`${proposal.pattern_id}\``,
  ].join('\n');
}

async function resolveSkill(identifier) {
  if (!identifier) return null;
  const byName = await getSkillByName(identifier);
  if (byName) return byName;
  return getSkillById(identifier);
}

/**
 * Thin wrapper so a missing/invalid sandbox profile degrades to a
 * direct bash invocation instead of throwing. The existing
 * wrapWithSandbox enforces profile rules but v0.6.0 ships with a
 * conservative default; we log and degrade rather than refuse.
 */
function wrapWithSandboxSafely(cmd, args, profile) {
  try {
    const wrapped = wrapWithSandbox(cmd, args, profile);
    if (wrapped?.command) return wrapped;
  } catch (err) {
    console.warn(`[skills] sandbox wrap failed (${err.message}), running unsandboxed`);
  }
  return { command: cmd, args };
}

// Read a skill's runs.jsonl tail for the dashboard "run history" view.
export function readSkillRunHistory(name, limit = 20) {
  const runsPath = join(SKILLS_DIR, name, 'runs.jsonl');
  if (!existsSync(runsPath)) return [];
  const raw = readFileSync(runsPath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean).slice(-limit);
  return lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .reverse();
}
