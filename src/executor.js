import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  updateStatus,
  advanceRecurring,
  checkMaxRuns,
  insertTaskRun,
  finishTaskRun,
  setFiring,
} from './db.js';
import { notifyTaskLifecycle } from './channel-notify.js';
import { notify } from './notify.js';
import { wrapWithSandbox, profileForPermissionMode } from './sandbox.js';
import { evaluatePolicy } from './policy.js';
import { prefetch, sync as memorySync } from './memory.js';
import { enhancePrompt, compressOutput, isRtkAvailable } from './rtk.js';
import { checkClaudeAuth, LOGIN_EXPIRED_RESULT } from './auth.js';
import { getClaudeBin } from './claude-bin.js';
import { CronExpressionParser } from 'cron-parser';
import path from 'path';
import os from 'os';

const MAX_CONCURRENT = 4; // Leave 1 slot for your interactive session
let running = 0;

// Throttle for the "run /login" sticky nag — at most one per hour.
const LOGIN_NAG_INTERVAL_MS = 60 * 60 * 1000;
let lastLoginNagAt = 0;

function nagLoginExpired(reason) {
  const now = Date.now();
  if (now - lastLoginNagAt < LOGIN_NAG_INTERVAL_MS) return;
  lastLoginNagAt = now;
  console.warn(`[seal:auth] Claude CLI login appears expired (${reason}). Notifying user.`);
  try {
    notify(
      {
        priority: 'high',
        summary: 'Claude CLI login expired — run /login in any terminal to resume SEAL tasks',
      },
      'sticky'
    );
  } catch (err) {
    console.warn('[seal:auth] notify failed:', err.message);
  }
}

/**
 * Execute a task by spawning claude -p with the task's meta-prompt.
 * Returns a promise that resolves when claude finishes.
 */
