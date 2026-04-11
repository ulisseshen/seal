// Stream A — db sanity tests for v0.3.0 events + watched_repos.
//
// Hard requirement: isolate from the real ~/.config/seal/tasks.db.
// We point SEAL_DB_PATH at a temp file BEFORE importing src/db.js,
// because src/db.js runs schema creation at import time (top-level await).

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DB = path.join(
  os.tmpdir(),
  `seal-test-${process.pid}-${Date.now()}.db`
);
process.env.SEAL_DB_PATH = TMP_DB;

// Dynamic import so the env var is set before src/db.js runs.
const db = await import('../src/db.js');
const {
  insertEvent,
  queryEvents,
  addWatchedRepo,
  removeWatchedRepo,
  listWatchedRepos,
  getWatchedRepoByPath,
} = db;

test.after(() => {
  // Best-effort cleanup of the temp DB and WAL sidecars.
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
});

test('events: insert + query round-trip with filters and ordering', async () => {
  const t1 = '2026-04-10T10:00:00.000Z';
  const t2 = '2026-04-10T11:00:00.000Z';
  const t3 = '2026-04-10T12:00:00.000Z';

  const id1 = await insertEvent({
    source: 'git',
    kind: 'git.commit',
    timestamp: t1,
    data: { sha: 'abc123', author: 'ulisses', files: 3 },
  });
  const id2 = await insertEvent({
    source: 'git',
    kind: 'git.branch.created',
    timestamp: t2,
    data: { branch: 'feat/eye-layer' },
  });
  const id3 = await insertEvent({
    source: 'calendar',
    kind: 'calendar.event.upcoming',
    timestamp: t3,
    data: { title: 'standup', minutes_until: 5 },
  });

  assert.ok(id1, 'insertEvent should return an id');
  assert.ok(id2);
  assert.ok(id3);

  // Unfiltered query → all 3, DESC by timestamp.
  const all = await queryEvents();
  assert.equal(all.length, 3);
  assert.equal(all[0].timestamp, t3);
  assert.equal(all[1].timestamp, t2);
  assert.equal(all[2].timestamp, t1);

  // data must round-trip as a parsed object.
  const commit = all.find(e => e.kind === 'git.commit');
  assert.equal(typeof commit.data, 'object');
  assert.equal(commit.data.sha, 'abc123');
  assert.equal(commit.data.files, 3);

  // Filter by source.
  const gitOnly = await queryEvents({ source: 'git' });
  assert.equal(gitOnly.length, 2);
  assert.ok(gitOnly.every(e => e.source === 'git'));

  // Filter by kind.
  const branches = await queryEvents({ kind: 'git.branch.created' });
  assert.equal(branches.length, 1);
  assert.equal(branches[0].data.branch, 'feat/eye-layer');

  // Filter by since (exclusive of t1).
  const since = await queryEvents({ since: '2026-04-10T10:30:00.000Z' });
  assert.equal(since.length, 2);

  // Filter by until.
  const until = await queryEvents({ until: '2026-04-10T11:30:00.000Z' });
  assert.equal(until.length, 2);

  // Limit clamping (max 1000).
  const clamped = await queryEvents({ limit: 99999 });
  assert.ok(clamped.length <= 1000);

  // Limit clamping (min 1).
  const oneShot = await queryEvents({ limit: 1 });
  assert.equal(oneShot.length, 1);
  assert.equal(oneShot[0].timestamp, t3); // newest first
});

test('events: insertEvent is fire-and-forget — never throws on bad input', async () => {
  // Circular reference → JSON.stringify throws → must return null, not bubble.
  const circular = {};
  circular.self = circular;

  let result;
  await assert.doesNotReject(async () => {
    result = await insertEvent({
      source: 'shell',
      kind: 'shell.command',
      data: circular,
    });
  });
  assert.equal(result, null, 'circular data should resolve to null, not throw');

  // Missing required fields → null.
  const missing = await insertEvent({ data: { x: 1 } });
  assert.equal(missing, null);
});

