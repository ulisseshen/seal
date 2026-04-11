// Stream D — hooks-installer tests for v0.3.0 "Eye" layer.
//
// Spins up a real (empty) git repo in os.tmpdir(), exercises install /
// uninstall, then asserts file existence, mode, marker presence, and the
// backup-restore round-trip.
//
// All file operations stay inside a single tmp dir per test run; we clean
// it up best-effort in test.after().

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

import {
  installSealHooks,
  uninstallSealHooks,
  hasSealHooks,
  SEAL_HOOKS,
  SEAL_HOOK_MARKER,
} from '../dashboard/hooks-installer.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-hooks-test-'));

function makeRepo(name) {
  const repoPath = path.join(TMP_ROOT, name);
  fs.mkdirSync(repoPath, { recursive: true });
  execSync('git init -q', { cwd: repoPath });
  return repoPath;
}

function readHook(repoPath, hook) {
  return fs.readFileSync(path.join(repoPath, '.git', 'hooks', hook), 'utf-8');
}

function hookExists(repoPath, hook) {
  return fs.existsSync(path.join(repoPath, '.git', 'hooks', hook));
}

function backupExists(repoPath, hook) {
  return fs.existsSync(path.join(repoPath, '.git', 'hooks', `${hook}.seal.bak`));
}

