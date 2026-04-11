// SEAL secret store
// macOS: Keychain via `security` CLI.
// Linux/other: ~/.config/seal/secrets.json with chmod 600 (fallback, not encrypted).
//
// Never write secrets into chat-config.json or any other world-readable file.

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { platform } from 'os';

const SERVICE = 'seal';
const SEAL_DIR = process.env.SEAL_DIR || join(process.env.HOME, '.config', 'seal');
const FALLBACK_PATH = join(SEAL_DIR, 'secrets.json');

const USE_KEYCHAIN = platform() === 'darwin' && !process.env.SEAL_SECRETS_FILE;

function account(provider, key) {
  return `${provider}:${key}`;
}

// --- Keychain backend (macOS) ---

function keychainSet(provider, key, value) {
  // -U updates if it already exists
  const r = spawnSync('security', [
    'add-generic-password',
    '-s', SERVICE,
    '-a', account(provider, key),
    '-w', value,
    '-U',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) {
    throw new Error(`Keychain write failed: ${r.stderr?.toString() || 'unknown'}`);
  }
}

function keychainGet(provider, key) {
  const r = spawnSync('security', [
    'find-generic-password',
    '-s', SERVICE,
    '-a', account(provider, key),
    '-w',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return null;
  return r.stdout.toString().replace(/\n$/, '');
}

function keychainDel(provider, key) {
  const r = spawnSync('security', [
    'delete-generic-password',
    '-s', SERVICE,
    '-a', account(provider, key),
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  return r.status === 0;
}

// --- File backend (fallback) ---

function fileRead() {
  if (!existsSync(FALLBACK_PATH)) return {};
  try { return JSON.parse(readFileSync(FALLBACK_PATH, 'utf-8')); }
  catch { return {}; }
}

function fileWrite(obj) {
  mkdirSync(dirname(FALLBACK_PATH), { recursive: true });
  writeFileSync(FALLBACK_PATH, JSON.stringify(obj, null, 2));
  try { chmodSync(FALLBACK_PATH, 0o600); } catch {}
}

function fileSet(provider, key, value) {
  const data = fileRead();
  data[account(provider, key)] = value;
  fileWrite(data);
}

function fileGet(provider, key) {
  const data = fileRead();
  return data[account(provider, key)] ?? null;
}

function fileDel(provider, key) {
  const data = fileRead();
  if (!(account(provider, key) in data)) return false;
  delete data[account(provider, key)];
  fileWrite(data);
  return true;
}

// --- Public API ---

export function setSecret(provider, key, value) {
  if (USE_KEYCHAIN) keychainSet(provider, key, value);
  else fileSet(provider, key, value);
}

export function getSecret(provider, key) {
  if (USE_KEYCHAIN) return keychainGet(provider, key);
  return fileGet(provider, key);
}

export function delSecret(provider, key) {
  if (USE_KEYCHAIN) return keychainDel(provider, key);
  return fileDel(provider, key);
}

export function hasSecret(provider, key) {
  return getSecret(provider, key) !== null;
}

export function backend() {
  return USE_KEYCHAIN ? 'keychain' : 'file';
}

export function fallbackPath() {
  return FALLBACK_PATH;
}
