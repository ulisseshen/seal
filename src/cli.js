#!/usr/bin/env node
// SEAL — unified CLI entry point.
//
// All SEAL operations are driven through this binary. It is installed
// as /usr/local/bin/seal (or ~/.local/bin/seal) during install.sh.
//
// Daemon management commands spawn background processes with detached
// stdio, PID files under ~/.config/seal/, and log files that `seal logs`
// tails. The daemon itself is src/runner.js; the dashboard is
// dashboard/server.js — both discovered relative to this file.

import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync, spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { setSecret, getSecret, delSecret, hasSecret, backend } from './secrets.js';
import { listSkills, runSkill, getSkillByName } from './brain/skills.js';
import { readAlertConfig, writeAlertConfig, sendAlert } from './brain/alert.js';
import { onboardRepo } from './brain/onboard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const RUNNER_PATH = join(__dirname, 'runner.js');
const DASHBOARD_PATH = join(PROJECT_ROOT, 'dashboard', 'server.js');

const SEAL_DIR = process.env.SEAL_DIR || join(process.env.HOME, '.config', 'seal');
const CHAT_CONFIG = join(SEAL_DIR, 'chat-config.json');
const CHANNELS_CONFIG = join(SEAL_DIR, 'channels.json');
const RUN_DIR = join(SEAL_DIR, 'run');
const LOG_DIR = join(SEAL_DIR, 'logs');

// Daemon registry: name → paths + description used by all daemon commands.
const DAEMONS = {
  runner: {
    label: 'runner (task loop, detectors, proposer, observers)',
    script: RUNNER_PATH,
    pidFile: join(RUN_DIR, 'runner.pid'),
    logFile: join(LOG_DIR, 'runner.log'),
  },
  dashboard: {
    label: 'dashboard (http://localhost:3333)',
    script: DASHBOARD_PATH,
    pidFile: join(RUN_DIR, 'dashboard.pid'),
    logFile: join(LOG_DIR, 'dashboard.log'),
  },
};