test.after(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

test('installSealHooks: writes all four hooks with marker and exec mode', () => {
  const repo = makeRepo('install-basic');

  const result = installSealHooks(repo);

  assert.deepEqual(
    result.installed.sort(),
    [...SEAL_HOOKS].sort(),
    'should install all four hooks',
  );
  assert.deepEqual(result.errors, [], 'should report no errors');

  for (const hook of SEAL_HOOKS) {
    assert.ok(hookExists(repo, hook), `${hook} should exist`);
    const content = readHook(repo, hook);
    assert.ok(content.includes(SEAL_HOOK_MARKER), `${hook} should contain marker`);
    assert.ok(content.includes('exit 0'), `${hook} should always exit 0`);
    assert.ok(content.includes('curl -s -m 2'), `${hook} should POST observation`);

    const stat = fs.statSync(path.join(repo, '.git', 'hooks', hook));
    assert.ok((stat.mode & 0o111) !== 0, `${hook} should be executable`);
  }
});

test('hasSealHooks: returns true after install, false on a fresh repo', () => {
  const fresh = makeRepo('has-seal-fresh');
  assert.equal(hasSealHooks(fresh), false);

  const installed = makeRepo('has-seal-installed');
  installSealHooks(installed);
  assert.equal(hasSealHooks(installed), true);
});

test('installSealHooks: backs up a pre-existing user post-commit hook', () => {
  const repo = makeRepo('backup-existing');
  const userHookPath = path.join(repo, '.git', 'hooks', 'post-commit');
  const userHookBody = '#!/bin/sh\necho "user-original-post-commit"\nexit 0\n';
  fs.writeFileSync(userHookPath, userHookBody, { mode: 0o755 });

  installSealHooks(repo);

  // Backup must exist with the original body.
  assert.ok(backupExists(repo, 'post-commit'), 'backup file should exist');
  const backed = fs.readFileSync(
    path.join(repo, '.git', 'hooks', 'post-commit.seal.bak'),
    'utf-8',
  );
  assert.equal(backed, userHookBody, 'backup should preserve original content');

  // Active hook must now be SEAL's.
  const active = readHook(repo, 'post-commit');
  assert.ok(active.includes(SEAL_HOOK_MARKER));
  assert.ok(!active.includes('user-original-post-commit'));
});

test('installSealHooks: re-installing a SEAL-managed hook overwrites in place (no backup)', () => {
  const repo = makeRepo('upgrade-in-place');
  installSealHooks(repo);
  // Mutate the SEAL hook to simulate a previous version.
  const target = path.join(repo, '.git', 'hooks', 'post-commit');
  const before = fs.readFileSync(target, 'utf-8');
  fs.writeFileSync(target, before + '\n# OLD VERSION TAG\n');

  // Re-install — should NOT create a backup, should overwrite.
  installSealHooks(repo);

  assert.equal(
    backupExists(repo, 'post-commit'),
    false,
    'no backup should be created when overwriting our own hook',
  );
  const after = fs.readFileSync(target, 'utf-8');
  assert.ok(after.includes(SEAL_HOOK_MARKER));
  assert.ok(!after.includes('OLD VERSION TAG'));
});

test('uninstallSealHooks: removes SEAL hooks and restores backups', () => {
  const repo = makeRepo('uninstall-restore');
  // Plant a user hook on post-checkout BEFORE installing.
  const userBody = '#!/bin/sh\necho "user-post-checkout"\nexit 0\n';
  fs.writeFileSync(
    path.join(repo, '.git', 'hooks', 'post-checkout'),
    userBody,
    { mode: 0o755 },
  );

  installSealHooks(repo);
  assert.ok(backupExists(repo, 'post-checkout'));
  assert.equal(hasSealHooks(repo), true);

  const result = uninstallSealHooks(repo);

  // All four SEAL hooks should be removed (post-checkout gets restored, but
  // it was a SEAL file at the moment of removal — it's listed in `removed`).
  assert.deepEqual(result.removed.sort(), [...SEAL_HOOKS].sort());
  assert.deepEqual(result.restored, ['post-checkout']);
  assert.deepEqual(result.errors, []);

  // post-commit should be gone (it had no backup).
  assert.equal(hookExists(repo, 'post-commit'), false);
  // post-checkout should be back to the user version.
  assert.ok(hookExists(repo, 'post-checkout'));
  const restored = readHook(repo, 'post-checkout');
  assert.equal(restored, userBody);
  // The .seal.bak file should be gone (consumed by the rename).
  assert.equal(backupExists(repo, 'post-checkout'), false);

  assert.equal(hasSealHooks(repo), false);
});

test('installSealHooks: throws when given a non-git directory', () => {
  const notRepo = path.join(TMP_ROOT, 'not-a-repo');
  fs.mkdirSync(notRepo, { recursive: true });
  assert.throws(
    () => installSealHooks(notRepo),
    /not a git repo/i,
  );
});

test('uninstallSealHooks: no-op on a directory with no .git/hooks', () => {
  const empty = path.join(TMP_ROOT, 'no-hooks');
  fs.mkdirSync(empty, { recursive: true });
  const result = uninstallSealHooks(empty);
  assert.deepEqual(result, { removed: [], restored: [], errors: [] });
});

test('hook payload contract: stable JSON shape per hook type', () => {
  const repo = makeRepo('payload-contract');
  installSealHooks(repo);

  // The hook bodies wrap the JSON payload in a shell-quoted string, so the
  // actual file contains escaped quotes — e.g. \"sha\":\"$SHA\". We assert on
  // the escaped form, which is what the runtime shell will see.
  const pc = readHook(repo, 'post-commit');
  assert.ok(pc.includes('HOOK_TYPE="post-commit"'));
  assert.ok(pc.includes('\\"sha\\":'));
  assert.ok(pc.includes('\\"branch\\":'));
  assert.ok(pc.includes('\\"message\\":'));
  assert.ok(pc.includes('\\"repo_path\\":'));
  assert.ok(pc.includes('\\"hook\\":'));
  assert.ok(pc.includes('\\"timestamp\\":'));
  assert.ok(pc.includes('\\"data\\":'));

  const co = readHook(repo, 'post-checkout');
  assert.ok(co.includes('HOOK_TYPE="post-checkout"'));
  assert.ok(co.includes('\\"prev_head\\":'));
  assert.ok(co.includes('\\"new_head\\":'));
  assert.ok(co.includes('\\"is_branch\\":'));
  assert.ok(co.includes('PREV_HEAD="$1"'));
  assert.ok(co.includes('NEW_HEAD="$2"'));

  const pm = readHook(repo, 'post-merge');
  assert.ok(pm.includes('HOOK_TYPE="post-merge"'));
  assert.ok(pm.includes('\\"squash\\":'));
  assert.ok(pm.includes('\\"merge_head\\":'));
  assert.ok(pm.includes('SQUASH="$1"'));

  const pp = readHook(repo, 'pre-push');
  assert.ok(pp.includes('HOOK_TYPE="pre-push"'));
  assert.ok(pp.includes('\\"remote\\":'));
  assert.ok(pp.includes('\\"url\\":'));
  assert.ok(pp.includes('REMOTE="$1"'));
  assert.ok(pp.includes('URL="$2"'));
});
