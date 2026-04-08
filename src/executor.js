import { spawn } from 'child_process';
import { updateStatus, advanceRecurring, checkMaxRuns } from './db.js';
import { notifyTaskLifecycle } from './channel-notify.js';
import { CronExpressionParser } from 'cron-parser';

const MAX_CONCURRENT = 4; // Leave 1 slot for your interactive session
let running = 0;

/**
 * Execute a task by spawning claude -p with the task's meta-prompt.
 * Returns a promise that resolves when claude finishes.
 */
export async function executeTask(task) {
  running++;
  await updateStatus(task.id, 'running');

  // Phone channels (Telegram, Discord, WhatsApp) save prompt=null.
  // Fallback: use summary + detail so claude -p has something to work with.
  const prompt = task.prompt || [task.summary, task.detail].filter(Boolean).join('\n');

  const args = [
    '-p', prompt,
    '--permission-mode', task.permission_mode || 'auto',
    '--output-format', 'text',
  ];

  if (task.project) {
    args.push('--project', expandPath(task.project));
  }

  if (task.allowed_tools) {
    try {
      const tools = JSON.parse(task.allowed_tools);
      if (tools.length > 0) {
        args.push('--allowedTools', tools.join(','));
      }
    } catch {}
  }

  console.log(`[executor] Running task ${task.id}: ${task.summary}`);
  console.log(`[executor] claude ${args.join(' ')}`);

  // Notify the user that we're starting (on the same channel they used + system)
  await notifyTaskLifecycle(task, 'start');

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      // stdin must be 'ignore' — claude -p blocks waiting for stdin otherwise,
      // causing the 'no stdin data received in 3s' warning and truncated runs.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: 1800000, // 30 min max per task
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', async (code) => {
      running--;

      if (code === 0) {
        const result = stdout.trim().slice(0, 50000);
        await updateStatus(task.id, 'done', result);
        console.log(`[executor] Task ${task.id} completed successfully`);

        if (task.recurrence) {
          try {
            if (await checkMaxRuns(task.id)) {
              console.log(`[executor] Task ${task.id} reached max runs, marking done`);
            } else {
              const interval = CronExpressionParser.parse(task.recurrence);
              const nextRun = interval.next().toISOString();
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
        await updateStatus(task.id, 'failed', error);
        console.error(`[executor] Task ${task.id} failed:`, error.slice(0, 200));

        // A recurring task that fails once should NOT be terminal — advance to
        // the next scheduled run so tomorrow has a chance. If it keeps failing,
        // max_runs (when set) will eventually cap it.
        if (task.recurrence) {
          try {
            if (await checkMaxRuns(task.id)) {
              console.log(`[executor] Task ${task.id} reached max runs after failure, leaving as failed`);
            } else {
              const interval = CronExpressionParser.parse(task.recurrence);
              const nextRun = interval.next().toISOString();
              await advanceRecurring(task.id, nextRun);
              console.log(`[executor] Task ${task.id} failed but re-queued for: ${nextRun}`);
            }
          } catch (err) {
            console.error(`[executor] Failed to re-queue recurring task ${task.id} after failure:`, err.message);
          }
        }

        await notifyTaskLifecycle(task, 'failed', `Failed: ${task.summary}\n\n${error.slice(0, 800)}`);
      }

      resolve();
    });

    proc.on('error', async (err) => {
      running--;
      await updateStatus(task.id, 'failed', err.message);
      console.error(`[executor] Task ${task.id} spawn error:`, err.message);
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
