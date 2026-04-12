/**
 * SEAL — cross-process alert sender
 *
 * Fires a single notification to every configured target. Works from
 * both the runner daemon and the dashboard server process because it
 * doesn't depend on a shared bot instance — Telegram goes over raw
 * HTTPS, Discord goes through a webhook URL, macOS goes through
 * osascript directly. All three are fire-and-forget so alert
 * failures never break the caller's happy path.
 *
 * Config lives at ~/.config/seal/alerts.json and is editable via
 * `seal setup alerts` from the CLI. Example:
 *
 *   {
 *     "dashboard_url": "http://localhost:3333",
 *     "macos": true,
 *     "telegram": {
 *       "bot_token": "123:abc",
 *       "chat_id": "987654321"
 *     },
 *     "discord": {
 *       "webhook_url": "https://discord.com/api/webhooks/..."
 *     }
 *   }
 *
 * Design — option A from the "channels/gateway providers" conversation:
 * this is the alerting path that unlocks mobile reach without building
 * the full gateway abstraction. Readers receive a nudge on their phone,
 * tap the embedded dashboard URL, and approve from the responsive web
 * UI. Button-based approval is v0.9.0 and comes later.
 */

import { exec } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SEAL_DIR = process.env.SEAL_DIR || join(process.env.HOME, '.config', 'seal');
const ALERT_CONFIG = join(SEAL_DIR, 'alerts.json');

const DEFAULT_CONFIG = {
  dashboard_url: 'http://localhost:3333',
  macos: true,
  telegram: { bot_token: '', chat_id: '' },
  discord: { webhook_url: '' },
};

export function readAlertConfig() {
  if (!existsSync(ALERT_CONFIG)) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(ALERT_CONFIG, 'utf-8'));
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      telegram: { ...DEFAULT_CONFIG.telegram, ...(parsed.telegram || {}) },
      discord: { ...DEFAULT_CONFIG.discord, ...(parsed.discord || {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeAlertConfig(cfg) {
  mkdirSync(SEAL_DIR, { recursive: true });
  writeFileSync(ALERT_CONFIG, JSON.stringify(cfg, null, 2));
}

/**
 * Fire a single alert to every configured target. Fire-and-forget.
 *
 * @param {object} opts
 * @param {string} opts.kind  short identifier (proposal_drafted, ingest_queued, ...)
 * @param {string} opts.title short headline
 * @param {string} opts.body  one or two lines of detail
 * @param {string} [opts.path] dashboard deep-link path (e.g. "/#proposals")
 *                             appended to dashboard_url. Defaults to "/".
 */
export function sendAlert({ kind, title, body, path = '/' }) {
  const cfg = readAlertConfig();
  const url = deepLink(cfg.dashboard_url, path);

  const summary = buildSummary(title, body, url);

  if (cfg.macos) {
    fireMacOS(title, body).catch(() => {});
  }
  if (cfg.telegram?.bot_token && cfg.telegram?.chat_id) {
    fireTelegram(cfg.telegram, summary).catch((err) => {
      console.warn(`[alert] telegram send failed: ${err.message}`);
    });
  }
  if (cfg.discord?.webhook_url) {
    fireDiscord(cfg.discord.webhook_url, summary).catch((err) => {
      console.warn(`[alert] discord send failed: ${err.message}`);
    });
  }

  console.log(`[alert:${kind}] ${title} — ${url}`);
  return { kind, title, url };
}

// ─── Individual channels ──────────────────────────────

async function fireMacOS(title, body) {
  if (process.platform !== 'darwin') return;
  const t = esc(title);
  const b = esc(body);
  return new Promise((resolve) => {
    exec(
      `osascript -e 'display notification "${b}" with title "SEAL" subtitle "${t}" sound name "Glass"'`,
      () => resolve(),
    );
  });
}

async function fireTelegram({ bot_token, chat_id }, summary) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(bot_token)}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id,
      text: summary,
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`telegram HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function fireDiscord(webhook_url, summary) {
  const res = await fetch(webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: summary }),
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(`discord HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ─── Helpers ──────────────────────────────────────────

function buildSummary(title, body, url) {
  return [
    `🦭 *SEAL* — ${mdEscape(title)}`,
    '',
    mdEscape(body),
    '',
    `👉 ${url}`,
  ].join('\n');
}

function deepLink(base, path) {
  const clean = String(base || 'http://localhost:3333').replace(/\/+$/, '');
  if (!path) return clean + '/';
  return clean + (path.startsWith('/') ? path : '/' + path);
}

function esc(s) {
  return String(s || '').replace(/"/g, '\\"').replace(/'/g, "\\'");
}

function mdEscape(s) {
  // Minimal markdown escape for Telegram's legacy Markdown parser.
  return String(s || '').replace(/([_*`])/g, '\\$1');
}