export async function executeTask(task) {
  // ─── Policy gate ────────────────────────────────────
  // This runs BEFORE we mark the task as running so the concurrency
  // slot isn't consumed by an ack-blocked task.
  let policyResult;
  try {
    policyResult = evaluatePolicy(task);
  } catch (err) {
    console.error(`[executor] Policy evaluation failed for ${task.id}:`, err.message);
    policyResult = { decision: 'allow', reason: 'policy-error, defaulting allow', capabilities: [] };
  }

  if (policyResult.decision === 'deny') {
    await updateStatus(task.id, 'failed', `Denied by policy: ${policyResult.reason}`);
    console.warn(`[executor] Task ${task.id} DENIED: ${policyResult.reason}`);
    await notifyTaskLifecycle(task, 'failed', `Denied by policy: ${task.summary}\n${policyResult.reason}`);
    return;
  }

  if (policyResult.decision === 'ack') {
    await setFiring(task.id);
    const capsList = (policyResult.capabilities || []).join(', ') || '(none declared)';
    const msg = `⚠️ SEAL wants to run: ${task.summary}\nCapabilities: ${capsList}\nApprove with /seal:approve ${task.id} or deny with /seal:deny ${task.id}`;
    console.warn(`[executor] Task ${task.id} needs ACK: ${policyResult.reason}`);
    try {
      notify({ ...task, summary: `ACK needed: ${task.summary}` }, 'supernova');
    } catch {}
    await notifyTaskLifecycle(task, 'start', msg);
    return;
  }

  // ─── Shell executor: run command directly, no Claude ────
  // Tasks with executor='shell' bypass Claude entirely. Used for cheap,
  // deterministic chores (cron-style shell commands) where spawning a
  // full Claude session would be wasteful.
  if (task.executor === 'shell') {
    return executeShellTask(task, policyResult);
  }

  // ─── Worktree existence check ───────────────────────
  // If the task targets a worktree directory that no longer exists,
  // fail early with a clear message so the sensor can auto-recover it.
  if (task.project) {
    const expanded = expandPath(task.project);
    if (expanded.includes('.seal-worktrees') && !existsSync(expanded)) {
      const msg = `Worktree missing: ${expanded} — will be auto-recovered by sensor on next tick`;
      console.warn(`[executor] ${msg} (task ${task.id})`);
      await updateStatus(task.id, 'failed', msg);
      await notifyTaskLifecycle(task, 'failed', `Failed: ${task.summary}\n\n${msg}`);
      return;
    }
  }

  // ─── Claude CLI login pre-flight ────────────────────
  // If the local claude session is expired, every spawn fails with
  // exit -2/143 and an empty stderr. Detect once (cached 5 min) and
  // park the task as 'failed' with a sentinel result so the recovery
  // loop knows not to retry until /login is run.
  try {
    const auth = await checkClaudeAuth();
    if (!auth.ok) {
      console.warn(`[seal:auth] Skipping task ${task.id} — ${auth.reason}`);
      await updateStatus(task.id, 'failed', LOGIN_EXPIRED_RESULT);
      nagLoginExpired(auth.reason);
      await notifyTaskLifecycle(task, 'failed', `Blocked: ${task.summary}\n\n${LOGIN_EXPIRED_RESULT}`);
      return;
    }
  } catch (err) {
    // Don't fail tasks just because the probe itself crashed — let the
    // normal flow run and surface the real error if any.
    console.warn(`[seal:auth] Pre-flight check errored (continuing): ${err.message}`);
  }

  running++;
  // Note: task.status was already set to 'running' atomically by
  // claimPendingTasks() in the runner. We don't re-update here.

  // Phone channels (Telegram, Discord, WhatsApp) save prompt=null.
  // Fallback: use summary + detail so claude -p has something to work with.
  let prompt = task.prompt || [task.summary, task.detail].filter(Boolean).join('\n');

  // Skill invocations must NOT have anything prepended — prepended text
  // confuses Claude's skill recognition. Skip memory and RTK for these.
  const trimmed = prompt.trimStart();
  const isSkillInvocation = trimmed.startsWith('/') || trimmed.startsWith('Use the Skill tool');

  if (!isSkillInvocation) {
    // ─── Memory prefetch (MemPalace) ────────────────────
    try {
      const memoryBlock = await prefetch(task);
      if (memoryBlock) {
        prompt = `${memoryBlock}\n\n${prompt}`;
        console.log(`[executor] Injected memory context for task ${task.id}`);
      }
    } catch (err) {
      console.warn(`[executor] Memory prefetch failed (continuing without):`, err.message);
    }

    // ─── RTK prompt enhancement ─────────────────────────
    prompt = enhancePrompt(prompt);
  }

  const claudeArgs = [
    '-p', prompt,
    '--permission-mode', task.permission_mode || 'auto',
    '--output-format', 'text',
  ];

  // task.project resolves to the subprocess cwd (where .mcp.json lives,
  // where git commands run, where relative paths in the prompt resolve).
  // NOTE: claude CLI has no `--project` flag — passing it returns
  // `unknown option '--project'` and fails the spawn.
  const cwd = task.project ? expandPath(task.project) : undefined;

  // Auto-load project .mcp.json in headless mode.
  // Uses --strict-mcp-config (same as openclaw/src/agents/cli-runner/bundle-mcp.ts)
  // so claude loads ONLY from the explicit file, ignoring user-scope/plugin MCPs
  // that fail silently in the daemon context and end up blocking even the
  // explicit project config.
  if (cwd) {
    const projectMcp = join(cwd, '.mcp.json');
    if (existsSync(projectMcp)) {
      claudeArgs.push('--strict-mcp-config', '--mcp-config', projectMcp);
    }
  }

  if (task.allowed_tools) {
    try {
      const tools = JSON.parse(task.allowed_tools);
      if (tools.length > 0) {
        claudeArgs.push('--allowedTools', tools.join(','));
      }
    } catch {}
  }

  // ─── Sandbox wrap ───────────────────────────────────
  const profileName = profileForPermissionMode(task.permission_mode);

  // SEAL_PROJECT_ROOT is read by sandbox profiles that write under the project
  const projectRoot = task.project
    ? expandPath(task.project)
    : path.join(os.homedir(), 'projects');

  const { command, args, profile } = wrapWithSandbox(getClaudeBin(), claudeArgs, profileName, {
    SEAL_PROJECT_ROOT: projectRoot,
    HOME: process.env.HOME || os.homedir(),
  });

  console.log(`[executor] Running task ${task.id}: ${task.summary}`);
  console.log(`[executor] profile=${profileName} (${profile || 'no-sandbox'})`);
  console.log(`[executor] ${command} ${args.join(' ')}`);

  // Audit log entry
  let runId = null;
  try {
    runId = await insertTaskRun({
      task_id: task.id,
      started_at: new Date().toISOString(),
      profile: profileName,
      capabilities: task.capabilities || '[]',
    });
  } catch (err) {
    console.error(`[executor] insertTaskRun failed:`, err.message);
  }

  // Notify the user that we're starting (on the same channel they used + system)
  await notifyTaskLifecycle(task, 'start');

  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SEAL_PROJECT_ROOT: projectRoot,
        HOME: process.env.HOME || os.homedir(),
      },
      cwd,
      timeout: 1800000, // 30 min max per task
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', async (code) => {
      running--;

      // Finish audit record
      try {
        await finishTaskRun(runId, {
          exit_code: code,
          finished_at: new Date().toISOString(),
          stdout_preview: stdout,
          stderr_preview: stderr,
        });
      } catch (err) {
        console.error(`[executor] finishTaskRun failed:`, err.message);
      }

      if (code === 0) {
        const result = stdout.trim().slice(0, 50000);

        // ─── Memory sync (MemPalace) — store outcome ────
        try {
          const compressed = compressOutput(result, 2000);
          await memorySync(task, compressed, 'done');
        } catch (err) {
          console.warn(`[executor] Memory sync failed (non-blocking):`, err.message);
        }

        await updateStatus(task.id, 'done', result);
        console.log(`[executor] Task ${task.id} completed successfully`);

        if (task.recurrence) {
          try {
            if (await checkMaxRuns(task.id)) {
              console.log(`[executor] Task ${task.id} reached max runs, marking done`);
            } else {
              // Parse cron in the system's local timezone so expressions like
              // "*/30 8-19 * * *" mean 8am-7:30pm LOCAL time, not UTC.
              const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
              const interval = CronExpressionParser.parse(task.recurrence, { tz });
              const nextRun = interval.next().toDate().toISOString();
              await advanceRecurring(task.id, nextRun);
              console.log(`[executor] Task ${task.id} next run: ${nextRun}`);
            }
          } catch (err) {
            console.error(`[executor] Failed to parse cron for task ${task.id}:`, err.message);
          }
        }

        // Notify all channels: build a rich message for PR reviews,
        // generic preview for everything else.
        const message = buildDoneMessage(task, result);
        await notifyTaskLifecycle(task, 'done', message);
      } else {
        const isSigterm = code === 143;
        // Detect Anthropic API auth failures in stdout/stderr — pre-flight probe
        // sometimes passes (cached/stale token) but the real API call returns 401.
        const combinedOutput = `${stdout}\n${stderr}`;
        const isApiAuthError = /Invalid authentication credentials|API Error: 401|authentication_error/i.test(combinedOutput);

        let error;
        if (isApiAuthError) {
          error = LOGIN_EXPIRED_RESULT;
          // Invalidate cache so next probe re-checks
          try {
            const auth = await import('./auth.js');
            auth.invalidateAuthCache && auth.invalidateAuthCache();
          } catch {}
          nagLoginExpired('API 401 in task output');
        } else if (isSigterm) {
          error = `Process killed (SIGTERM) — will retry on next boot`;
        } else {
          error = stderr.trim().slice(0, 10000) || `Exit code ${code}`;
        }

        // ─── Memory sync (MemPalace) — store failure ────
        try {
          await memorySync(task, error, 'failed');
        } catch (err2) {
          console.warn(`[executor] Memory sync (failure) failed:`, err2.message);
        }

        await updateStatus(task.id, 'failed', error);
        console.error(`[executor] Task ${task.id} failed:`, error.slice(0, 200));

        // Re-queue recurring tasks even on failure so they keep their cadence
        if (task.recurrence) {
          try {
            if (!(await checkMaxRuns(task.id))) {
              // Same local-timezone handling as the success path above.
              const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
              const interval = CronExpressionParser.parse(task.recurrence, { tz });
              const nextRun = interval.next().toDate().toISOString();
              await advanceRecurring(task.id, nextRun);
              console.log(`[executor] Task ${task.id} re-queued after failure, next run: ${nextRun}`);
            }
          } catch (err) {
            console.error(`[executor] Failed to re-queue cron for task ${task.id}:`, err.message);
          }
        }

        await notifyTaskLifecycle(task, 'failed', `Failed: ${task.summary}\n\n${error.slice(0, 800)}`);
      }

      resolve();
    });

    proc.on('error', async (err) => {
      running--;
      try {
        await finishTaskRun(runId, {
          exit_code: -1,
          finished_at: new Date().toISOString(),
          stdout_preview: stdout,
          stderr_preview: `${stderr}\n${err.message}`,
        });
      } catch {}
      await updateStatus(task.id, 'failed', err.message);
      console.error(`[executor] Task ${task.id} spawn error:`, err.message);
      await notifyTaskLifecycle(task, 'failed', `Failed: ${task.summary}\n\nSpawn error: ${err.message}`);
      resolve();
    });
  });
}

