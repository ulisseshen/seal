#!/usr/bin/env node
// SEAL setup CLI
// Usage:
//   seal setup                              interactive menu
//   seal setup status                       show configured providers/channels
//   seal setup provider <name>              interactive token prompt
//   seal setup provider <name> --token X [--model Y] [--default]
//   seal setup provider codex --login       delegate to `codex login`
//   seal setup provider <name> --remove
//   seal setup channel <name>               interactive
//   seal setup channel <name> --set key=value [key=value ...]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline';
import { setSecret, getSecret, delSecret, hasSecret, backend } from './secrets.js';

const SEAL_DIR = process.env.SEAL_DIR || join(process.env.HOME, '.config', 'seal');
const CHAT_CONFIG = join(SEAL_DIR, 'chat-config.json');
const CHANNELS_CONFIG = join(SEAL_DIR, 'channels.json');

const PROVIDERS = {
  claude:  { label: 'Claude (via claude CLI)',      defaultModel: 'claude-opus-4-6',     authMode: 'cli-managed' },
  codex:   { label: 'Codex (via codex CLI)',        defaultModel: 'gpt-5',               authMode: 'cli-managed' },
  gemini:  { label: 'Gemini (Google AI Studio key)', defaultModel: 'gemini-2.5-pro',      authMode: 'token' },
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
    } else {
      console.log(C.yellow(`${name} auth is managed by its CLI. Run \`${name} logout\` to sign out.`));
    }
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
    console.log(C.cyan(`→ Delegating to \`${name} login\`...`));
    const r = spawnSync(name, ['login'], { stdio: 'inherit' });
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
${C.bold('SEAL setup')}

  seal setup                             interactive menu
  seal setup status                      show configured providers/channels
  seal setup provider <name>             interactive token / select default
  seal setup provider <name> --token X [--model Y]
  seal setup provider codex --login      delegate to \`codex login\`
  seal setup provider <name> --remove
  seal setup channel <name> --set key=value
  seal setup channel <name> --disable

${C.dim('Providers: claude, codex, gemini')}
`);
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
    if (sub === 'help' || sub === '-h' || sub === '--help') return help();
    console.error(C.red(`Unknown setup command: ${sub}`));
    help();
    process.exit(1);
  }

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') { help(); return; }

  console.error(C.red(`Unknown command: ${cmd}`));
  help();
  process.exit(1);
}

main().catch((err) => { console.error(C.red(err.message)); process.exit(1); });
