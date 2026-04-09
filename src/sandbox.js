import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'seal');
const PROFILE_DIR = path.join(CONFIG_DIR, 'profiles');

// ─── Default profiles ───────────────────────────────────
// These are Apple sandbox-exec S-expression profiles. They're written to
// ~/.config/seal/profiles/ on startup (idempotent) so users can edit them.

const READONLY_PROFILE = `(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow iokit-open)
(allow ipc-posix-shm)

; Read everywhere
(allow file-read*)

; Write only under /tmp/seal-scratch and standard temp/log spots
(allow file-write*
  (subpath "/tmp/seal-scratch")
  (subpath "/private/tmp/seal-scratch")
  (subpath "/private/var/folders")
  (subpath "/tmp")
  (subpath "/private/tmp"))

; Network: allow DNS + outbound reads (no server binds)
(allow network-outbound)
(allow network-bind (local ip "localhost:*"))
(allow system-socket)
`;

const PROJECT_WRITE_PROFILE = `(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow iokit-open)
(allow ipc-posix-shm)

; Read everywhere
(allow file-read*)

; Write under /tmp/seal-scratch, temp folders, AND the project root (set via env)
(allow file-write*
  (subpath "/tmp/seal-scratch")
  (subpath "/private/tmp/seal-scratch")
  (subpath "/private/var/folders")
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath (param "SEAL_PROJECT_ROOT"))
  (subpath (string-append (param "HOME") "/.config/seal"))
  (subpath (string-append (param "HOME") "/.claude")))

; Deny sensitive dirs even if they fall under a project root
(deny file-write*
  (subpath (string-append (param "HOME") "/.ssh"))
  (subpath (string-append (param "HOME") "/.aws"))
  (subpath (string-append (param "HOME") "/.gnupg")))

(allow network*)
`;

const SHELL_ALLOWLISTED_PROFILE = `(version 1)
(deny default)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow iokit-open)
(allow ipc-posix-shm)

; Read everywhere
(allow file-read*)

; Only exec binaries in allowlisted locations
(allow process-exec
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/usr/bin")
  (subpath "/usr/sbin")
  (subpath "/usr/local/bin")
  (subpath "/opt/homebrew/bin")
  (subpath "/opt/homebrew/opt")
  (subpath (string-append (param "HOME") "/.openenglish"))
  (subpath (string-append (param "HOME") "/.local/bin/seal-allowed"))
  (subpath (string-append (param "HOME") "/.claude"))
  (subpath (string-append (param "HOME") "/.nvm"))
  (subpath (string-append (param "HOME") "/.volta")))

; Write under scratch + openenglish home (for state files)
(allow file-write*
  (subpath "/tmp/seal-scratch")
  (subpath "/private/tmp/seal-scratch")
  (subpath "/private/var/folders")
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath (string-append (param "HOME") "/.openenglish"))
  (subpath (string-append (param "HOME") "/.config/seal")))

(allow network*)
`;

const DEFAULT_PROFILES = {
  'readonly.sb': READONLY_PROFILE,
  'project-write.sb': PROJECT_WRITE_PROFILE,
  'shell-allowlisted.sb': SHELL_ALLOWLISTED_PROFILE,
};

/**
 * Ensure default sandbox profiles exist on disk. Idempotent.
 * Returns the profile dir.
 */
export function ensureDefaultProfiles() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  for (const [name, body] of Object.entries(DEFAULT_PROFILES)) {
    const p = path.join(PROFILE_DIR, name);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, body);
      console.log(`[sandbox] Wrote default profile ${p}`);
    }
  }
  return PROFILE_DIR;
}

/**
 * Resolve a profile name to a file path, falling back to readonly.sb if missing.
 * Returns null if sandbox-exec isn't available (non-mac).
 */
export function resolveProfile(profileName) {
  if (process.platform !== 'darwin') return null;
  ensureDefaultProfiles();
  const name = profileName && profileName.endsWith('.sb') ? profileName : `${profileName || 'readonly'}.sb`;
  const full = path.join(PROFILE_DIR, name);
  if (fs.existsSync(full)) return full;
  const fallback = path.join(PROFILE_DIR, 'readonly.sb');
  console.warn(`[sandbox] Profile ${name} not found, falling back to readonly.sb`);
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * Wrap a command argv list with sandbox-exec using the given profile name.
 * Returns a new object: { command, args } ready for spawn().
 * On non-darwin platforms, returns the original command unchanged.
 *
 * @param {string} command - binary to run (e.g. 'claude')
 * @param {string[]} args - args for that binary
 * @param {string} profileName - e.g. 'readonly', 'project-write', 'shell-allowlisted'
 * @param {object} params - sandbox profile (param "KEY") bindings via -D KEY=VALUE
 */
export function wrapWithSandbox(command, args, profileName, params = {}) {
  // null profileName = explicit opt-out (e.g. bypassPermissions) — skip sandbox entirely.
  if (profileName === null || profileName === undefined) {
    return { command, args, profile: null };
  }
  const profilePath = resolveProfile(profileName);
  if (!profilePath) {
    return { command, args, profile: null };
  }
  // sandbox-exec -D KEY=VALUE... -f <profile> <command> <args...>
  const defs = [];
  for (const [k, v] of Object.entries(params)) {
    if (v != null) defs.push('-D', `${k}=${v}`);
  }
  const wrapped = [...defs, '-f', profilePath, command, ...args];
  return { command: 'sandbox-exec', args: wrapped, profile: profilePath };
}

/**
 * Map a task's permission_mode to a sandbox profile name.
 *   plan             → readonly
 *   auto (default)   → project-write
 *   delegated        → shell-allowlisted
 *   shell-allowlisted → shell-allowlisted
 *   readonly         → readonly
 *   project-write    → project-write
 */
export function profileForPermissionMode(mode) {
  switch (mode) {
    case 'bypassPermissions':
      return null; // No sandbox — task explicitly opted out of all restrictions
    case 'plan':
    case 'readonly':
      return 'readonly';
    case 'delegated':
    case 'shell-allowlisted':
      return 'shell-allowlisted';
    case 'project-write':
      return 'project-write';
    case 'auto':
    default:
      return 'project-write';
  }
}

export { PROFILE_DIR };
