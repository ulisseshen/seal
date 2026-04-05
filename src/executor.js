import { spawn } from 'child_process';
import { updateStatus, advanceRecurring, checkMaxRuns } from './db.js';
import { notify } from './notify.js';
import cronParser from 'cron-parser';

const MAX_CONCURRENT = 4; // Leave 1 slot for your interactive session
let running = 0;

/**
 * Execute a task by spawning claude -p with the task's meta-prompt.
 * Returns a promise that resolves when claude finishes.
 */
export async function executeTask(task) {
  running++;
  await updateStatus(task.id, 'running');

  const args = [
    '-p', task.prompt,
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

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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
              const interval = cronParser.parseExpression(task.recurrence);
              const nextRun = interval.next().toISOString();
              await advanceRecurring(task.id, nextRun);
              console.log(`[executor] Task ${task.id} next run: ${nextRun}`);
            }
          } catch (err) {
            console.error(`[executor] Failed to parse cron for task ${task.id}:`, err.message);
          }
        }

        if (task.priority === 'high') {
          notify({ ...task, summary: `Done: ${task.summary}` }, 'sound');
        }
      } else {
        const error = stderr.trim().slice(0, 10000) || `Exit code ${code}`;
        await updateStatus(task.id, 'failed', error);
        console.error(`[executor] Task ${task.id} failed:`, error.slice(0, 200));
        notify({ ...task, summary: `Failed: ${task.summary}` }, 'sound');
      }

      resolve();
    });

    proc.on('error', async (err) => {
      running--;
      await updateStatus(task.id, 'failed', err.message);
      console.error(`[executor] Task ${task.id} spawn error:`, err.message);
      resolve();
    });
  });
}

export function getRunningSlots() {
  return { running, max: MAX_CONCURRENT, available: MAX_CONCURRENT - running };
}

function expandPath(p) {
  if (p.startsWith('~/')) return p.replace('~', process.env.HOME);
  return p;
}
