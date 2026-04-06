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
import { loadConfig, saveDefaultConfig } from './config.js';
import { startIngestServer } from './ingest-server.js';
import { pollGmail } from './ingest-gmail.js';
import { startWhatsApp } from './whatsapp.js';
import { startTelegram } from './telegram.js';

const POLL_INTERVAL = 30_000;       // Check tasks every 30 seconds
const SUPERNOVA_INTERVAL = 60_000;  // Check supernova re-fires every 60 seconds

// Load ingestion config
saveDefaultConfig();
const config = loadConfig();

const emailEnabled = config.email.enabled;
const emailMode = config.email.mode || 'gmail';
const whatsappEnabled = config.whatsapp.enabled;
const telegramEnabled = config.telegram?.enabled;

function emailLabel() {
  if (!emailEnabled) return 'off';
  return emailMode === 'webhook' ? 'webhook' : 'gmail';
}

console.log(`
╔═══════════════════════════════════════╗
║   SEAL v0.2.0                         ║
║   Discipline. Execution. No excuses.  ║
╚═══════════════════════════════════════╝
`);
console.log(`[seal] Polling every ${POLL_INTERVAL / 1000}s`);
console.log(`[seal] Max concurrent: ${getRunningSlots().max}`);
console.log(`[seal] Ingestion: email=${emailLabel()} whatsapp=${whatsappEnabled ? 'baileys' : 'off'} telegram=${telegramEnabled ? 'bot' : 'off'}`);
console.log(`[seal] Standing by...`);

async function pollTasks() {
  try {
    const slots = getRunningSlots();
    if (slots.available <= 0) return;

    const tasks = await getPendingTasks(slots.available);
    for (const task of tasks) {
      executeTask(task).catch((err) => {
        console.error(`[seal] Unhandled task error:`, err.message);
      });
    }

    const reminders = await getPendingReminders();
    for (const reminder of reminders) {
      const level = reminder.notify_type || 'sound';
      notify(reminder, level);

      if (level === 'supernova') {
        await setFiring(reminder.id);
      } else {
        const { updateStatus } = await import('./db.js');
        await updateStatus(reminder.id, 'done');
      }
    }
  } catch (err) {
    console.error(`[seal] Poll error:`, err.message);
  }
}

async function pollSupernova() {
  try {
    const firing = await getFiringSupernova();
    for (const task of firing) {
      console.log(`[supernova] Re-firing: ${task.summary}`);
      notify(task, 'supernova');
      await updateLastNotified(task.id);
    }
  } catch (err) {
    console.error(`[seal] Supernova poll error:`, err.message);
  }
}

// ─── Email ingestion ────────────────────────────────────

if (emailEnabled && emailMode === 'webhook') {
  // Cloudflare Worker → POST /email
  startIngestServer(config);
} else if (emailEnabled && emailMode === 'gmail') {
  // Gmail IMAP polling
  const interval = config.email.pollInterval || 300_000;
  setInterval(() => pollGmail(config).catch(err => {
    console.error('[seal] Gmail poll error:', err.message);
  }), interval);
  // Poll immediately on start
  pollGmail(config).catch(err => {
    console.error('[seal] Gmail poll error:', err.message);
  });
}

// ─── WhatsApp ingestion ─────────────────────────────────

if (whatsappEnabled) {
  startWhatsApp(config).catch((err) => {
    console.error('[seal] WhatsApp failed to start:', err.message);
  });
}

// ─── Telegram ingestion ─────────────────────────────────

if (telegramEnabled) {
  startTelegram(config);
}

// ─── Main loops ─────────────────────────────────────────

setInterval(pollTasks, POLL_INTERVAL);
setInterval(pollSupernova, SUPERNOVA_INTERVAL);
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