function ensureRuntimeDirs() {
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

const PROVIDERS = {
  claude:  { label: 'Claude (via claude CLI)',       defaultModel: 'claude-opus-4-6',  authMode: 'cli-managed' },
  codex:   { label: 'Codex (via codex CLI)',         defaultModel: 'gpt-5',            authMode: 'cli-managed' },
  gemini:  { label: 'Gemini (Google AI Studio key)', defaultModel: 'gemini-2.5-pro',   authMode: 'token' },
  openai:  { label: 'OpenAI (sk-... from platform)', defaultModel: 'gpt-4.1-mini',     authMode: 'token' },
  ollama:  { label: 'Ollama (local, http://...)',    defaultModel: 'llama3.1',         authMode: 'host' },
};

// --- utilities ---

const C = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function readJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

function writeJSON(path, obj) {
  mkdirSync(SEAL_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith('--')) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function promptHidden(rl, question) {
  // readline doesn't natively hide input; we monkey-patch _writeToOutput during the prompt.
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let buf = '';
    const onData = (char) => {
      char = char.toString();
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\n');
        resolve(buf);
      } else if (char === '\u0003') {
        process.exit(0);
      } else if (char === '\u007f' || char === '\b') {
        if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        buf += char;
        process.stdout.write('*');
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function which(bin) {
  const r = spawnSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.toString().trim() : null;
}

// --- commands ---

function cmdStatus() {
  const chat = readJSON(CHAT_CONFIG, {});
  const channels = readJSON(CHANNELS_CONFIG, {});

  console.log();
  console.log(C.bold('  SEAL configuration'));
  console.log(C.dim(`  Secret backend: ${backend()}`));
  console.log();
  console.log(C.bold('  Providers'));
  for (const [name, meta] of Object.entries(PROVIDERS)) {
    const isDefault = chat.provider === name ? C.green(' (default)') : '';
    let credStatus;
    if (meta.authMode === 'cli-managed') {
      const bin = which(name);
      credStatus = bin ? C.green('CLI installed') : C.yellow('CLI not found');
    } else {
      credStatus = hasSecret(name, 'api_key') ? C.green('token saved') : C.dim('not configured');
    }
    if (meta.authMode === 'host') {
      const host = getSecret(name, 'host') || process.env.OLLAMA_HOST || 'http://localhost:11434';
      credStatus = `${C.green('host')} ${C.dim(host)}`;
    }
    console.log(`    ${C.cyan(name.padEnd(8))} ${meta.label.padEnd(36)} ${credStatus}${isDefault}`);
  }
  console.log();
  console.log(C.bold('  Channels'));
  const chList = Object.entries(channels);
  if (chList.length === 0) {
    console.log(C.dim('    (none configured)'));
  } else {
    for (const [name, cfg] of chList) {
      const on = cfg?.enabled ? C.green('enabled') : C.dim('disabled');
      console.log(`    ${C.cyan(name.padEnd(10))} ${on}`);
    }
  }
  console.log();
}

async function cmdProvider(args) {
  const { flags, positional } = parseFlags(args);
  const name = positional[0];

  if (!name) {
    console.error(C.red('Missing provider name. Options: ') + Object.keys(PROVIDERS).join(', '));
    process.exit(1);
  }
  if (!PROVIDERS[name]) {
    console.error(C.red(`Unknown provider "${name}". Options: `) + Object.keys(PROVIDERS).join(', '));
    process.exit(1);
  }
  const meta = PROVIDERS[name];

  // --remove
  if (flags.remove) {
    if (meta.authMode === 'token') {
      const ok = delSecret(name, 'api_key');
      console.log(ok ? C.green(`✓ Removed ${name} token`) : C.yellow(`No ${name} token to remove`));
    } else if (meta.authMode === 'host') {
      const ok = delSecret(name, 'host');
      console.log(ok ? C.green(`✓ Removed ${name} host override`) : C.yellow(`No ${name} host override to remove`));
    } else {
      console.log(C.yellow(`${name} auth is managed by its CLI. Run \`${name} logout\` to sign out.`));
    }
    return;
  }

  // Host-based provider (ollama)
  if (meta.authMode === 'host') {
    let host = typeof flags.host === 'string' ? flags.host : null;
    if (!host) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(C.cyan(`Configuring ${meta.label}`));
        host = await prompt(rl, `Host URL [http://localhost:11434]: `);
      } finally { rl.close(); }
      if (!host) host = 'http://localhost:11434';
    }
    setSecret(name, 'host', host);
    setDefaultProvider(name, flags.model || meta.defaultModel);
    console.log(C.green(`✓ ${name} host saved (${host})`));
    return;
  }

  // --login (delegate to provider CLI)
  if (flags.login) {
    if (meta.authMode !== 'cli-managed') {
      console.error(C.red(`--login not supported for ${name}. Use --token instead.`));
      process.exit(1);
    }
    const bin = which(name);
    if (!bin) {
      console.error(C.red(`${name} CLI not found in PATH. Install it first.`));
      process.exit(1);
    }
    // Forward --device-auth if present (useful for remote/headless machines)
    const loginArgs = ['login'];
    if (flags['device-auth']) loginArgs.push('--device-auth');
    console.log(C.cyan(`→ Delegating to \`${name} ${loginArgs.join(' ')}\`...`));
    if (!flags['device-auth']) {
      console.log(C.dim(`  (on a remote machine? use: seal setup provider ${name} --login --device-auth)`));
    }
    const r = spawnSync(name, loginArgs, { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(C.red(`${name} login failed (exit ${r.status})`));
      process.exit(r.status || 1);
    }
    setDefaultProvider(name, flags.model || meta.defaultModel);
    console.log(C.green(`✓ ${name} configured`));
    return;
  }

  // Token-based provider (gemini, or forced --token for any)
  if (meta.authMode === 'token' || flags.token) {
    let token = typeof flags.token === 'string' ? flags.token : null;
    if (!token) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(C.cyan(`Configuring ${meta.label}`));
        token = await promptHidden(rl, `API key: `);
      } finally { rl.close(); }
    }
    if (!token) { console.error(C.red('No token provided.')); process.exit(1); }
    setSecret(name, 'api_key', token);
    setDefaultProvider(name, flags.model || meta.defaultModel);
    console.log(C.green(`✓ ${name} token saved to ${backend()}`));
    return;
  }

  // CLI-managed provider without --login: just verify + set default
  if (meta.authMode === 'cli-managed') {
    const bin = which(name);
    if (!bin) {
      console.error(C.red(`${name} CLI not found in PATH. Install it, then run:`));
      console.error(C.dim(`  seal setup provider ${name} --login`));
      process.exit(1);
    }
    setDefaultProvider(name, flags.model || meta.defaultModel);
    console.log(C.green(`✓ ${name} set as default (auth managed by ${name} CLI)`));
  }
}

function setDefaultProvider(name, model) {
  const cfg = readJSON(CHAT_CONFIG, {});
  cfg.provider = name;
  cfg.model = model;
  cfg.system_prompt = cfg.system_prompt || 'You are SEAL, an autonomous tech-lead assistant.';
  // strip legacy api_key if it exists in chat-config.json
  delete cfg.api_key;
  writeJSON(CHAT_CONFIG, cfg);
}

async function cmdAlerts(args) {
  const [sub, ...rest] = args;
  const { flags } = parseFlags(rest);

  if (!sub || sub === 'status') {
    const cfg = readAlertConfig();
    console.log();
    console.log(C.bold('  Alert routing'));
    console.log(`    ${C.cyan('dashboard_url'.padEnd(16))} ${cfg.dashboard_url}`);
    console.log(`    ${C.cyan('macos'.padEnd(16))} ${cfg.macos ? C.green('enabled') : C.dim('disabled')}`);
    const tg = cfg.telegram;
    if (tg.bot_token && tg.chat_id) {
      console.log(`    ${C.cyan('telegram'.padEnd(16))} ${C.green('configured')} ${C.dim('(chat ' + tg.chat_id + ')')}`);
    } else {
      console.log(`    ${C.cyan('telegram'.padEnd(16))} ${C.dim('not configured')}`);
    }
    if (cfg.discord.webhook_url) {
      console.log(`    ${C.cyan('discord'.padEnd(16))} ${C.green('configured')} ${C.dim('(webhook)')}`);
    } else {
      console.log(`    ${C.cyan('discord'.padEnd(16))} ${C.dim('not configured')}`);
    }
    console.log();
    console.log(C.dim('  Config file: ~/.config/seal/alerts.json'));
    console.log();
    return;
  }

  if (sub === 'test') {
    console.log(C.cyan('→ firing test alert to every configured channel…'));
    sendAlert({
      kind: 'test',
      title: 'Test alert',
      body: 'If you see this on your phone, the channel is wired correctly.',
      path: '/',
    });
    console.log(C.green('  sent (check your channels)'));
    return;
  }

  const cfg = readAlertConfig();

  if (sub === 'telegram') {
    if (flags.remove) {
      cfg.telegram = { bot_token: '', chat_id: '' };
      writeAlertConfig(cfg);
      console.log(C.green('✓ telegram alert target removed'));
      return;
    }
    const token = typeof flags.token === 'string' ? flags.token : '';
    const chatId = typeof flags['chat-id'] === 'string' ? flags['chat-id'] : '';
    if (!token || !chatId) {
      console.error(C.red('Usage: seal setup alerts telegram --token <bot_token> --chat-id <chat_id>'));
      console.error(C.dim('  Get a bot token from @BotFather.'));
      console.error(C.dim('  Get your chat ID by sending any message to the bot, then visit'));
      console.error(C.dim('  https://api.telegram.org/bot<TOKEN>/getUpdates'));
      process.exit(1);
    }
    cfg.telegram = { bot_token: token, chat_id: chatId };
    writeAlertConfig(cfg);
    console.log(C.green('✓ telegram alert target saved'));
    return;
  }

  if (sub === 'discord') {
    if (flags.remove) {
      cfg.discord = { webhook_url: '' };
      writeAlertConfig(cfg);
      console.log(C.green('✓ discord alert target removed'));
      return;
    }
    const webhook = typeof flags.webhook === 'string' ? flags.webhook : '';
    if (!webhook) {
      console.error(C.red('Usage: seal setup alerts discord --webhook <webhook_url>'));
      console.error(C.dim('  Create a webhook in Server Settings → Integrations → Webhooks.'));
      process.exit(1);
    }
    cfg.discord = { webhook_url: webhook };
    writeAlertConfig(cfg);
    console.log(C.green('✓ discord alert target saved'));
    return;
  }

  if (sub === 'url') {
    const u = typeof flags.url === 'string' ? flags.url : rest[0];
    if (!u) {
      console.error(C.red('Usage: seal setup alerts url <http://...>'));
      process.exit(1);
    }
    cfg.dashboard_url = u;
    writeAlertConfig(cfg);
    console.log(C.green(`✓ dashboard_url set to ${u}`));
    return;
  }

  if (sub === 'macos') {
    if (flags.off || rest.includes('off')) { cfg.macos = false; }
    else { cfg.macos = true; }
    writeAlertConfig(cfg);
    console.log(C.green(`✓ macOS alerts ${cfg.macos ? 'enabled' : 'disabled'}`));
    return;
  }

  console.error(C.red(`Unknown alerts command: ${sub}`));
  console.error(C.dim('Options: status, test, telegram, discord, url, macos'));
  process.exit(1);
}

async function cmdChannel(args) {
  const { flags, positional } = parseFlags(args);
  const name = positional[0];
  if (!name) { console.error(C.red('Missing channel name.')); process.exit(1); }

  const cfg = readJSON(CHANNELS_CONFIG, {});
  cfg[name] = cfg[name] || { enabled: false };

  if (flags.set) {
    const assignments = Array.isArray(flags.set) ? flags.set : [flags.set];
    for (const a of assignments) {
      const [k, ...rest] = a.split('=');
      cfg[name][k] = rest.join('=');
    }
    cfg[name].enabled = true;
    writeJSON(CHANNELS_CONFIG, cfg);
    console.log(C.green(`✓ Channel ${name} updated`));
    return;
  }

  if (flags.disable) {
    cfg[name].enabled = false;
    writeJSON(CHANNELS_CONFIG, cfg);
    console.log(C.green(`✓ Channel ${name} disabled`));
    return;
  }

  console.log(C.yellow(`No action given. Use --set key=value or --disable.`));
}

async function cmdInteractive() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log();
    console.log(C.bold('  SEAL interactive setup'));
    console.log(C.dim('  Ctrl+C to exit at any time'));
    console.log();

    // Provider
    console.log(C.bold('  1. Chat provider'));
    const opts = Object.entries(PROVIDERS);
    opts.forEach(([name, meta], i) => {
      console.log(`     ${i + 1}. ${C.cyan(name.padEnd(8))} ${meta.label}`);
    });
    const choice = await prompt(rl, '  → Pick a provider (number, empty to skip): ');
    if (choice) {
      const idx = parseInt(choice) - 1;
      const picked = opts[idx];
      if (picked) {
        const [name, meta] = picked;
        rl.close(); // we'll use our own input handling below
        if (meta.authMode === 'cli-managed') {
          const bin = which(name);
          if (bin) {
            await cmdProvider([name, '--login']);
          } else {
            console.log(C.yellow(`  ${name} CLI not in PATH. Install it, then re-run setup.`));
          }
        } else {
          await cmdProvider([name]);
        }
        console.log();
        cmdStatus();
        return;
      }
    }
    rl.close();
    cmdStatus();
  } catch (err) {
    rl.close();
    throw err;
  }
}

