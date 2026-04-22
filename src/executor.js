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
import { CronExpressionParser } from 'cron-parser';
import path from 'path';
import os from 'os';

const MAX_CONCURRENT = 4; // Leave 1 slot for your interactive session
let running = 0;

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
  if (task.executor === 'shell') {
    return executeShellTask(task, policyResult);
  }

  running++;
  await updateStatus(task.id, 'running');

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

  const { command, args, profile } = wrapWithSandbox('claude', claudeArgs, profileName, {
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

        // Notify all channels: include result preview (first 800 chars)
        const preview = result ? `\n\n${result.slice(0, 800)}${result.length > 800 ? '\n[...truncated]' : ''}` : '';
        await notifyTaskLifecycle(task, 'done', `Done: ${task.summary}${preview}`);
      } else {
        const error = stderr.trim().slice(0, 10000) || `Exit code ${code}`;

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
