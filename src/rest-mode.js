import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { quietUntil } from './sleep-window.js';

const STATE_PATH = process.env.SEAL_REST_MODE || path.join(os.homedir(), '.config', 'seal', 'rest-mode.json');
const POWER_CACHE_MS = 60_000;

export function decideRest({ now = Date.now(), onBattery = false, quiet = false, manual = null }) {
  if (manual?.mode && manual.until && Date.parse(manual.until) > now) {
    return { resting: manual.mode === 'on', reason: 'manual' };
  }
  if (quiet) return { resting: true, reason: 'madrugada' };
  if (onBattery) return { resting: true, reason: 'bateria' };
  return { resting: false, reason: null };
}

export const parseOnBattery = (pmsetOutput) => /drawing from 'Battery Power'/i.test(String(pmsetOutput || ''));

let power = { at: 0, onBattery: false };

function readPower() {
  if (Date.now() - power.at < POWER_CACHE_MS) return Promise.resolve(power.onBattery);
  return new Promise((resolve) => {
    execFile('pmset', ['-g', 'batt'], { timeout: 3000 }, (err, stdout) => {
      power = { at: Date.now(), onBattery: err ? power.onBattery : parseOnBattery(stdout) };
      resolve(power.onBattery);
    });
  });
}

function readManual() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function setManualRest(mode, hours) {
  const state = { mode, until: new Date(Date.now() + hours * 3_600_000).toISOString() };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  return state;
}

// PR reviews run on battery too (the owner asked for it); the night window and a manual pause still hold.
export async function restState(now = Date.now(), { ignoreBattery = false } = {}) {
  const onBattery = ignoreBattery ? false : await readPower();
  return decideRest({ now, onBattery, quiet: Boolean(quietUntil(new Date(now))), manual: readManual() });
}

export const isPrReviewTask = (taskId) => /^seal_pr_/.test(String(taskId || ''));