function help() {
  console.log(`
${C.bold('SEAL')} — autonomous Tech Lead assistant

  ${C.bold('Daemon')}
  seal start [runner|dashboard]          start background services (default: both)
  seal stop  [runner|dashboard]          stop background services (default: both)
  seal restart [runner|dashboard]        stop + start
  seal ps                                show running services + PIDs
  seal status                            show lock + circuit breakers + tasks
  seal logs [runner|dashboard] [-f]      tail service logs
  seal open                              open the dashboard in the browser

  ${C.bold('Setup')}
  seal setup                             interactive menu
  seal setup status                      show configured providers/channels
  seal setup provider <name>             interactive token / select default
  seal setup provider <name> --token X [--model Y]
  seal setup provider codex --login      delegate to \`codex login\`
  seal setup provider <name> --remove
  seal setup channel <name> --set key=value
  seal setup channel <name> --disable

  ${C.bold('Alert routing (phone nudges)')}
  seal setup alerts status               show configured alert channels
  seal setup alerts test                 fire a test alert to every channel
  seal setup alerts telegram --token <bot_token> --chat-id <id>
  seal setup alerts discord --webhook <url>
  seal setup alerts url <dashboard_url>  for phones outside localhost
  seal setup alerts macos [off]          toggle macOS system notifications

  ${C.bold('Repo onboarding (v0.11.0 "SEAL learns your repo")')}
  seal onboard [path]                    deep-scan git history + LLM profile
  seal onboard [path] --force            re-analyze even if profile exists
  seal onboard [path] --stats-only       gather stats without LLM synthesis

  ${C.bold('Skills (v0.6.0 "SEAL remembers")')}
  seal skills                            list installed skills
  seal run <name> [args...]              invoke a skill

${C.dim('Providers: claude, codex, gemini, openai, ollama')}
${C.dim('Config:    ' + SEAL_DIR)}
${C.dim('Install:   ' + PROJECT_ROOT)}
`);
}

