// ========================================
// SEAL Hook Installer — Stream D
// ========================================
//
// Installs / uninstalls SEAL git hooks (post-commit, post-checkout,
// post-merge, pre-push) into a watched repo's .git/hooks/ directory.
//
// Prime Directive #1: every hook the dashboard installs is traceable and
// reversible. Each hook script carries the marker `SEAL-HOOK-MARKER-v1`,
// pre-existing user hooks are backed up to `<hook>.seal.bak`, and the
// uninstall flow restores the original on the way out.
//
// Hooks always `exit 0` — SEAL must NEVER break the user's git workflow.

import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SEAL_HOOK_MARKER = 'SEAL-HOOK-MARKER-v1';
export const SEAL_HOOKS = ['post-commit', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite'];

// ─── Hook script bodies ─────────────────────────────────
//
// All hooks share the same shape: extract repo info, build a JSON payload,
// POST it to the legacy dashboard's observe endpoint, fall back to a JSONL
// queue on disk if the endpoint is unreachable. Stream C (src/web.js) parses
// the payload — keep keys stable.

function commonPrelude(hookType) {
  return `#!/bin/sh
# ${SEAL_HOOK_MARKER} — installed by SEAL, do not edit. Remove via dashboard.
REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
REPO_NAME=$(basename "$REPO_PATH")
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
HOOK_TYPE="${hookType}"
`;
}

function commonPostlude() {
  return `
curl -s -m 2 -X POST http://localhost:3457/api/observe/git \\
  -H "Content-Type: application/json" \\
  -d "$PAYLOAD" > /dev/null 2>&1 || {
    mkdir -p "$HOME/.config/seal/ipc/git"
    echo "$PAYLOAD" >> "$HOME/.config/seal/ipc/git/queue.jsonl"
  }

exit 0
`;
}

function buildPostCommit() {
  return commonPrelude('post-commit') + `
SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
MSG=$(git log -1 --pretty=%B 2>/dev/null | head -c 500 | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr '\\n' ' ')
AUTHOR_NAME=$(git log -1 --pretty=%an 2>/dev/null | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
AUTHOR_EMAIL=$(git log -1 --pretty=%ae 2>/dev/null)

PAYLOAD="{\\"repo_path\\":\\"$REPO_PATH\\",\\"repo_name\\":\\"$REPO_NAME\\",\\"hook\\":\\"$HOOK_TYPE\\",\\"timestamp\\":\\"$TS\\",\\"data\\":{\\"sha\\":\\"$SHA\\",\\"branch\\":\\"$BRANCH\\",\\"message\\":\\"$MSG\\",\\"author_name\\":\\"$AUTHOR_NAME\\",\\"author_email\\":\\"$AUTHOR_EMAIL\\"}}"
` + commonPostlude();
}

function buildPostCheckout() {
  return commonPrelude('post-checkout') + `
PREV_HEAD="$1"
NEW_HEAD="$2"
IS_BRANCH="$3"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

PAYLOAD="{\\"repo_path\\":\\"$REPO_PATH\\",\\"repo_name\\":\\"$REPO_NAME\\",\\"hook\\":\\"$HOOK_TYPE\\",\\"timestamp\\":\\"$TS\\",\\"data\\":{\\"prev_head\\":\\"$PREV_HEAD\\",\\"new_head\\":\\"$NEW_HEAD\\",\\"is_branch\\":\\"$IS_BRANCH\\",\\"branch\\":\\"$BRANCH\\"}}"
` + commonPostlude();
}

function buildPostMerge() {
  return commonPrelude('post-merge') + `
SQUASH="$1"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
MERGE_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")

PAYLOAD="{\\"repo_path\\":\\"$REPO_PATH\\",\\"repo_name\\":\\"$REPO_NAME\\",\\"hook\\":\\"$HOOK_TYPE\\",\\"timestamp\\":\\"$TS\\",\\"data\\":{\\"squash\\":\\"$SQUASH\\",\\"branch\\":\\"$BRANCH\\",\\"merge_head\\":\\"$MERGE_HEAD\\"}}"
` + commonPostlude();
}

function buildPrePush() {
  return commonPrelude('pre-push') + `
REMOTE="$1"
URL="$2"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

PAYLOAD="{\\"repo_path\\":\\"$REPO_PATH\\",\\"repo_name\\":\\"$REPO_NAME\\",\\"hook\\":\\"$HOOK_TYPE\\",\\"timestamp\\":\\"$TS\\",\\"data\\":{\\"remote\\":\\"$REMOTE\\",\\"url\\":\\"$URL\\",\\"branch\\":\\"$BRANCH\\"}}"
` + commonPostlude();
}

function buildPostRewrite() {
  return commonPrelude('post-rewrite') + `
# $1 is either "rebase" or "amend"
REWRITE_KIND="$1"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
# Count rewritten commits from stdin (old-sha new-sha lines)
REWRITE_COUNT=0
while read OLD NEW EXTRA; do
  REWRITE_COUNT=$((REWRITE_COUNT + 1))
done
AUTHOR_NAME=$(git log -1 --pretty=%an 2>/dev/null | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
AUTHOR_EMAIL=$(git log -1 --pretty=%ae 2>/dev/null)

PAYLOAD="{\\"repo_path\\":\\"$REPO_PATH\\",\\"repo_name\\":\\"$REPO_NAME\\",\\"hook\\":\\"$HOOK_TYPE\\",\\"timestamp\\":\\"$TS\\",\\"data\\":{\\"rewrite_kind\\":\\"$REWRITE_KIND\\",\\"branch\\":\\"$BRANCH\\",\\"sha\\":\\"$SHA\\",\\"rewrite_count\\":\\"$REWRITE_COUNT\\",\\"author_name\\":\\"$AUTHOR_NAME\\",\\"author_email\\":\\"$AUTHOR_EMAIL\\"}}"
` + commonPostlude();
}

const HOOK_BUILDERS = {
  'post-commit': buildPostCommit,
  'post-checkout': buildPostCheckout,
  'post-merge': buildPostMerge,
  'pre-push': buildPrePush,
  'post-rewrite': buildPostRewrite,
};

// ─── Helpers ────────────────────────────────────────────

function hooksDir(repoPath) {
  return join(repoPath, '.git', 'hooks');
}

function hookPath(repoPath, hook) {
  return join(hooksDir(repoPath), hook);
}

function backupPath(repoPath, hook) {
  return join(hooksDir(repoPath), `${hook}.seal.bak`);
}

function fileContainsMarker(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.includes(SEAL_HOOK_MARKER);
  } catch {
    return false;
  }
}