test('events: insertEvent defaults timestamp when undefined', async () => {
  const before = new Date().toISOString();
  const id = await insertEvent({
    source: 'file',
    kind: 'file.modified',
    data: { path: '/tmp/x' },
  });
  const after = new Date().toISOString();
  assert.ok(id);

  const rows = await queryEvents({ source: 'file', kind: 'file.modified' });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].timestamp >= before);
  assert.ok(rows[0].timestamp <= after);
});

test('watched_repos: add, list, soft-delete', async () => {
  const repoA = '/tmp/seal-test-repo-a';
  const repoB = '/tmp/seal-test-repo-b';

  const a = await addWatchedRepo({ path: repoA, hooksInstalled: true });
  assert.equal(a.path, repoA);
  assert.equal(a.name, 'seal-test-repo-a'); // basename default
  assert.equal(a.hooks_installed, 1);
  assert.equal(a.fallback_scraper, 0);
  assert.equal(a.removed_at, null);
  assert.ok(a.installed_at);

  const b = await addWatchedRepo({
    path: repoB,
    name: 'custom-name',
    fallbackScraper: true,
  });
  assert.equal(b.name, 'custom-name');
  assert.equal(b.fallback_scraper, 1);
  assert.equal(b.hooks_installed, 0);

  // Both active.
  let active = await listWatchedRepos();
  assert.equal(active.length, 2);

  // Soft-delete A.
  const removed = await removeWatchedRepo(repoA);
  assert.equal(removed, true);

  // Removing again → false (no active row).
  const removedAgain = await removeWatchedRepo(repoA);
  assert.equal(removedAgain, false);

  // Active list → only B.
  active = await listWatchedRepos();
  assert.equal(active.length, 1);
  assert.equal(active[0].path, repoB);

  // includeRemoved → both visible.
  const all = await listWatchedRepos({ includeRemoved: true });
  assert.equal(all.length, 2);

  // The soft-deleted row has removed_at set.
  const aRow = await getWatchedRepoByPath(repoA);
  assert.ok(aRow, 'soft-deleted row should still be retrievable');
  assert.ok(aRow.removed_at, 'removed_at should be set after removeWatchedRepo');

  // The active row B has removed_at = null.
  const bRow = await getWatchedRepoByPath(repoB);
  assert.equal(bRow.removed_at, null);
});

test('watched_repos: re-adding a removed repo un-deletes it and updates flags', async () => {
  const repoC = '/tmp/seal-test-repo-c';

  // Add, then remove.
  await addWatchedRepo({ path: repoC, hooksInstalled: false });
  assert.equal(await removeWatchedRepo(repoC), true);

  let row = await getWatchedRepoByPath(repoC);
  assert.ok(row.removed_at, 'precondition: row is soft-deleted');

  // Re-add with new flags.
  const reAdded = await addWatchedRepo({
    path: repoC,
    hooksInstalled: true,
    fallbackScraper: true,
  });

  assert.equal(reAdded.removed_at, null, 'un-delete should clear removed_at');
  assert.equal(reAdded.hooks_installed, 1, 'flags should update on re-add');
  assert.equal(reAdded.fallback_scraper, 1);

  // It should appear in the active listing.
  const active = await listWatchedRepos();
  assert.ok(active.some(r => r.path === repoC));
});

test('watched_repos: re-adding an active repo updates flags without duplicating', async () => {
  const repoD = '/tmp/seal-test-repo-d';

  await addWatchedRepo({ path: repoD, hooksInstalled: false });
  await addWatchedRepo({ path: repoD, hooksInstalled: true, fallbackScraper: true });

  const all = await listWatchedRepos({ includeRemoved: true });
  const dRows = all.filter(r => r.path === repoD);
  assert.equal(dRows.length, 1, 'no duplicate row for the same path');
  assert.equal(dRows[0].hooks_installed, 1);
  assert.equal(dRows[0].fallback_scraper, 1);
});

test('addWatchedRepo: rejects relative paths', async () => {
  await assert.rejects(
    async () => addWatchedRepo({ path: 'relative/path' }),
    /absolute/i
  );
});