// ─── Daemon management ────────────────────────────────

function readPidFile(pidFile) {
  if (!existsSync(pidFile)) return null;
  try {
    const raw = readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function clearStalePidFile(pidFile) {
  const pid = readPidFile(pidFile);
  if (pid && !isAlive(pid)) {
    try { unlinkSync(pidFile); } catch {}
    return true;
  }
  return false;
}

function resolveDaemonName(arg) {
  if (!arg || arg === 'all') return ['runner', 'dashboard'];
  if (DAEMONS[arg]) return [arg];
  throw new Error(`Unknown daemon "${arg}". Options: runner, dashboard, all`);
}

function startDaemon(name) {
  const d = DAEMONS[name];
  if (!d) throw new Error(`Unknown daemon: ${name}`);

  clearStalePidFile(d.pidFile);
  const existing = readPidFile(d.pidFile);
  if (existing && isAlive(existing)) {
    console.log(`  ${C.yellow('•')} ${name} already running (pid ${existing})`);
    return { name, pid: existing, state: 'already-running' };
  }

  ensureRuntimeDirs();
  const out = openSync(d.logFile, 'a');
  const err = openSync(d.logFile, 'a');

  const child = spawn(process.execPath, [d.script], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, SEAL_DIR },
  });
  child.unref();
  // For runner, the runner.js itself writes the pid file via acquireLock().
  // The CLI must NOT pre-write it, otherwise acquireLock() sees a stale
  // PID written by the CLI (the runner's own future pid is *not yet* here)
  // and refuses to start. For other daemons (dashboard, etc.), the CLI
  // still owns the pid file.
  if (name !== 'runner') {
    writeFileSync(d.pidFile, String(child.pid));
  }
  console.log(`  ${C.green('✓')} ${name} started (pid ${child.pid})  ${C.dim('→ ' + d.logFile)}`);
  return { name, pid: child.pid, state: 'started' };
}

