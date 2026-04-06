import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'seal');
const CONFIG_PATH = path.join(CONFIG_DIR, 'ingest.json');

const DEFAULTS = {
  email: {
    enabled: false,
    mode: 'gmail',           // 'gmail' (IMAP polling) or 'webhook' (Cloudflare Worker)
    user: '',                // Gmail address (e.g., ulisseshen@gmail.com)
    appPassword: '',         // Gmail App Password (16 chars from myaccount.google.com/apppasswords)
    sealAddress: '',         // Your SEAL email (e.g., seal@hens.com.br)
    pollInterval: 300_000,   // 5 minutes
  },
  whatsapp: {
    enabled: false,  // Baileys — scan QR code on first run
  },
  telegram: {
    enabled: false,
    token: '',             // From @BotFather
    allowedUsers: [],      // Telegram user IDs or @usernames (empty = allow all)
  },
  server: {
    port: 3456,  // Ingest server port (email webhook)
  },
  transcription: {
    enabled: true,
    binary: 'whisper-cli',
    model: path.join(CONFIG_DIR, 'models', 'ggml-small.bin'),
    language: 'pt',
  },
};

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return deepMerge(DEFAULTS, raw);
    }
  } catch (err) {
    console.error(`[config] Failed to load ${CONFIG_PATH}:`, err.message);
  }
  return DEFAULTS;
}

export function saveDefaultConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    console.log(`[config] Created default config at ${CONFIG_PATH}`);
    console.log(`[config] Edit it to enable email/whatsapp ingestion.`);
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

const SECRETS_PATH = path.join(CONFIG_DIR, '.secrets');

/**
 * Read a secret.
 * Resolution order: config value > env var > .secrets file
 *
 * Secrets file: ~/.config/seal/.secrets (chmod 600)
 * Format: {"gmail_app_password": "xxxx xxxx xxxx xxxx"}
 */
let _secrets = null;
function loadSecrets() {
  if (_secrets) return _secrets;
  try {
    if (fs.existsSync(SECRETS_PATH)) {
      _secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
    }
  } catch {}
  return _secrets || {};
}

export function resolveSecret(configValue, envVar, secretKey) {
  // 1. Config points to secrets file
  if (configValue?.startsWith('secret:')) {
    const key = configValue.replace('secret:', '');
    const secrets = loadSecrets();
    if (secrets[key]) return secrets[key];
  }

  // 2. Explicit config value
  if (configValue && configValue !== '') return configValue;

  // 3. Environment variable
  if (envVar && process.env[envVar]) return process.env[envVar];

  // 4. Default secret key
  if (secretKey) {
    const secrets = loadSecrets();
    if (secrets[secretKey]) return secrets[secretKey];
  }

  return null;
}

export { CONFIG_PATH };
