import {
  getPendingTasks,
  getPendingReminders,
  getFiringSupernova,
  getRunningCount,
  setFiring,
  updateLastNotified,
  db,
} from './db.js';
import { executeTask, getRunningSlots } from './executor.js';
import { notify } from './notify.js';
import { loadConfig, saveDefaultConfig } from './config.js';
import { startIngestServer } from './ingest-server.js';
import { pollGmail } from './ingest-gmail.js';
import { startWhatsApp } from './whatsapp.js';
import { startTelegram } from './telegram.js';
import { startDiscord } from './discord.js';
import { startWeb } from './web.js';
import { ensureDefaultProfiles } from './sandbox.js';
import { loadPolicy, policyRuleCount } from './policy.js';
import { runPrWatcher } from './sensors/pr-watcher.js';
import { runAzurePrReview } from './sensors/azure-pr-review.js';
import { ensurePalace } from './memory.js';
import { isRtkAvailable, getStats as getRtkStats } from './rtk.js';
import { loadFlows } from './flows/engine.js';
import { eventBus } from './event-bus.js';
import { GitObserver } from './observers/git.js';
import { setGitIngester } from './web.js';
import { startDetectorLoop } from './brain/detector.js';
import { startProposerLoop } from './brain/proposer.js';

const POLL_INTERVAL = 30_000;       // Check tasks every 30 seconds
const SUPERNOVA_INTERVAL = 60_000;  // Check supernova re-fires every 60 seconds

// Load ingestion config
saveDefaultConfig();
const config = loadConfig();

const emailEnabled = config.email.enabled;
const emailMode = config.email.mode || 'gmail';
const whatsappEnabled = config.whatsapp.enabled;
const telegramEnabled = config.telegram?.enabled;
const discordEnabled = config.discord?.enabled;

function emailLabel() {
  if (!emailEnabled) return 'off';
  return emailMode === 'webhook' ? 'webhook' : 'gmail';
}

console.log(`
╔═══════════════════════════════════════╗
║   SEAL v0.3.0                         ║
║   SEAL sees. The Eye is open.         ║
║   Discipline. Execution. No excuses.  ║
╚═══════════════════════════════════════╝
`);
console.log(`[seal] Polling every ${POLL_INTERVAL / 1000}s`);
console.log(`[seal] Max concurrent: ${getRunningSlots().max}`);
console.log(`[seal] Ingestion: email=${emailLabel()} whatsapp=${whatsappEnabled ? 'baileys' : 'off'} telegram=${telegramEnabled ? 'bot' : 'off'} discord=${discordEnabled ? 'bot' : 'off'}`);
console.log(`[seal] Dashboard: http://localhost:${process.env.SEAL_WEB_PORT || 3457}`);

// ─── Safety + policy init ──────────────────────────────
ensureDefaultProfiles();
const policy = loadPolicy();
console.log(`[seal] Policy loaded: ${policyRuleCount(policy)} rules (auto_approve=${policy.auto_approve?.length || 0} require_ack=${policy.require_ack?.length || 0} deny=${policy.deny?.length || 0})`);

// One-time migration: OpenEnglish book task should run under shell-allowlisted profile.
// Guarded to only fire when still on the default 'auto' mode so we don't race with
// an in-flight execution that was deliberately reconfigured.
try {
  await db.run(
    `UPDATE tasks SET permission_mode='shell-allowlisted' WHERE id='73a08105' AND permission_mode='auto' AND status!='running'`,
    []
  );
} catch (err) {
  console.warn('[seal] openenglish profile migration skipped:', err.message);
}

// ─── Memory + RTK + Flows init ──────────────────────────
ensurePalace();
const rtkEnabled = isRtkAvailable();
const flows = loadFlows(new URL('../flows', import.meta.url).pathname);
console.log(`[seal] Memory: MemPalace (prefetch/sync enabled)`);
console.log(`[seal] Tokens: RTK ${rtkEnabled ? 'enabled (60-90% compression)' : 'not installed'}`);
console.log(`[seal] Flows: ${Object.keys(flows).length} loaded (${Object.keys(flows).join(', ') || 'none'})`);

// ─── Observers (v0.3.0 — the Eye) ───────────────────────
const gitObserver = new GitObserver(eventBus);
setGitIngester((payload) => gitObserver.ingestHookPayload(payload));
try {
  await gitObserver.start();
  console.log(`[seal] Observer: git (hook endpoint → POST /api/observe/git, drain 30s, scraper 300s)`);
} catch (err) {
  console.warn('[seal] GitObserver failed to start:', err.message);
}

// ─── Event retention (daily purge of events older than 90 days) ─
async function runEventRetention() {
  try {
    const result = await db.run(
      `DELETE FROM events WHERE timestamp < datetime('now', '-90 days')`,
      []
    );
    // better-sqlite3 exposes .changes; libsql exposes .rowsAffected.
    const purged = result?.changes ?? result?.rowsAffected ?? 0;
    if (purged > 0) {
      console.log(`[seal] Event retention: purged ${purged} events older than 90 days`);
    }
  } catch (err) {
    console.warn('[seal] Event retention error:', err.message);
  }
}
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
setInterval(runEventRetention, RETENTION_INTERVAL_MS);
// First run shortly after startup so it doesn't block init.
setTimeout(runEventRetention, 60_000);

// v0.4.0 "SEAL notices" — pattern detector slow-path scheduler.
// Runs every 15m in the background, scanning the events table that
// v0.3.0's Eye layer fills. Writes candidates to the `patterns` table
// where v0.5.0's proposal engine promotes them to 'proposed'.
startDetectorLoop();

// v0.5.0 "SEAL proposes" — proposal engine. Reads observing patterns
// past the confidence/evidence thresholds, drafts automations via the
// LLM provider abstraction, and writes proposal rows for the TL to
// approve/deny in the dashboard. Rate-limited to 3/day, 7-day TTL.
startProposerLoop();

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

// ─── Discord ingestion ──────────────────────────────────

if (discordEnabled) {
  startDiscord(config);
}

// ─── Web dashboard ─────────────────────────────────────

startWeb();

// ─── Sensors ────────────────────────────────────────────

if (config.sensors?.pr_watcher === true) {
  console.log('[seal] pr-watcher sensor enabled (every 15 min)');
  const PR_WATCHER_INTERVAL = 15 * 60 * 1000;
  const tickPrWatcher = async () => {
    try {
      await runPrWatcher();
    } catch (err) {
      console.error('[seal] pr-watcher error:', err.message);
    }
  };
  setInterval(tickPrWatcher, PR_WATCHER_INTERVAL);
  // First tick shortly after startup so the daemon log shows its status
  setTimeout(tickPrWatcher, 5_000);
}

// Azure PR review sensor — polls Azure DevOps REST API (0 tokens),
// creates a smart-review task only when an eligible PR is found.
const AZURE_PR_INTERVAL = (config.sensors?.azure_pr_review_interval_min || 5) * 60 * 1000;
if (config.sensors?.azure_pr_review !== false) {
  console.log(`[seal] azure-pr-review sensor enabled (every ${AZURE_PR_INTERVAL / 60_000} min)`);
  const tickAzurePr = async () => {
    try {
      await runAzurePrReview();
    } catch (err) {
      console.error('[seal] azure-pr-review error:', err.message);
    }
  };
  setInterval(tickAzurePr, AZURE_PR_INTERVAL);
  setTimeout(tickAzurePr, 8_000); // first tick after startup
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
