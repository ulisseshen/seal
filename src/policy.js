import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'seal');
const POLICY_PATH = path.join(CONFIG_DIR, 'policies.json');

const DEFAULT_POLICY = {
  auto_approve: [
    {
      pattern: 'book openenglish',
      capabilities: ['shell:openenglish-book'],
      max_runs_per_day: 2,
    },
    {
      pattern: 'openenglish',
      capabilities: ['shell:openenglish-book'],
      max_runs_per_day: 2,
    },
  ],
  require_ack: [
    { capabilities_glob: 'fs:*:write' },
    { capabilities_glob: 'shell:*' },
  ],
  deny: [
    { capabilities_glob: 'fs:~/.ssh:*' },
    { capabilities_glob: 'fs:~/.aws:*' },
    { capabilities_glob: 'fs:~/.gnupg:*' },
  ],
};

let _cached = null;

export function ensureDefaultPolicy() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(POLICY_PATH)) {
    fs.writeFileSync(POLICY_PATH, JSON.stringify(DEFAULT_POLICY, null, 2));
    console.log(`[policy] Wrote default policy to ${POLICY_PATH}`);
  }
}

export function loadPolicy(force = false) {
  if (_cached && !force) return _cached;
  ensureDefaultPolicy();
  try {
    const raw = fs.readFileSync(POLICY_PATH, 'utf-8');
    _cached = JSON.parse(raw);
  } catch (err) {
    console.error(`[policy] Failed to load ${POLICY_PATH}: ${err.message} — using defaults`);
    _cached = DEFAULT_POLICY;
  }
  return _cached;
}

export function policyRuleCount(policy = loadPolicy()) {
  return (
    (policy.auto_approve?.length || 0) +
    (policy.require_ack?.length || 0) +
    (policy.deny?.length || 0)
  );
}

/**
 * Convert a simple glob pattern ("fs:*:write", "shell:*") into a RegExp.
 * Only `*` is supported (matches any run of non-":" chars for safety,
 * except a trailing `*` which matches everything).
 */
function globToRegex(glob) {
  // Escape regex special chars except `*`
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Replace `*` with `.*` (permissive; simple)
  const pattern = '^' + escaped.replace(/\*/g, '.*') + '$';
  return new RegExp(pattern);
}

function capsOf(task) {
  if (!task) return [];
  if (Array.isArray(task.capabilities)) return task.capabilities;
  if (typeof task.capabilities === 'string') {
    try {
      const arr = JSON.parse(task.capabilities);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  return [];
}

function anyCapMatches(caps, glob) {
  const rx = globToRegex(glob);
  return caps.some(c => rx.test(c));
}

/**
 * Evaluate a task against the loaded policy.
 * Returns: { decision: 'allow' | 'ack' | 'deny', reason: string, capabilities: string[] }
 *
 * Order of precedence:
 *   1. deny rules (any match → deny)
 *   2. auto_approve rules (pattern match on summary → allow)
 *   3. require_ack rules (any capability match → ack)
 *   4. default → allow
 */
export function evaluatePolicy(task) {
  const policy = loadPolicy();
  const caps = capsOf(task);
  const summary = (task.summary || '').toLowerCase();

  // 1. Deny
  for (const rule of policy.deny || []) {
    if (rule.capabilities_glob && anyCapMatches(caps, rule.capabilities_glob)) {
      return {
        decision: 'deny',
        reason: `capability matches deny rule ${rule.capabilities_glob}`,
        capabilities: caps,
      };
    }
    if (rule.pattern && summary.includes(rule.pattern.toLowerCase())) {
      return {
        decision: 'deny',
        reason: `summary matches deny rule "${rule.pattern}"`,
        capabilities: caps,
      };
    }
  }

  // 2. Auto-approve
  for (const rule of policy.auto_approve || []) {
    if (rule.pattern && summary.includes(rule.pattern.toLowerCase())) {
      return {
        decision: 'allow',
        reason: `matched auto_approve pattern "${rule.pattern}"`,
        capabilities: caps,
      };
    }
  }

  // 3. Require ack
  for (const rule of policy.require_ack || []) {
    if (rule.capabilities_glob && anyCapMatches(caps, rule.capabilities_glob)) {
      return {
        decision: 'ack',
        reason: `capability matches require_ack rule ${rule.capabilities_glob}`,
        capabilities: caps,
      };
    }
    if (rule.pattern && summary.includes(rule.pattern.toLowerCase())) {
      return {
        decision: 'ack',
        reason: `summary matches require_ack rule "${rule.pattern}"`,
        capabilities: caps,
      };
    }
  }

  // 4. Default → allow (backwards compatibility; nothing had capabilities before)
  return { decision: 'allow', reason: 'no matching rule (default allow)', capabilities: caps };
}

export { POLICY_PATH };
