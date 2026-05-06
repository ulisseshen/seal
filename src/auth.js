/**
 * Claude CLI authentication check.
 *
 * Detects whether the local `claude` CLI is logged in. When the session
 * expires, `claude -p ...` exits with a non-zero code and an auth-ish
 * stderr — the rest of SEAL doesn't know to stop retrying, so reviews
 * fail in a loop until the user runs `/login`.
 *
 * This module:
 *   1. Spawns a minimal `claude --print --max-turns 1 "ping"` to probe.
 *   2. Caches the result for AUTH_CACHE_TTL_MS to avoid hammering the CLI
 *      on every task / sensor tick.
 *   3. Exports a sentinel error message that the rest of SEAL recognises
 *      via `isLoginExpiredResult()`.
 */
import { spawn } from 'child_process';
import { getClaudeBin } from './claude-bin.js';

export const LOGIN_EXPIRED_RESULT =
  'Claude CLI login expired — run /login to resume';

const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const AUTH_PROBE_TIMEOUT_MS = 30_000;

let cache = { ok: null, reason: null, checkedAt: 0 };

/**
 * Run a tiny `claude --print` to verify the CLI is authenticated.
 * Returns { ok, reason } where reason is filled when ok === false.
 *
 * Uses an in-memory cache so back-to-back ticks don't each spawn a CLI.
 * Pass { force: true } to bypass the cache.
 */
export async function checkClaudeAuth({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.ok !== null && now - cache.checkedAt < AUTH_CACHE_TTL_MS) {
    return { ok: cache.ok, reason: cache.reason, cached: true };
  }

  const result = await probeClaudeAuth();
  cache = { ok: result.ok, reason: result.reason, checkedAt: Date.now() };
  return { ...result, cached: false };
}

/**
 * Force the next checkClaudeAuth() call to re-probe (e.g. after the user
 * runs /login). Cheap enough to call from anywhere.
 */
export function invalidateAuthCache() {
  cache = { ok: null, reason: null, checkedAt: 0 };
}

/**
 * Detect whether a stored task result was produced by the auth gate.
 * Used by recovery loops to skip / unblock tasks correctly.
 */
export function isLoginExpiredResult(result) {
  if (!result) return false;
  return String(result).toLowerCase().includes('login expired');
}

// ─── Internal ──────────────────────────────────────────

function probeClaudeAuth() {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let proc;
    try {
      proc = spawn(
        getClaudeBin(),
        ['--print', '--max-turns', '1', '--output-format', 'text', 'ping'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err) {
      return finish({ ok: false, reason: `spawn error: ${err.message}` });
    }

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      finish({ ok: false, reason: 'auth probe timeout' });
    }, AUTH_PROBE_TIMEOUT_MS);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, reason: `spawn error: ${err.message}` });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const out = (stdout + '\n' + stderr).toLowerCase();
      if (code === 0 && stdout.trim().length > 0) {
        return finish({ ok: true, reason: null });
      }
      // Heuristic: known auth-error markers
      const authMarkers = [
        'invalid api key',
        'authentication',
        'unauthor',
        '/login',
        'log in',
        'logged in',
        'session expired',
        'expired',
        'not authenticated',
        'please login',
        'oauth',
      ];
      const looksLikeAuth = authMarkers.some((m) => out.includes(m));
      const reason = looksLikeAuth
        ? `auth failure (exit ${code})`
        : `claude probe failed (exit ${code})`;
      finish({ ok: false, reason });
    });
  });
}