/**
 * Execute a task directly as a shell command, bypassing Claude.
 * The task.prompt is treated as the shell command to run.
 */
async function executeShellTask(task) {
  running++;
  await updateStatus(task.id, 'running');

  const command = task.prompt;
  const cwd = task.project ? expandPath(task.project) : undefined;

  console.log(`[executor] Shell task ${task.id}: ${task.summary}`);
  console.log(`[executor] command: ${command}`);

  let runId = null;
  try {
    runId = await insertTaskRun({
      task_id: task.id,
      started_at: new Date().toISOString(),
      profile: 'shell',
      capabilities: '[]',
    });
  } catch (err) {
    console.error(`[executor] insertTaskRun failed:`, err.message);
  }

  await notifyTaskLifecycle(task, 'start');

  return new Promise((resolve) => {
    const proc = spawn('/bin/bash', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: process.env.HOME || os.homedir() },
      cwd,
      timeout: 300000, // 5 min max for shell tasks
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', async (code) => {
      running--;

      try {
        await finishTaskRun(runId, {
          exit_code: code,
          finished_at: new Date().toISOString(),
          stdout_preview: stdout,
          stderr_preview: stderr,
        });
      } catch (err) {
        console.error(`[executor] finishTaskRun failed:`, err.message);
      }

      if (code === 0) {
        const result = stdout.trim().slice(0, 50000);
        await updateStatus(task.id, 'done', result);
        console.log(`[executor] Shell task ${task.id} completed successfully`);

        if (task.recurrence) {
          try {
            if (await checkMaxRuns(task.id)) {
              console.log(`[executor] Task ${task.id} reached max runs, marking done`);
            } else {
              const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
              const interval = CronExpressionParser.parse(task.recurrence, { tz });
              const nextRun = interval.next().toDate().toISOString();
              await advanceRecurring(task.id, nextRun);
              console.log(`[executor] Task ${task.id} next run: ${nextRun}`);
            }
          } catch (err) {
            console.error(`[executor] Failed to parse cron for task ${task.id}:`, err.message);
          }
        }

        // Shell tasks don't need the rich PR-review formatter.
        const preview = result ? `\n\n${result.slice(0, 800)}${result.length > 800 ? '\n[...truncated]' : ''}` : '';
        await notifyTaskLifecycle(task, 'done', `Done: ${task.summary}${preview}`);
      } else {
        const error = stderr.trim().slice(0, 10000) || stdout.trim().slice(0, 10000) || `Exit code ${code}`;
        await updateStatus(task.id, 'failed', error);
        console.error(`[executor] Shell task ${task.id} failed:`, error.slice(0, 200));

        if (task.recurrence) {
          try {
            if (!(await checkMaxRuns(task.id))) {
              const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
              const interval = CronExpressionParser.parse(task.recurrence, { tz });
              const nextRun = interval.next().toDate().toISOString();
              await advanceRecurring(task.id, nextRun);
              console.log(`[executor] Task ${task.id} re-queued after failure, next run: ${nextRun}`);
            }
          } catch (err) {
            console.error(`[executor] Failed to re-queue cron for task ${task.id}:`, err.message);
          }
        }

        await notifyTaskLifecycle(task, 'failed', `Failed: ${task.summary}\n\n${error.slice(0, 800)}`);
      }

      resolve();
    });

    proc.on('error', async (err) => {
      running--;
      try {
        await finishTaskRun(runId, {
          exit_code: -1,
          finished_at: new Date().toISOString(),
          stdout_preview: stdout,
          stderr_preview: `${stderr}\n${err.message}`,
        });
      } catch {}
      await updateStatus(task.id, 'failed', err.message);
      console.error(`[executor] Shell task ${task.id} spawn error:`, err.message);
      await notifyTaskLifecycle(task, 'failed', `Failed: ${task.summary}\n\nSpawn error: ${err.message}`);
      resolve();
    });
  });
}

