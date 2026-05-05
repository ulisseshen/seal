import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Single-instance lock (v0.4.0 safety) ──────────────
// Refuse to start if another runner is alive. This guards against
// launchd / `seal start` / direct `node src/runner.js` racing each
// other and producing duplicate task execution + duplicate codex CLI
// calls. See CHANGELOG v0.4.0 (4452 failed codex calls in a loop).
const LOCK_FILE = path.join(os.homedir(), '.config/seal/run/runner.pid');

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (existingPid && !isNaN(existingPid)) {
      try {
        // Signal 0 = check process exists without sending signal
        process.kill(existingPid, 0);
        // Process exists — refuse to start
        console.error(`[seal:lock] Another runner is already running (PID ${existingPid}). Refusing to start.`);
        console.error(`[seal:lock] If you believe this is stale, remove ${LOCK_FILE}`);
        process.exit(1);
      } catch {
        // Process doesn't exist — stale lock, remove it
        console.warn(`[seal:lock] Stale lock found (PID ${existingPid}), cleaning up`);
        try { fs.unlinkSync(LOCK_FILE); } catch {}
      }
    }
  }

  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  console.log(`[seal:lock] Acquired lock (PID ${process.pid})`);
}

function releaseLock() {
  try {
    // Only remove the lock if we still own it (avoid clobbering a fresh runner).
    if (fs.existsSync(LOCK_FILE)) {
      const owned = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (owned === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

acquireLock();
// 'exit' is synchronous and fires regardless of how we shut down (graceful,
// crash, or process.exit). Release the lock there. SIGINT/SIGTERM are wired
// later by gracefulShutdown(); we don't add competing handlers here so that
// subsystems get a chance to drain before the lock vanishes.
process.on('exit', releaseLock);

import {
  getPendingTasks,
  claimPendingTasks,
  getPendingReminders,
  getFiringSupernova,
  getRunningCount,
  setFiring,
  updateLastNotified,
  recoverOrphanTasks,
  db,
} from './db.js';
import { executeTask, getRunningSlots } from './executor.js';
import { notify } from './notify.js';
import { setBreakerNotifier } from './circuit-breaker.js';
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
import { startTeamBuilder } from './brain/team.js';
import { onboardRepo } from './brain/onboard.js';
import { getRepoProfile, listWatchedRepos as listWatched } from './db.js';
import { KnowledgeEngine } from './knowledge/engine.js';
import { SourceRegistry } from './sources/registry.js';
import { TeamsSourcePlugin } from './sources/teams/index.js';
import { AzureDevOpsSourcePlugin } from './sources/azure-devops/index.js';
import { GatewayRouter } from './gateway/router.js';
import { TelegramGateway } from './gateway/telegram/index.js';
import { createActionRegistry } from './actions/index.js';
import { insertTask } from './db.js';
import { BriefingBuilder } from './briefing/builder.js';
import { BriefingScheduler } from './briefing/scheduler.js';
import { ConfigWatcher } from './config-watcher.js';
import { SubsystemManager } from './subsystem-manager.js';

const POLL_INTERVAL = 30_000;       // Check tasks every 30 seconds
const SUPERNOVA_INTERVAL = 60_000;  // Check supernova re-fires every 60 seconds
const CONFIG_DIR = path.join(os.homedir(), '.config', 'seal');

// Config file paths
const INGEST_CONFIG_PATH = path.join(CONFIG_DIR, 'ingest.json');
const SOURCES_CONFIG_PATH = path.join(CONFIG_DIR, 'sources.json');
const GATEWAY_CONFIG_PATH = path.join(CONFIG_DIR, 'gateway.json');
const BRIEFING_CONFIG_PATH = path.join(CONFIG_DIR, 'briefing.json');

// ─── Helper: read a JSON config file from disk ────────────
function readJsonConfig(filePath, fallback = {}) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.warn(`[seal:config] Failed to read ${filePath}:`, err.message);
  }
  return fallback;
}

// Load ingestion config
saveDefaultConfig();
let config = loadConfig();

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

// ─── Orphan task recovery ───────────────────────────────
try {
  const recoveredCount = await recoverOrphanTasks();
  if (recoveredCount > 0) {
    console.log(`[seal] Recovered ${recoveredCount} orphan/SIGTERM'd task(s)`);
  }
} catch (err) {
  console.error('[seal] Orphan recovery failed:', err.message);
}

// ─── Circuit breaker → notification wiring ─────────────
// When a breaker opens (e.g. codex/claude failing 3+ times), fire a
// sticky macOS notification so the user knows SEAL paused itself and
// needs attention. The notification opens the dashboard on click.
setBreakerNotifier(({ name, failures, threshold, cooldownMs, openUntil }) => {
  const cooldownMin = Math.round(cooldownMs / 60_000);
  const summary = `🚨 ${name} bloqueado: ${failures}/${threshold} falhas — pausado por ${cooldownMin}min`;
  console.warn(`[seal] ${summary}`);
  try {
    notify({
      summary,
      priority: 'high',
      detail: `Reabre: ${openUntil}`,
    }, 'sticky');
  } catch (err) {
    console.warn('[seal] breaker notify failed:', err.message);
  }
});

// ─── Memory + RTK + Flows init ──────────────────────────
ensurePalace();
const rtkEnabled = isRtkAvailable();
const flows = loadFlows(new URL('../flows', import.meta.url).pathname);
console.log(`[seal] Memory: MemPalace (prefetch/sync enabled)`);
console.log(`[seal] Tokens: RTK ${rtkEnabled ? 'enabled (60-90% compression)' : 'not installed'}`);
console.log(`[seal] Flows: ${Object.keys(flows).length} loaded (${Object.keys(flows).join(', ') || 'none'})`);

// ─── Subsystem Manager + Config Watcher ────────────────
const configWatcher = new ConfigWatcher();
const subsystemManager = new SubsystemManager();

// ─── Knowledge Sources (subsystem: sources) ────────────
const knowledgeEngine = new KnowledgeEngine(db);
let sourceRegistry = null;

async function startSources() {
  const sourcesConfig = readJsonConfig(SOURCES_CONFIG_PATH);
  sourceRegistry = new SourceRegistry(knowledgeEngine);
  sourceRegistry.register(new TeamsSourcePlugin());
  sourceRegistry.register(new AzureDevOpsSourcePlugin());

  if (Object.keys(sourcesConfig).length > 0) {
    try {
      await sourceRegistry.init(sourcesConfig);
      // Initial sync delayed 30s to not block startup
      setTimeout(async () => {
        try {
          const results = await sourceRegistry.syncAll();
          const summary = Object.entries(results)
            .map(([name, r]) => `${name}=${r.ok ? r.items + ' items' : 'FAIL'}`)
            .join(', ');
          console.log(`[seal:sources] Initial sync complete: ${summary}`);
        } catch (err) {
          console.error('[seal:sources] Initial sync failed:', err.message);
        }
        // Start periodic sync after initial sync
        sourceRegistry.startPeriodicSync(sourcesConfig);
      }, 30_000);
      console.log(`[seal] Sources: ${sourceRegistry.plugins.size} registered, initial sync in 30s`);
    } catch (err) {
      console.error('[seal:sources] Init failed:', err.message);
    }
  } else {
    console.log(`[seal] Sources: no sources.json found, knowledge sources disabled`);
  }
}

async function stopSources() {
  if (sourceRegistry) {
    await sourceRegistry.destroy();
    sourceRegistry = null;
  }
}

await startSources();

subsystemManager.register('sources', {
  start: startSources,
  stop: stopSources,
  configFile: SOURCES_CONFIG_PATH,
});

// ─── Gateway (subsystem: gateway) ──────────────────────
let gateway = null;

async function startGateway() {
  gateway = new GatewayRouter();
  gateway.register(new TelegramGateway());
  try {
    await gateway.init();
    // Wire the gateway into channel-notify so task lifecycle events also
    // fan out to Telegram (not just macOS) — even for tasks created by the
    // azure-pr-review sensor that have notify_channel='system'.
    const { setGatewayRouter } = await import('./channel-notify.js');
    setGatewayRouter(gateway);
  } catch (err) {
    console.warn('[seal:gateway] Init failed (briefing may not send):', err.message);
  }
}

async function stopGateway() {
  if (gateway) {
    await gateway.destroy();
    gateway = null;
    try {
      const { setGatewayRouter } = await import('./channel-notify.js');
      setGatewayRouter(null);
    } catch {}
  }
}

await startGateway();

subsystemManager.register('gateway', {
  start: startGateway,
  stop: stopGateway,
  configFile: GATEWAY_CONFIG_PATH,
});

// ─── Actions ───────────────────────────────────────────
// Actions depend on gateway + knowledgeEngine, re-created when gateway restarts
let actionRegistry = createActionRegistry({ db, gateway, engine: knowledgeEngine, insertTask });

// ─── Briefing (subsystem: briefing) ────────────────────
let briefingBuilder = null;
let briefingScheduler = null;

async function startBriefing() {
  let briefingConfig = { enabled: false };
  try {
    if (fs.existsSync(BRIEFING_CONFIG_PATH)) {
      briefingConfig = JSON.parse(fs.readFileSync(BRIEFING_CONFIG_PATH, 'utf8'));
    } else {
      const sourcesConfig = readJsonConfig(SOURCES_CONFIG_PATH);
      if (sourcesConfig.briefing) {
        briefingConfig = sourcesConfig.briefing;
      }
    }
  } catch (err) {
    console.warn('[seal:briefing] Failed to load briefing config:', err.message);
  }

  // Re-create action registry to pick up current gateway
  actionRegistry = createActionRegistry({ db, gateway, engine: knowledgeEngine, insertTask });

  briefingBuilder = new BriefingBuilder(db, knowledgeEngine, actionRegistry);
  briefingScheduler = new BriefingScheduler(briefingBuilder, gateway, briefingConfig);
  briefingScheduler.wireCallbacks();
  briefingScheduler.start();
  console.log(`[seal] Briefing: ${briefingConfig.enabled !== false ? `scheduled (${briefingConfig.cron || '0 9 * * 1-5'})` : 'disabled'}`);
}

async function stopBriefing() {
  if (briefingScheduler) {
    briefingScheduler.stop();
    briefingScheduler = null;
  }
  briefingBuilder = null;
}

await startBriefing();

subsystemManager.register('briefing', {
  start: startBriefing,
  stop: stopBriefing,
  configFile: BRIEFING_CONFIG_PATH,
});

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

// Team model builder — auto-populates team_members from git.commit
// author metadata. Fires new-contributor alerts when a previously
// unseen author appears.
startTeamBuilder(eventBus);

// v0.4.0 "SEAL notices" — pattern detector slow-path scheduler.
// Runs every 15m in the background, scanning the events table that
// v0.3.0's Eye layer fills. Writes candidates to the `patterns` table
// where v0.5.0's proposal engine promotes them to 'proposed'.
startDetectorLoop();

// v0.5.0 "SEAL proposes" — proposal engine. Reads observing patterns
// past the confidence/evidence thresholds, drafts automations via the
// LLM provider abstraction, and writes proposal rows for the TL to
// approve/deny in the dashboard. Rate-limited to 3/day, 7-day TTL.
// Disabled — codex CLI is failing repeatedly and consuming resources.
// Re-enable when codex is stable: SEAL_BRAIN_PROPOSER=1
if (process.env.SEAL_BRAIN_PROPOSER === '1') {
  startProposerLoop();
} else {
  console.log('[brain] proposer disabled (set SEAL_BRAIN_PROPOSER=1 to enable)');
}

// v0.11.0 "SEAL learns your repo" — auto-onboard watched repos that
// don't have a profile yet. Runs once at startup (delayed 45s to let
// the Eye and detector settle first). Non-blocking: errors are logged,
// not thrown.
// Disabled by default — codex CLI is failing repeatedly. Re-enable: SEAL_AUTO_ONBOARD=1
if (process.env.SEAL_AUTO_ONBOARD !== '1') {
  console.log('[seal] auto-onboard disabled (set SEAL_AUTO_ONBOARD=1 to enable)');
} else setTimeout(async () => {
  try {
    const repos = await listWatched();
    for (const repo of repos) {
      const existing = await getRepoProfile(repo.path);
      if (existing) continue;
      console.log(`[seal] Auto-onboarding new repo: ${repo.name} (${repo.path})`);
      try {
        await onboardRepo(repo.path, {
          onProgress(stage, data) {
            if (stage === 'stats_done') {
              console.log(`[seal] Onboard ${repo.name}: ${data.commits} commits, ${data.contributors} contributors`);
            } else if (stage === 'llm_done') {
              console.log(`[seal] Onboard ${repo.name}: LLM analysis complete`);
            } else if (stage === 'done') {
              console.log(`[seal] Onboard ${repo.name}: profile saved (v${data.version})`);
            }
          },
        });
      } catch (err) {
        console.warn(`[seal] Auto-onboard failed for ${repo.name}:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[seal] Auto-onboard sweep failed:', err.message);
  }
}, 45_000);

console.log(`[seal] Standing by...`);

async function pollTasks() {
  try {
    const slots = getRunningSlots();
    if (slots.available <= 0) return;

    // Atomic claim — marks tasks as 'running' in the same SQL statement so
    // a concurrent tick (e.g. after wake-from-sleep) cannot pick them up.
    const tasks = await claimPendingTasks(slots.available);
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

// ─── Sensors (subsystem: sensors) ──────────────────────

let sensorTimers = [];

function startSensors() {
  const cfg = loadConfig();

  if (cfg.sensors?.pr_watcher === true) {
    console.log('[seal] pr-watcher sensor enabled (every 15 min)');
    const PR_WATCHER_INTERVAL = 15 * 60 * 1000;
    const tickPrWatcher = async () => {
      try {
        await runPrWatcher();
      } catch (err) {
        console.error('[seal] pr-watcher error:', err.message);
      }
    };
    sensorTimers.push(setInterval(tickPrWatcher, PR_WATCHER_INTERVAL));
    sensorTimers.push(setTimeout(tickPrWatcher, 5_000));
  }

  const AZURE_PR_INTERVAL = (cfg.sensors?.azure_pr_review_interval_min || 5) * 60 * 1000;
  if (cfg.sensors?.azure_pr_review !== false) {
    console.log(`[seal] azure-pr-review sensor enabled (every ${AZURE_PR_INTERVAL / 60_000} min)`);
    const tickAzurePr = async () => {
      try {
        await runAzurePrReview();
      } catch (err) {
        console.error('[seal] azure-pr-review error:', err.message);
      }
    };
    sensorTimers.push(setInterval(tickAzurePr, AZURE_PR_INTERVAL));
    sensorTimers.push(setTimeout(tickAzurePr, 8_000));
  }
}

function stopSensors() {
  for (const id of sensorTimers) {
    clearInterval(id);
    clearTimeout(id);
  }
  sensorTimers = [];
  console.log('[seal] Sensors stopped');
}

startSensors();

subsystemManager.register('sensors', {
  start: async () => startSensors(),
  stop: async () => stopSensors(),
  configFile: INGEST_CONFIG_PATH,
});

// ─── Email ingestion (subsystem: email-ingest) ─────────

let emailTimerId = null;

function startEmailIngest() {
  const cfg = loadConfig();
  const eEnabled = cfg.email.enabled;
  const eMode = cfg.email.mode || 'gmail';

  if (eEnabled && eMode === 'webhook') {
    startIngestServer(cfg);
  } else if (eEnabled && eMode === 'gmail') {
    const interval = cfg.email.pollInterval || 300_000;
    emailTimerId = setInterval(() => pollGmail(cfg).catch(err => {
      console.error('[seal] Gmail poll error:', err.message);
    }), interval);
    pollGmail(cfg).catch(err => {
      console.error('[seal] Gmail poll error:', err.message);
    });
  }
}

function stopEmailIngest() {
  if (emailTimerId) {
    clearInterval(emailTimerId);
    emailTimerId = null;
  }
  // Note: webhook server (startIngestServer) doesn't currently have a stop method
}

startEmailIngest();

subsystemManager.register('email-ingest', {
  start: async () => startEmailIngest(),
  stop: async () => stopEmailIngest(),
  configFile: INGEST_CONFIG_PATH,
});

// ─── Telegram ingestion (subsystem: telegram-ingest) ───

function startTelegramIngest() {
  const cfg = loadConfig();
  if (cfg.telegram?.enabled) {
    startTelegram(cfg);
  }
}

function stopTelegramIngest() {
  // telegram.js uses a module-level `bot` variable; stopping polling
  // is done by the bot's stopPolling if available. For now, log the intent.
  // The bot will be replaced on next startTelegram call.
  console.log('[seal] Telegram ingest stopped (will reconnect on restart)');
}

startTelegramIngest();

subsystemManager.register('telegram-ingest', {
  start: async () => startTelegramIngest(),
  stop: async () => stopTelegramIngest(),
  configFile: INGEST_CONFIG_PATH,
});

// ─── WhatsApp ingestion ─────────────────────────────────

if (whatsappEnabled) {
  startWhatsApp(config).catch((err) => {
    console.error('[seal] WhatsApp failed to start:', err.message);
  });
}

// ─── Discord ingestion ──────────────────────────────────

if (discordEnabled) {
  startDiscord(config);
}

// ─── Web dashboard ─────────────────────────────────────

startWeb();

// ─── Main loops ─────────────────────────────────────────

setInterval(pollTasks, POLL_INTERVAL);
setInterval(pollSupernova, SUPERNOVA_INTERVAL);
pollTasks();

// ─── Wire config file watches to subsystem restarts ────
function wireConfigWatchers() {
  const configFiles = [
    INGEST_CONFIG_PATH,
    SOURCES_CONFIG_PATH,
    GATEWAY_CONFIG_PATH,
    BRIEFING_CONFIG_PATH,
  ];

  for (const filePath of configFiles) {
    configWatcher.watch(filePath, async (changedFile) => {
      console.log(`[seal:config] Config file changed: ${changedFile}`);
      try {
        await subsystemManager.restartForConfig(changedFile);
      } catch (err) {
        console.error(`[seal:config] Restart failed for ${changedFile}:`, err.message);
      }
    });
  }
}

wireConfigWatchers();
console.log('[seal] Hot-reload: config watchers active');

// ─── Graceful shutdown ─────────────────────────────────

async function gracefulShutdown() {
  console.log('\n[seal] Shutting down...');
  configWatcher.destroy();
  await subsystemManager.destroyAll();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
