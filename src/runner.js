import {
  getPendingTasks,
  getPendingReminders,
  getFiringSupernova,
  getRunningCount,
  setFiring,
  updateLastNotified,
} from './db.js';
import { executeTask, getRunningSlots } from './executor.js';
import { notify } from './notify.js';

const POLL_INTERVAL = 30_000;       // Check tasks every 30 seconds
const SUPERNOVA_INTERVAL = 60_000;  // Check supernova re-fires every 60 seconds

console.log(`
╔═══════════════════════════════════════╗
║   SEAL v0.1.0                         ║
║   Discipline. Execution. No excuses.  ║
╚═══════════════════════════════════════╝
`);
console.log(`[seal] Polling every ${POLL_INTERVAL / 1000}s`);
console.log(`[seal] Max concurrent: ${getRunningSlots().max}`);
console.log(`[seal] Standing by...`);

async function pollTasks() {
  try {
    const slots = getRunningSlots();
    if (slots.available <= 0) return;

    // 1. Execute pending tasks
    const tasks = getPendingTasks(slots.available);
    for (const task of tasks) {
      // Don't await — run in parallel up to MAX_CONCURRENT
      executeTask(task).catch((err) => {
        console.error(`[seal] Unhandled task error:`, err.message);
      });
    }

    // 2. Fire pending reminders
    const reminders = getPendingReminders();
    for (const reminder of reminders) {
      const level = reminder.notify_type || 'sound';
      notify(reminder, level);

      if (level === 'supernova') {
        setFiring(reminder.id);
      } else {
        // Non-supernova reminders: mark as done after firing
        const { updateStatus } = await import('./db.js');
        updateStatus(reminder.id, 'done');
      }
    }
  } catch (err) {
    console.error(`[seal] Poll error:`, err.message);
  }
}

async function pollSupernova() {
  try {
    const firing = getFiringSupernova();
    for (const task of firing) {
      console.log(`[supernova] Re-firing: ${task.summary}`);
      notify(task, 'supernova');
      updateLastNotified(task.id);
    }
  } catch (err) {
    console.error(`[seal] Supernova poll error:`, err.message);
  }
}

// Main loops
setInterval(pollTasks, POLL_INTERVAL);
setInterval(pollSupernova, SUPERNOVA_INTERVAL);

// Run immediately on start
pollTasks();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[seal] Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[seal] Shutting down...');
  process.exit(0);
});