export function getRunningSlots() {
  return { running, max: MAX_CONCURRENT, available: MAX_CONCURRENT - running };
}

function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return p.replace('~', process.env.HOME);
  return p;
}

/**
 * Build a rich "done" notification message.
 *
 * For smart-review PR tasks: extracts PR number, title, and author. Falls
 * back to a generic summary + result preview for any other task type.
 */
function buildDoneMessage(task, result) {
  const summary = task.summary || '';
  const resultStr = result || '';

  // Match: "smart-review PR #34564: Title here"
  const prMatch = summary.match(/smart-review PR #(\d+):\s*(.*)/i);

  if (prMatch) {
    const prNumber = prMatch[1];
    const prTitle = (prMatch[2] || '').trim();

    // Author: comes from task.people (JSON array) when present
    let author = '?';
    try {
      const people = typeof task.people === 'string' ? JSON.parse(task.people) : (task.people || []);
      if (Array.isArray(people) && people[0]) author = String(people[0]);
    } catch {}

    // Verdict line: try to find the "Findings: X críticos · Y importantes · Z sugestões" line
    let verdict = '';
    const verdictMatch = resultStr.match(/(\*\*Findings\*\*[^\n]*|Findings[^\n]*críticos[^\n]*)/i);
    if (verdictMatch) {
      verdict = `\n${verdictMatch[1].replace(/\*\*/g, '').trim()}`;
    }

    // Resumo opcional: pega a primeira linha não-vazia do resultado depois do título
    let firstSummary = '';
    const lines = resultStr.split('\n').map((l) => l.trim()).filter(Boolean);
    const firstLine = lines.find((l) => !l.startsWith('#') && !l.startsWith('**Resumo')) || '';
    if (firstLine && firstLine.length < 200) firstSummary = `\n${firstLine}`;

    return [
      `✅ Review concluída — PR #${prNumber}`,
      `📝 ${prTitle}`,
      `👤 Autor: ${author}`,
      verdict,
      firstSummary,
    ]
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  // Generic: same behavior as before (truncated preview)
  const preview = resultStr ? `\n\n${resultStr.slice(0, 800)}${resultStr.length > 800 ? '\n[...truncated]' : ''}` : '';
  return `Done: ${summary}${preview}`;
}
