/**
 * Resolves the absolute path to the `claude` binary on the user's machine.
 *
 * Why: spawning the bare command `claude` picks up whatever is first on PATH,
 * which can vary between shells and environments. By resolving the absolute
 * path once at startup we ensure all SEAL components (executor, auth probe)
 * use the same Claude CLI version that the user sees in their interactive
 * terminal.
 *
 * Resolution order:
 *   1. SEAL_CLAUDE_BIN env var (explicit override)
 *   2. `which claude` on the user's login shell PATH
 *   3. Fallback to `claude` (let spawn resolve via PATH)
 */

import { execSync } from 'child_process';

let cached = null;

export function getClaudeBin() {
  if (cached) return cached;

  if (process.env.SEAL_CLAUDE_BIN) {
    cached = process.env.SEAL_CLAUDE_BIN;
    console.log(`[seal:claude-bin] Using override from SEAL_CLAUDE_BIN: ${cached}`);
    return cached;
  }

  try {
    // Use the user's login shell to inherit their full PATH (the daemon may
    // have a stripped-down env when launched from launchd or similar).
    const path = execSync('which claude', {
      encoding: 'utf8',
      shell: process.env.SHELL || '/bin/zsh',
    }).trim();
    if (path) {
      cached = path;
      console.log(`[seal:claude-bin] Resolved: ${cached}`);
      return cached;
    }
  } catch {
    // ignore — fall through to default
  }

  cached = 'claude';
  console.warn('[seal:claude-bin] Could not resolve absolute path, using bare "claude" (may pick wrong version)');
  return cached;
}
