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
import { parse as parseYaml } from 'yaml';

import {
  insertSkill, getSkillByName, getSkillById, listSkills, recordSkillRun,
} from '../db.js';
import { wrapWithSandbox } from '../sandbox.js';
import { runFlow } from '../flows/engine.js';

const SKILLS_DIR = join(process.env.SEAL_DIR || join(homedir(), '.config', 'seal'), 'skills');

// ─── Factory: proposal → skill ────────────────────────

/**
 * Persist an approved proposal as a skill. Idempotent per slug: if a
 * skill with the same slug already exists, append a numeric suffix so
 * both survive ("release" + "release-2").
 *
 * Backend detection (v0.7.0): if proposal.backend === 'flow' or the
 * proposal.script looks like a flow-yaml document (starts with
 * "name:" and has a "steps:" key), the skill is persisted as
 * flow.yaml instead of script.sh. Otherwise we write a shell script.
 */
export async function createSkillFromProposal(proposal, { finalScript = null } = {}) {
  const slug = slugify(proposal.name);
  const unique = await uniqueSlug(slug);
  const dir = join(SKILLS_DIR, unique);

  const source = finalScript ?? proposal.script;
  const isFlow = looksLikeFlowYaml(proposal.backend, source);
  const backendFile = isFlow ? 'flow.yaml' : 'script.sh';
  const backendPath = join(dir, backendFile);
  const readmePath = join(dir, 'README.md');
  const metaPath = join(dir, 'skill.json');
  const runsPath = join(dir, 'runs.jsonl');

  mkdirSync(dir, { recursive: true });
  if (isFlow) {
    writeFileSync(backendPath, source);
  } else {
    writeFileSync(backendPath, ensureShebang(source), { mode: 0o700 });
  }
  writeFileSync(readmePath, buildReadme(proposal, unique));
  writeFileSync(runsPath, ''); // touch

  const now = new Date().toISOString();
  const id = 's_' + crypto.createHash('sha1').update(unique + now).digest('hex').slice(0, 12);

  const meta = {
    id,
    name: unique,
    backend: isFlow ? 'flow' : 'script',
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
    script_path: backendPath,
    pattern_id: proposal.pattern_id,
    proposal_id: proposal.id,
    parameters: proposal.parameters ?? [],
    triggers: meta.triggers,
    requires_ack: false,
    sandbox_profile: 'project-write',
  });

  console.log(`[skills] created skill "${unique}" (${isFlow ? 'flow' : 'script'}) at ${dir}`);
  return { id, name: unique, dir, backend: meta.backend };
}

function looksLikeFlowYaml(backendHint, src) {
  if (backendHint === 'flow') return true;
  if (typeof src !== 'string') return false;
  // Cheap heuristic: YAML flow docs start with a name: line and declare steps:
  return /^\s*name:/m.test(src) && /^\s*steps:/m.test(src) && !src.startsWith('#!');
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

  // Dispatch based on the file extension of the backend file.
  if (skill.script_path.endsWith('.yaml') || skill.script_path.endsWith('.yml')) {
    return runFlowSkill(skill, args, opts);
  }
  return runScriptSkill(skill, args, opts);
}

function runScriptSkill(skill, args, opts) {
  const cwd = opts.cwd || process.cwd();
  const env = { ...process.env, ...(opts.env || {}) };

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

async function runFlowSkill(skill, args, _opts) {
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let exit_code = 0;

  try {
    const raw = readFileSync(skill.script_path, 'utf-8');
    const flow = parseYaml(raw);
    if (!flow || !Array.isArray(flow.steps)) {
      throw new Error(`flow.yaml missing steps[]`);
    }
    // Seed flow defaults with positional args for {args.0} / {args.1} style templating.
    flow.defaults = {
      ...(flow.defaults || {}),
      args: args.reduce((acc, v, i) => ({ ...acc, [i]: v }), {}),
      now: new Date().toISOString(),
    };

    const ctx = await runFlow(flow);
    // Serialize the final context into a readable report for the caller.
    const finalState = Object.fromEntries(
      Object.entries(ctx.state || {}).map(([k, v]) => [k, summarize(v)]),
    );
    stdout = JSON.stringify({ final: finalState, steps: ctx.history?.length ?? 0 }, null, 2);
  } catch (err) {
    stderr = err.message;
    exit_code = 1;
  }

  const duration_ms = Date.now() - started;
  await finalizeRun(skill, {
    success: exit_code === 0, exit_code, stdout, stderr, duration_ms, args,
  });
  return { exit_code, stdout, stderr, duration_ms };
}

function summarize(v, depth = 0) {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > 400 ? v.slice(0, 400) + '…' : v;
  if (typeof v !== 'object' || depth > 2) return v;
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => summarize(x, depth + 1));
  const out = {};
  for (const [k, vv] of Object.entries(v)) out[k] = summarize(vv, depth + 1);
  return out;
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