// ─── Public API ─────────────────────────────────────────

/**
 * Returns true if the repo's post-commit hook contains the SEAL marker.
 * Cheap probe used by the dashboard list view.
 */
export function hasSealHooks(repoPath) {
  if (!repoPath) return false;
  const pc = hookPath(repoPath, 'post-commit');
  return existsSync(pc) && fileContainsMarker(pc);
}

/**
 * Install all SEAL hooks into the given repo.
 * - Backs up any pre-existing non-SEAL hook to <hook>.seal.bak
 * - Overwrites in place if the existing hook already carries the marker
 * - chmod +x every installed hook
 *
 * Returns { installed: [...], errors: [{ hook, message }] }.
 * Throws only if .git/hooks itself can't be created (i.e. not a git repo).
 */
export function installSealHooks(repoPath) {
  if (!repoPath) throw new Error('installSealHooks: repoPath is required');
  const dir = hooksDir(repoPath);
  if (!existsSync(join(repoPath, '.git'))) {
    throw new Error(`installSealHooks: not a git repo (no .git at ${repoPath})`);
  }
  // Some bare-ish setups may have .git as a file (worktrees) — be defensive.
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`installSealHooks: cannot create hooks dir at ${dir} — ${err.message}`);
  }

  const installed = [];
  const errors = [];

  for (const hook of SEAL_HOOKS) {
    try {
      const target = hookPath(repoPath, hook);
      const backup = backupPath(repoPath, hook);

      if (existsSync(target)) {
        if (fileContainsMarker(target)) {
          // SEAL-managed: overwrite in place (upgrade path).
        } else if (!existsSync(backup)) {
          // User-owned: back it up before clobbering.
          renameSync(target, backup);
        }
        // If both target and backup exist and target isn't ours, the original
        // backup is preserved — the leftover target is overwritten below.
      }

      const body = HOOK_BUILDERS[hook]();
      writeFileSync(target, body, { mode: 0o755 });
      try { chmodSync(target, 0o755); } catch { /* mode set on write */ }
      installed.push(hook);
    } catch (err) {
      errors.push({ hook, message: err.message });
    }
  }

  return { installed, errors };
}

/**
 * Uninstall SEAL hooks from the given repo.
 * - Deletes any hook that contains the SEAL marker
 * - Restores `<hook>.seal.bak` (if present) back to `<hook>`
 *
 * Returns { removed: [...], restored: [...], errors: [...] }.
 * Best-effort: silently skips repos with no .git directory.
 */
export function uninstallSealHooks(repoPath) {
  if (!repoPath) throw new Error('uninstallSealHooks: repoPath is required');
  const removed = [];
  const restored = [];
  const errors = [];

  if (!existsSync(hooksDir(repoPath))) {
    return { removed, restored, errors };
  }

  for (const hook of SEAL_HOOKS) {
    const target = hookPath(repoPath, hook);
    const backup = backupPath(repoPath, hook);

    try {
      if (existsSync(target) && fileContainsMarker(target)) {
        unlinkSync(target);
        removed.push(hook);
      }
      if (existsSync(backup)) {
        // Restore the user's original. If `target` somehow still exists
        // (non-SEAL file), don't clobber it — the marker check above already
        // confirmed it's not ours, so just leave both in place.
        if (!existsSync(target)) {
          renameSync(backup, target);
          restored.push(hook);
        }
      }
    } catch (err) {
      errors.push({ hook, message: err.message });
    }
  }

  return { removed, restored, errors };
}