function stopDaemon(name) {
  const d = DAEMONS[name];
  if (!d) throw new Error(`Unknown daemon: ${name}`);

  const pid = readPidFile(d.pidFile);
  if (!pid) {
    console.log(`  ${C.dim('•')} ${name} not running`);
    return { name, state: 'not-running' };
  }
  if (!isAlive(pid)) {
    try { unlinkSync(d.pidFile); } catch {}
    console.log(`  ${C.dim('•')} ${name} stale pid file cleaned (${pid})`);
    return { name, state: 'stale' };
  }

  try {
    process.kill(pid, 'SIGTERM');
    // Small grace window then force-kill if still alive.
    const deadline = Date.now() + 4000;
    while (isAlive(pid) && Date.now() < deadline) {
      spawnSync('sleep', ['0.1']);
    }
    if (isAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
    try { unlinkSync(d.pidFile); } catch {}
    console.log(`  ${C.green('✓')} ${name} stopped (was pid ${pid})`);
    return { name, pid, state: 'stopped' };
  } catch (err) {
    console.log(`  ${C.red('✗')} ${name} kill failed: ${err.message}`);
    return { name, pid, state: 'error', error: err.message };
  }
}

function checkProviderReady() {
  // Check if at least one LLM provider is configured and usable.
  // Without a provider, the proposer, ingest drafter, and chat are all dead.
  const cfg = readJSON(CHAT_CONFIG, {});
  const providerName = cfg.provider || 'claude';
  const meta = PROVIDERS[providerName];
  if (!meta) return false;

  if (meta.authMode === 'cli-managed') {
    return Boolean(which(providerName));
  }
  if (meta.authMode === 'token') {
    return hasSecret(providerName, 'api_key');
  }
  if (meta.authMode === 'host') {
    return true; // ollama is always "available" (fails at runtime if server is down)
  }
  return false;
}

function cmdStart(args) {
  const names = resolveDaemonName(args[0]);

  // Pre-flight: warn if no LLM provider is ready.
  if (!checkProviderReady()) {
    console.log();
    console.log(`  ${C.yellow('⚠')} ${C.bold('No LLM provider configured.')}`);
    console.log(`    The detector finds patterns, but the proposer, ingest drafter,`);
    console.log(`    and chat all need a model to operate. Configure one first:`);
    console.log();
    console.log(`    ${C.cyan('seal setup provider claude')}          ${C.dim('(uses your Claude Code login)')}`);
    console.log(`    ${C.cyan('seal setup provider codex --login')}   ${C.dim('(delegates to codex login)')}`);
    console.log(`    ${C.cyan('seal setup provider gemini --token X')} ${C.dim('(Google AI Studio key)')}`);
    console.log(`    ${C.cyan('seal setup provider openai --token X')} ${C.dim('(OpenAI platform key)')}`);
    console.log(`    ${C.cyan('seal setup provider ollama')}          ${C.dim('(local, no key needed)')}`);
    console.log();
    console.log(`    ${C.dim('Continuing anyway — the Eye and detector will work; the Brain won\'t.')}`);
    console.log();
  }

  console.log();
  console.log(C.bold('  Starting…'));
  for (const name of names) {
    const result = startDaemon(name);
    if (name === 'dashboard' && (result.state === 'started' || result.state === 'already-running')) {
      const dashUrl = process.env.SEAL_DASHBOARD_URL || 'http://localhost:3333';
      console.log();
      console.log(`  ${C.cyan('Dashboard:')} ${C.bold(dashUrl)}`);
    }
  }
  console.log();
}

function cmdStop(args) {
  const names = resolveDaemonName(args[0]);
  console.log();
  console.log(C.bold('  Stopping…'));
  for (const name of names) stopDaemon(name);
  console.log();
}

async function cmdRestart(args) {
  cmdStop(args);
  // Tiny pause so TCP ports release cleanly
  spawnSync('sleep', ['0.3']);
  cmdStart(args);
}

function cmdPs() {
  ensureRuntimeDirs();
  console.log();
  console.log(C.bold('  SEAL services'));
  for (const [name, d] of Object.entries(DAEMONS)) {
    clearStalePidFile(d.pidFile);
    const pid = readPidFile(d.pidFile);
    const alive = isAlive(pid);
    const status = alive ? C.green('running') : C.dim('stopped');
    const pidStr = alive ? C.dim(`pid ${pid}`) : '';
    console.log(`    ${C.cyan(name.padEnd(10))} ${status.padEnd(18)} ${pidStr}`);
    console.log(`      ${C.dim(d.label)}`);
    if (existsSync(d.logFile)) {
      try {
        const size = statSync(d.logFile).size;
        console.log(`      ${C.dim('log: ' + d.logFile + ' (' + humanSize(size) + ')')}`);
      } catch {}
    }
  }
  console.log();
}

// `seal status` — debug helper: shows lock + circuit breakers + running tasks
// without having to grep the runner log. Added in v0.4.0 alongside the
// safety mechanisms so the answer to "why isn't SEAL doing anything?" is
// one command away. Reads files directly so it works even if the runner is
// down.
async function cmdStatusOverview() {
  ensureRuntimeDirs();

  console.log();
  console.log(C.bold('  SEAL runtime status'));
  console.log();

  // ─── Lock ──────────────────────────────────────────
  const lockFile = join(RUN_DIR, 'runner.pid');
  console.log(C.bold('  Runner lock'));
  if (!existsSync(lockFile)) {
    console.log(`    ${C.dim('• no lock file (runner not running)')}`);
  } else {
    try {
      const pid = parseInt(readFileSync(lockFile, 'utf-8').trim(), 10);
      const alive = isAlive(pid);
      const state = alive ? C.green('alive') : C.yellow('stale');
      console.log(`    ${C.cyan('pid'.padEnd(12))} ${pid} ${state}`);
      console.log(`    ${C.cyan('file'.padEnd(12))} ${C.dim(lockFile)}`);
      if (!alive) {
        console.log(`    ${C.dim('  (next `seal start` will clean this up)')}`);
      }
    } catch (err) {
      console.log(`    ${C.red('• lock file unreadable:')} ${err.message}`);
    }
  }
  console.log();

  // ─── Circuit breakers ──────────────────────────────
  // Breakers live in-process, so we can only show them when the runner is
  // up. We import lazily to avoid pulling DB init into a status command.
  console.log(C.bold('  Circuit breakers'));
  try {
    const { listBreakers } = await import('./circuit-breaker.js');
    const rows = listBreakers();
    if (rows.length === 0) {
      console.log(`    ${C.dim('• none registered yet (no LLM calls this session)')}`);
    } else {
      for (const b of rows) {
        const state = b.open ? C.red(`OPEN until ${b.openUntil}`) : C.green('closed');
        console.log(`    ${C.cyan(b.name.padEnd(12))} ${state}  ${C.dim(`failures=${b.failures}/${b.threshold}`)}`);
      }
    }
  } catch (err) {
    console.log(`    ${C.red('• failed to read breakers:')} ${err.message}`);
  }
  console.log();

  // ─── Subsystems / running tasks (only meaningful when runner is up) ─
  console.log(C.bold('  Subsystems & tasks'));
  const runnerLockExists = existsSync(lockFile);
  let runnerAlive = false;
  if (runnerLockExists) {
    try {
      const pid = parseInt(readFileSync(lockFile, 'utf-8').trim(), 10);
      runnerAlive = isAlive(pid);
    } catch {}
  }

  if (!runnerAlive) {
    console.log(`    ${C.dim('• runner is down; subsystem state unavailable')}`);
    console.log(`    ${C.dim('  start it with `seal start runner`')}`);
  } else {
    // Runner is alive — query the DB for task counts. We can read the same
    // SQLite file the runner uses; better-sqlite3 / libsql both support
    // concurrent readers.
    try {
      const { db } = await import('./db.js');
      const running = await db.get(`SELECT COUNT(*) as c FROM tasks WHERE status = 'running'`);
      const pending = await db.get(`SELECT COUNT(*) as c FROM tasks WHERE status = 'pending'`);
      const firing = await db.get(`SELECT COUNT(*) as c FROM tasks WHERE status = 'firing'`);
      const doneToday = await db.get(`SELECT COUNT(*) as c FROM tasks WHERE status = 'done' AND date(created) = date('now')`);
      console.log(`    ${C.cyan('running'.padEnd(12))} ${running?.c ?? 0}`);
      console.log(`    ${C.cyan('pending'.padEnd(12))} ${pending?.c ?? 0}`);
      console.log(`    ${C.cyan('firing'.padEnd(12))} ${firing?.c ?? 0}`);
      console.log(`    ${C.cyan('done today'.padEnd(12))} ${doneToday?.c ?? 0}`);

      // Today's proposals (fatigue gate visibility)
      const proposalsToday = await db.get(`SELECT COUNT(*) as c FROM proposals WHERE date(delivered_at) = date('now')`);
      console.log(`    ${C.cyan('proposals'.padEnd(12))} ${proposalsToday?.c ?? 0}/3 today`);
    } catch (err) {
      console.log(`    ${C.red('• failed to query tasks:')} ${err.message}`);
    }
  }
  console.log();
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function cmdLogs(args) {
  const { flags, positional } = parseFlags(args);
  const name = positional[0] || 'runner';
  const d = DAEMONS[name];
  if (!d) {
    console.error(C.red(`Unknown daemon "${name}". Options: runner, dashboard`));
    process.exit(1);
  }
  if (!existsSync(d.logFile)) {
    console.log(C.dim(`  (no log file yet — run \`seal start ${name}\` first)`));
    return;
  }
  const follow = flags.f || flags.follow;
  const args2 = follow ? ['-n', '200', '-F', d.logFile] : ['-n', '200', d.logFile];
  // Hand off to tail; user's Ctrl+C ends the follow.
  const child = spawn('tail', args2, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

function cmdOpen() {
  const url = process.env.SEAL_DASHBOARD_URL || 'http://localhost:3333';
  const opener = process.platform === 'darwin' ? 'open'
                : process.platform === 'win32' ? 'start'
                : 'xdg-open';
  const r = spawnSync(opener, [url], { stdio: 'ignore' });
  if (r.status !== 0) {
    console.log(C.yellow(`Open manually: ${url}`));
  } else {
    console.log(C.green(`✓ opened ${url}`));
  }
}

async function cmdSkills() {
  const rows = await listSkills({});
  if (rows.length === 0) {
    console.log(C.dim('  (no skills yet — approve a proposal in the dashboard to create one)'));
    return;
  }
  console.log();
  console.log(C.bold('  Skills'));
  for (const s of rows) {
    const stats = `${s.run_count} runs (${s.success_count} ok, ${s.failure_count} fail)`;
    const last = s.last_run_at ? ` · last ${s.last_run_at.slice(0, 10)}` : '';
    console.log(`    ${C.cyan(s.name.padEnd(28))} ${C.dim(s.state.padEnd(8))} ${stats}${last}`);
    if (s.description) console.log(`      ${C.dim(s.description.slice(0, 100))}`);
  }
  console.log();
}

async function cmdRun(args) {
  const [name, ...rest] = args;
  if (!name) {
    console.error(C.red('Usage: seal run <name> [args...]'));
    process.exit(1);
  }
  const skill = await getSkillByName(name);
  if (!skill) {
    console.error(C.red(`skill not found: ${name}`));
    process.exit(1);
  }
  console.log(C.cyan(`→ running ${skill.name}…`));
  const result = await runSkill(name, rest);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.log(C.dim(`  (exit ${result.exit_code}, ${result.duration_ms}ms)`));
  process.exit(result.exit_code === 0 ? 0 : 1);
}

// ─── Repo onboarding ─────────────────────────────────

async function cmdOnboard(args) {
  const flags = args.filter(a => a.startsWith('--'));
  const positional = args.filter(a => !a.startsWith('--'));
  const repoPath = positional[0] || process.cwd();
  const force = flags.includes('--force');
  const skipLlm = flags.includes('--stats-only');

  const { resolve } = await import('path');
  const absPath = resolve(repoPath);

  console.log();
  console.log(C.bold('  SEAL — Repo Onboarding'));
  console.log(`  ${C.dim(absPath)}`);
  console.log();

  try {
    const profile = await onboardRepo(absPath, {
      force,
      skipLlm,
      onProgress(stage, data) {
        switch (stage) {
          case 'profile_exists':
            console.log(`  ${C.yellow('ℹ')} Profile already exists (v${data.version}, ${data.analyzed_at})`);
            console.log(`    ${C.dim('Use --force to re-analyze')}`);
            break;
          case 'scanning':
            console.log(`  ${C.cyan('⟳')} Scanning git history…`);
            break;
          case 'stats_done':
            console.log(`  ${C.green('✓')} ${data.commits} commits, ${data.contributors} contributors, ${data.branches} branches`);
            break;
          case 'llm_start':
            console.log(`  ${C.cyan('⟳')} Synthesizing with LLM…`);
            break;
          case 'llm_unavailable':
            console.log(`  ${C.yellow('⚠')} LLM provider "${data.provider}" not available — stats-only profile`);
            break;
          case 'llm_done':
            console.log(`  ${C.green('✓')} LLM analysis complete`);
            break;
          case 'done':
            console.log(`  ${C.green('✓')} Profile saved (v${data.version})`);
            break;
        }
      },
    });

    // Print summary
    const stats = profile.stats || {};
    const llm = profile.llm_analysis || {};

    console.log();
    console.log(C.bold(`  ${profile.repo_name}`));
    console.log(`  ${C.dim('─'.repeat(40))}`);

    if (stats.workingHours) {
      const wh = stats.workingHours;
      console.log(`  ${C.cyan('Hours:')}    peak at ${wh.peakHours?.slice(0, 3).join('h, ')}h`);
      console.log(`  ${C.cyan('Weekend:')}  ${(wh.weekendRatio * 100).toFixed(0)}% of commits`);
    }

    if (stats.conventions?.conventionalCommits) {
      const cc = stats.conventions.conventionalCommits;
      console.log(`  ${C.cyan('Commits:')}  ${(cc.ratio * 100).toFixed(0)}% conventional${cc.usesScopes ? ' (with scopes)' : ''}`);
    }

    if (stats.branches) {
      const prefixes = Object.entries(stats.branches.prefixes || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([p, n]) => `${p}(${n})`)
        .join(', ');
      console.log(`  ${C.cyan('Branches:')} ${stats.branches.count} — ${prefixes}`);
    }

    if (stats.tags) {
      console.log(`  ${C.cyan('Releases:')} ${stats.tags.releaseCadence?.frequency || 'unknown'} (${stats.tags.pattern?.pattern || 'no tags'})`);
    }

    if (stats.velocity) {
      console.log(`  ${C.cyan('Velocity:')} ${stats.velocity.commitsPerWeek} commits/week (${stats.velocity.trend})`);
    }

    if (stats.contributors) {
      const top = stats.contributors.slice(0, 3).map(c => c.name).join(', ');
      console.log(`  ${C.cyan('Team:')}     ${stats.contributors.length} contributors — ${top}`);
    }

    // LLM recommendations
    if (llm.seal_recommendations && Array.isArray(llm.seal_recommendations)) {
      console.log();
      console.log(C.bold('  Recommendations'));
      for (const rec of llm.seal_recommendations.slice(0, 6)) {
        const text = typeof rec === 'string' ? rec : rec.description || rec.recommendation || JSON.stringify(rec);
        console.log(`    ${C.green('→')} ${text}`);
      }
    }

    if (llm.summary) {
      console.log();
      console.log(`  ${C.dim(typeof llm.summary === 'string' ? llm.summary : JSON.stringify(llm.summary))}`);
    }

    console.log();
  } catch (err) {
    console.error(`  ${C.red('✗')} ${err.message}`);
    process.exit(1);
  }
}

// --- entrypoint ---

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);

  if (!cmd) { help(); return; }

  if (cmd === 'setup') {
    if (!sub)                         return cmdInteractive();
    if (sub === 'status')             return cmdStatus();
    if (sub === 'provider')           return cmdProvider(rest);
    if (sub === 'channel')            return cmdChannel(rest);
    if (sub === 'alerts')             return cmdAlerts(rest);
    if (sub === 'help' || sub === '-h' || sub === '--help') return help();
    console.error(C.red(`Unknown setup command: ${sub}`));
    help();
    process.exit(1);
  }

  if (cmd === 'skills')  return cmdSkills();
  if (cmd === 'run')     return cmdRun([sub, ...rest].filter(Boolean));
  if (cmd === 'onboard') return cmdOnboard([sub, ...rest].filter(Boolean));

  // Daemon management
  if (cmd === 'start')    return cmdStart([sub, ...rest].filter(Boolean));
  if (cmd === 'stop')     return cmdStop([sub, ...rest].filter(Boolean));
  if (cmd === 'restart')  return cmdRestart([sub, ...rest].filter(Boolean));
  if (cmd === 'ps')       return cmdPs();
  if (cmd === 'status')   return cmdStatusOverview();
  if (cmd === 'logs')     return cmdLogs([sub, ...rest].filter(Boolean));
  if (cmd === 'open')     return cmdOpen();

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') { help(); return; }

  console.error(C.red(`Unknown command: ${cmd}`));
  help();
  process.exit(1);
}

main().catch((err) => { console.error(C.red(err.message)); process.exit(1); });
