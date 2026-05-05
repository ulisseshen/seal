import { execSync, exec, execFileSync } from 'child_process';
import { existsSync } from 'fs';

/**
 * Notification system with 5 levels:
 * silent    → just log
 * sound     → macOS notification + sound
 * sticky    → notification stays in Notification Center
 * nuclear   → alert dialog + voice + Telegram
 * supernova → nuclear + re-fires every 5 min until acknowledged
 */

const DASHBOARD_URL = process.env.SEAL_DASHBOARD_URL || 'http://localhost:3457';

// Resolve terminal-notifier once at startup. Allows clickable notifications
// that open the SEAL dashboard. Falls back to osascript if not installed.
const TERMINAL_NOTIFIER = (() => {
  for (const candidate of ['/usr/local/bin/terminal-notifier', '/opt/homebrew/bin/terminal-notifier']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
})();

export function notify(task, level = 'sound') {
  const title = `TL Runner [${task.priority}]`;
  const message = task.summary;

  console.log(`[notify:${level}] ${message}`);

  switch (level) {
    case 'silent':
      break;

    case 'sound':
      notifySound(title, message);
      break;

    case 'sticky':
      notifySticky(title, message);
      break;

    case 'nuclear':
      notifyNuclear(title, message);
      break;

    case 'supernova':
      notifyNuclear(title, message);
      break;
  }
}

function notifySound(title, message) {
  if (TERMINAL_NOTIFIER) {
    // Clickable notification — opens SEAL dashboard on click.
    try {
      execFileSync(TERMINAL_NOTIFIER, [
        '-title', title,
        '-message', message,
        '-sound', 'Glass',
        '-open', DASHBOARD_URL,
        '-group', 'seal-runner',
      ], { stdio: 'ignore' });
      return;
    } catch {}
  }
  // Fallback: osascript (not clickable but always works)
  try {
    execSync(`osascript -e 'display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"'`);
  } catch {}
}

function notifySticky(title, message) {
  if (TERMINAL_NOTIFIER) {
    try {
      execFileSync(TERMINAL_NOTIFIER, [
        '-title', title,
        '-message', message,
        '-sound', 'Submarine',
        '-open', DASHBOARD_URL,
        '-group', 'seal-runner',
      ], { stdio: 'ignore' });
      process.stdout.write('\x07');
      return;
    } catch {}
  }
  try {
    execSync(`osascript -e 'display notification "${esc(message)}" with title "${esc(title)}" sound name "Submarine"'`);
    process.stdout.write('\x07');
  } catch {}
}

function notifyNuclear(title, message) {
  // 1. Sound notification
  notifySound(title, message);

  // 2. Voice announcement (async, don't block)
  exec(`say "Attention. Tech Lead reminder. ${esc(message)}"`);

  // 3. Critical alert dialog (BLOCKS until clicked)
  try {
    execSync(`osascript -e 'display alert "${esc(title)}" message "${esc(message)}" as critical'`, {
      timeout: 300000, // 5 min timeout in case user is away
    });
  } catch {
    // Timeout or error — that's OK
  }

  // 4. Terminal bell
  process.stdout.write('\x07');
}

function esc(str) {
  return str.replace(/"/g, '\\"').replace(/'/g, "\\'");
}
