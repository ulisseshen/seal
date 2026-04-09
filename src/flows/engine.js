/**
 * SEAL Flow Engine
 *
 * Interprets YAML flow definitions and executes steps sequentially or conditionally.
 * Inspired by OpenClaw's Lobster and Hermes' agent loop.
 *
 * Key concepts:
 * - Flows are YAML files in flows/ directory
 * - Each step has an id, action, and optional conditions
 * - Adapters abstract SCM backends (Azure, GitHub, GitLab)
 * - State persists across steps via context object
 * - Watch steps poll for changes and re-trigger sub-flows
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { AzureDevOpsAdapter } from '../adapters/azure-devops.js';
import { GitHubAdapter } from '../adapters/github.js';

// ─── Adapter Registry ─────────────────────────────────
const ADAPTERS = {
  'azure-devops': AzureDevOpsAdapter,
  'github': GitHubAdapter,
  // 'gitlab': GitLabAdapter,    // future
  // 'bitbucket': BitbucketAdapter, // future
};

// ─── Flow Loader ──────────────────────────────────────
export function loadFlows(flowsDir) {
  const flows = {};
  try {
    const files = readdirSync(flowsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      const content = readFileSync(join(flowsDir, file), 'utf-8');
      const flow = parseYaml(content);
      flows[flow.name] = flow;
      console.log(`[flow-engine] Loaded flow: ${flow.name} (${flow.steps.length} steps)`);
    }
  } catch (err) {
    console.warn(`[flow-engine] Could not load flows from ${flowsDir}:`, err.message);
  }
  return flows;
}

// ─── Flow Execution Context ───────────────────────────
class FlowContext {
  constructor(flow, adapterConfig = {}) {
    this.flow = flow;
    this.state = {};           // step outputs: { stepId: result }
    this.variables = {};       // resolved variables
    this.currentStep = null;
    this.history = [];         // execution trace
    this.startedAt = new Date();

    // Instantiate adapter
    const adapterName = flow.defaults?.adapter || 'azure-devops';
    const AdapterClass = ADAPTERS[adapterName];
    if (!AdapterClass) throw new Error(`Unknown adapter: ${adapterName}`);
    this.adapter = new AdapterClass(adapterConfig);

    console.log(`[flow-engine] Context created for "${flow.name}" with adapter "${adapterName}"`);
  }

  set(key, value) {
    this.state[key] = value;
  }

  get(key) {
    return this.state[key];
  }

  log(stepId, action, result) {
    this.history.push({
      stepId,
      action,
      result: typeof result === 'object' ? JSON.stringify(result).slice(0, 200) : result,
      timestamp: new Date().toISOString(),
    });
  }
}

// ─── Step Executor ────────────────────────────────────
async function executeStep(step, ctx) {
  console.log(`[flow-engine] Executing step: ${step.id} (${step.action})`);
  ctx.currentStep = step.id;

  const [namespace, method] = (step.action || '').split('.');

  let result;

  switch (namespace) {
    case 'adapter':
      result = await executeAdapterAction(method, step, ctx);
      break;

    case 'skill':
      result = await executeSkillAction(method, step, ctx);
      break;

    default:
      console.warn(`[flow-engine] Unknown action namespace: ${namespace}`);
      result = null;
  }

  // Store output
  if (step.output) {
    ctx.set(step.output, result);
  }
  ctx.log(step.id, step.action, result);

  return result;
}

async function executeAdapterAction(method, step, ctx) {
  const adapter = ctx.adapter;

  switch (method) {
    case 'list_open_prs':
      return adapter.listOpenPRs(step.filter || {});

    case 'vote':
      return adapter.vote(
        resolveVar(step.pr, ctx),
        step.value
      );

    case 'comment_threads':
      return adapter.commentThreads(
        resolveVar(step.pr, ctx),
        resolveVar(step.input, ctx) || []
      );

    case 'comment':
      return adapter.comment(
        resolveVar(step.pr, ctx),
        resolveTemplate(step.message, ctx)
      );

    case 'resolve_threads':
      return adapter.resolveThreads(resolveVar(step.pr, ctx));

    case 'watch_for_commits':
      return watchForCommits(step, ctx);

    case 'notify':
      return adapter.notify(
        resolveVar(step.pr, ctx),
        step.channel || ctx.flow.defaults?.notify_channel || 'pr-comment',
        resolveTemplate(step.template || step.message, ctx)
      );

    default:
      console.warn(`[flow-engine] Unknown adapter method: ${method}`);
      return null;
  }
}

async function executeSkillAction(skillName, step, ctx) {
  // Skills are executed by spawning a claude session with the skill invocation
  const { spawn } = await import('child_process');

  const input = resolveVar(step.input, ctx) || '';
  const contextData = step.context ? JSON.stringify(resolveVarDeep(step.context, ctx)) : '';

  const prompt = contextData
    ? `Run /smart-review on ${input}. Previous review context: ${contextData}`
    : `Run /smart-review on ${input}`;

  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p', prompt,
      '--output-format', 'text',
      '--permission-mode', 'auto',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Skill ${skillName} exited ${code}`));
      else resolve(stdout.trim());
    });
  });
}

// ─── Watch Loop ───────────────────────────────────────
async function watchForCommits(step, ctx) {
  const prId = resolveVar(step.pr, ctx);
  const interval = parseInterval(step.poll_interval || '5m');
  const timeout = parseInterval(step.timeout || '7d');
  const startTime = Date.now();

  let lastCommit = await ctx.adapter.getLatestCommit(prId);
  console.log(`[flow-engine] Watching PR ${prId} for new commits (every ${step.poll_interval}, timeout ${step.timeout})`);

  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      // Timeout check
      if (Date.now() - startTime > timeout) {
        clearInterval(timer);
        resolve({ event: 'timeout' });
        return;
      }

      try {
        const currentCommit = await ctx.adapter.getLatestCommit(prId);
        if (currentCommit !== lastCommit) {
          console.log(`[flow-engine] New commit detected on PR ${prId}: ${currentCommit}`);
          lastCommit = currentCommit;
          clearInterval(timer);
          resolve({ event: 'new_commit', commit: currentCommit });
        }
      } catch (err) {
        console.warn(`[flow-engine] Watch poll error:`, err.message);
      }
    }, interval);
  });
}

// ─── Condition Evaluator ──────────────────────────────
function evaluateConditions(step, ctx) {
  if (!step.condition) return null; // no conditions, proceed linearly

  for (const cond of step.condition) {
    if (cond.if) {
      // Simple expression evaluator (safe — only reads ctx.state)
      const expr = resolveTemplate(cond.if, ctx);
      try {
        // Replace variable references with actual values
        const result = evaluateExpression(expr, ctx);
        if (result) return cond.goto;
      } catch {
        continue;
      }
    }
    if (cond.else) {
      return cond.goto;
    }
  }
  return null;
}

function evaluateExpression(expr, ctx) {
  // Simple safe evaluator for conditions like "findings.blocker_count == 0"
  const resolved = expr.replace(/(\w+)\.(\w+)/g, (_, obj, prop) => {
    const val = ctx.state[obj]?.[prop];
    return val !== undefined ? JSON.stringify(val) : '0';
  });
  // Only allow comparisons, not arbitrary code
  if (/^[\d\s"'<>=!&|.]+$/.test(resolved)) {
    return new Function(`return ${resolved}`)();
  }
  return false;
}

// ─── Variable Resolution ──────────────────────────────
function resolveVar(template, ctx) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\$(\w+)(?:\.(\w+))?(?:\[(\w+)\])?/g, (_, key, prop, idx) => {
    let val = ctx.state[key] ?? ctx.flow.defaults?.[key] ?? '';
    if (prop && typeof val === 'object') val = val[prop];
    if (idx && Array.isArray(val)) val = val[idx === 'current' ? 0 : parseInt(idx)];
    return val;
  });
}

function resolveVarDeep(obj, ctx) {
  if (typeof obj === 'string') return resolveVar(obj, ctx);
  if (Array.isArray(obj)) return obj.map(v => resolveVarDeep(v, ctx));
  if (typeof obj === 'object' && obj !== null) {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveVarDeep(v, ctx);
    }
    return result;
  }
  return obj;
}

function resolveTemplate(template, ctx) {
  if (!template) return '';
  return template.replace(/\{([^}]+)\}/g, (_, expr) => {
    return resolveVar(`$${expr}`, ctx) || expr;
  });
}

// ─── Helpers ──────────────────────────────────────────
function parseInterval(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 5 * 60 * 1000; // default 5 min
  const [, num, unit] = match;
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(num) * multipliers[unit];
}

// ─── Main Flow Runner ─────────────────────────────────
export async function runFlow(flow, adapterConfig = {}) {
  const ctx = new FlowContext(flow, adapterConfig);
  const stepsMap = {};
  for (const step of flow.steps) {
    stepsMap[step.id] = step;
  }

  let currentStepId = flow.steps[0]?.id;

  while (currentStepId) {
    const step = stepsMap[currentStepId];
    if (!step) {
      console.error(`[flow-engine] Step not found: ${currentStepId}`);
      break;
    }

    // Check conditions first (for decision steps)
    const jump = evaluateConditions(step, ctx);
    if (jump) {
      currentStepId = jump;
      continue;
    }

    // Execute the step
    try {
      const result = await executeStep(step, ctx);

      // Handle "then" chains
      if (step.then) {
        const thens = Array.isArray(step.then) ? step.then : [step.then];
        for (const t of thens) {
          if (typeof t === 'string') {
            // Simple step reference
            currentStepId = t;
          } else if (t.id) {
            // Inline sub-step
            await executeStep(t, ctx);
          }
        }
        // After then chain, move to next in sequence unless jumped
        if (typeof step.then === 'string') {
          currentStepId = step.then;
          continue;
        }
      }

      // Handle watch results
      if (result?.event === 'new_commit' && step.on_new_commit) {
        currentStepId = step.on_new_commit;
        continue;
      }
      if (result?.event === 'timeout' && step.on_timeout) {
        currentStepId = step.on_timeout;
        continue;
      }

    } catch (err) {
      console.error(`[flow-engine] Step "${currentStepId}" failed:`, err.message);
      ctx.log(currentStepId, 'error', err.message);
    }

    // Move to next step in sequence
    const currentIndex = flow.steps.findIndex(s => s.id === currentStepId);
    const nextStep = flow.steps[currentIndex + 1];
    currentStepId = nextStep?.id || null;
  }

  console.log(`[flow-engine] Flow "${flow.name}" completed. ${ctx.history.length} steps executed.`);
  return ctx;
}
