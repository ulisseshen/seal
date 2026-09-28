// Graceful restart: whoever wants the runner restarted (a deploy, Claude after a code change) writes this file
// instead of killing the process. The runner stops starting new tasks, waits for the running ones and any
// review being published to finish, then asks launchd to restart it.
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const RESTART_REQUEST_FILE = path.join(os.homedir(), '.config', 'seal', 'run', 'restart.request');
export const SERVICE_LABEL = process.env.SEAL_LAUNCHD_LABEL || 'com.ulisseshen.seal';

export function requestRestart(reason = 'pedido manual', now = new Date()) {
  fs.mkdirSync(path.dirname(RESTART_REQUEST_FILE), { recursive: true });
  fs.writeFileSync(RESTART_REQUEST_FILE, JSON.stringify({ reason, at: now.toISOString() }));
}

export function pendingRestart() {
  try {
    return JSON.parse(fs.readFileSync(RESTART_REQUEST_FILE, 'utf8'));
  } catch (err) {
    return err.code === 'ENOENT' ? null : { reason: 'pedido ilegível', at: null };
  }
}

export const readyToRestart = ({ runningTasks, publishingReviews }) => runningTasks === 0 && publishingReviews === 0;

export function restartNow(request) {
  try { fs.unlinkSync(RESTART_REQUEST_FILE); } catch {}
  console.log(`[seal:restart] reiniciando sem tarefa rodando (${request?.reason || 'sem motivo'})`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  // launchctl kills this process and starts a fresh one; detached so the kill does not take the child with it.
  const child = execFile('launchctl', ['kickstart', '-k', `gui/${uid}/${SERVICE_LABEL}`], { detached: true }, (err) => {
    if (err) console.error(`[seal:restart] launchctl falhou: ${err.message}`);
  });
  child.unref();
}
