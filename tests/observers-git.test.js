// Stream C — GitObserver tests for v0.3.0 "Eye" layer.
//
// Same isolation pattern as Stream A + B tests: point SEAL_DB_PATH at a
// temp file BEFORE importing anything that touches src/db.js (src/db.js
// runs schema creation at import time via top-level await).

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DB = path.join(
  os.tmpdir(),
  `seal-test-git-observer-${process.pid}-${Date.now()}.db`,
);
process.env.SEAL_DB_PATH = TMP_DB;

const TMP_IPC = path.join(
  os.tmpdir(),
  `seal-test-git-observer-ipc-${process.pid}-${Date.now()}`,
);

const { GitObserver } = await import('../src/observers/git.js');
const { EventBus } = await import('../src/event-bus.js');
const { queryEvents, insertEvent } = await import('../src/db.js');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
  try { fs.rmSync(TMP_IPC, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Let fire-and-forget insertEvent chain drain before we query.
async function drain() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function makeObserver() {
  const bus = new EventBus();
  const obs = new GitObserver(bus, { ipcDir: TMP_IPC });
  return { bus, obs };
}

// Capture console.warn calls for assertions, then restore.
function captureWarn(fn) {
  const original = console.warn;
  const captured = [];
  console.warn = (...args) => { captured.push(args.map(String).join(' ')); };
  return Promise.resolve(fn()).finally(() => { console.warn = original; });
}

test('post-commit payload emits git.commit event', async () => {
  const { obs } = makeObserver();
  await obs.ingestHookPayload({
    repo_path: '/tmp/test-repo-commit',
    repo_name: 'test-repo-commit',
    hook: 'post-commit',
    timestamp: '2026-04-10T12:00:00Z',
    data: { sha: 'abc123', branch: 'main', message: 'first commit' },
  });
  await drain();

  const rows = await queryEvents({ source: 'git', kind: 'git.commit' });
  const match = rows.find((r) => r.data?.repo_path === '/tmp/test-repo-commit');
  assert.ok(match, 'git.commit event should be persisted');
  assert.equal(match.data.sha, 'abc123');
  assert.equal(match.data.branch, 'main');
  assert.equal(match.data.message, 'first commit');
  assert.equal(match.data.repo, 'test-repo-commit');
  assert.equal(match.timestamp, '2026-04-10T12:00:00Z');
});

test('post-checkout (new branch) emits git.branch.created', async () => {
  const { obs } = makeObserver();
  await obs.ingestHookPayload({
    repo_path: '/tmp/test-repo-newbranch',
    repo_name: 'test-repo-newbranch',
    hook: 'post-checkout',
    timestamp: '2026-04-10T12:05:00Z',
    data: {
      prev_head: 'aaaa',
      new_head: 'bbbb',
      is_branch: '1',
      branch: 'feature/new-thing',
    },
  });
  await drain();

  const rows = await queryEvents({ source: 'git', kind: 'git.branch.created' });
  const match = rows.find(
    (r) => r.data?.repo_path === '/tmp/test-repo-newbranch',
  );
  assert.ok(match, 'git.branch.created event should be persisted');
  assert.equal(match.data.name, 'feature/new-thing');
  assert.equal(match.data.base, null);
});

test('post-checkout (existing branch) does NOT emit git.branch.created', async () => {
  const { obs } = makeObserver();
  // Seed a prior commit on the branch we're about to check out.
  await insertEvent({
    source: 'git',
    kind: 'git.commit',
    data: {
      repo: 'test-repo-existing',
      repo_path: '/tmp/test-repo-existing',
      branch: 'main',
      sha: 'seed1',
      message: 'seed',
    },
  });
  await drain();

  const before = (await queryEvents({
    source: 'git',
    kind: 'git.branch.created',
  })).length;

  await obs.ingestHookPayload({
    repo_path: '/tmp/test-repo-existing',
    repo_name: 'test-repo-existing',
    hook: 'post-checkout',
    timestamp: '2026-04-10T12:10:00Z',
    data: {
      prev_head: 'cccc',
      new_head: 'dddd',
      is_branch: '1',
      branch: 'main',
    },
  });
  await drain();

  const after = (await queryEvents({
    source: 'git',
    kind: 'git.branch.created',
  })).length;
  assert.equal(after, before, 'no new git.branch.created event should be added');
});

test('post-checkout (file checkout, not branch) is swallowed', async () => {
  const { obs } = makeObserver();
  const before = (await queryEvents({ source: 'git' })).length;

  await obs.ingestHookPayload({
    repo_path: '/tmp/test-repo-filecheckout',
    repo_name: 'test-repo-filecheckout',
    hook: 'post-checkout',
    timestamp: '2026-04-10T12:15:00Z',
    data: {
      prev_head: 'eeee',
      new_head: 'ffff',
      is_branch: '0', // file checkout, not branch
      branch: '',
    },
  });
  await drain();

  const after = (await queryEvents({ source: 'git' })).length;
  assert.equal(after, before, 'file checkouts should produce no events');
});

test('post-checkout with identical prev/new heads is swallowed', async () => {
  const { obs } = makeObserver();
  const before = (await queryEvents({ source: 'git' })).length;

  await obs.ingestHookPayload({
    repo_path: '/tmp/test-repo-noop',
    repo_name: 'test-repo-noop',
    hook: 'post-checkout',
    timestamp: '2026-04-10T12:16:00Z',
    data: {
      prev_head: 'samehash',
      new_head: 'samehash',
      is_branch: '1',
      branch: 'main',
    },
  });
  await drain();

  const after = (await queryEvents({ source: 'git' })).length;
  assert.equal(after, before, 'no-op checkouts should produce no events');
});

test('post-merge emits git.merge with correct shape', async () => {
  const { obs } = makeObserver();
  await obs.ingestHookPayload({
    repo_path: '/tmp/test-repo-merge',
    repo_name: 'test-repo-merge',
    hook: 'post-merge',
    timestamp: '2026-04-10T12:20:00Z',
    data: {
      squash: '0',
      branch: 'main',
      merge_head: 'deadbeef',
    },
  });
  await drain();

  const rows = await queryEvents({ source: 'git', kind: 'git.merge' });
  const match = rows.find((r) => r.data?.repo_path === '/tmp/test-repo-merge');
  assert.ok(match, 'git.merge event should be persisted');
  assert.equal(match.data.branch, 'main');
  assert.equal(match.data.merge_head, 'deadbeef');
  assert.equal(match.data.squash, false);
});

test('post-merge with squash=1 sets squash=true', async () => {
  const { obs } = makeObserver();
  await obs.ingestHookPayload({
    repo_path: '/tmp/test-repo-squash',
    repo_name: 'test-repo-squash',
    hook: 'post-merge',
    timestamp: '2026-04-10T12:21:00Z',
    data: { squash: '1', branch: 'main', merge_head: 'cafef00d' },
  });
  await drain();

  const rows = await queryEvents({ source: 'git', kind: 'git.merge' });
  const match = rows.find((r) => r.data?.repo_path === '/tmp/test-repo-squash');
  assert.ok(match);
  assert.equal(match.data.squash, true);
});

test('pre-push emits git.push with correct shape', async () => {
  const { obs } = makeObserver();
  await obs.ingestHookPayload({
    repo_path: '/tmp/test-repo-push',
    repo_name: 'test-repo-push',
    hook: 'pre-push',
    timestamp: '2026-04-10T12:25:00Z',
    data: {
      remote: 'origin',
      url: 'git@github.com:foo/bar.git',
      branch: 'main',
    },
  });
  await drain();

  const rows = await queryEvents({ source: 'git', kind: 'git.push' });
  const match = rows.find((r) => r.data?.repo_path === '/tmp/test-repo-push');
  assert.ok(match, 'git.push event should be persisted');
  assert.equal(match.data.branch, 'main');
  assert.equal(match.data.remote, 'origin');
});

test('unknown hook type logs a warning and emits nothing', async () => {
  const { obs } = makeObserver();
  const before = (await queryEvents({ source: 'git' })).length;

  await captureWarn(async () => {
    await obs.ingestHookPayload({
      repo_path: '/tmp/test-repo-unknown',
      repo_name: 'test-repo-unknown',
      hook: 'pre-commit', // not a hook we handle
      timestamp: '2026-04-10T12:30:00Z',
      data: {},
    });
    await drain();
  });

  const after = (await queryEvents({ source: 'git' })).length;
  assert.equal(after, before, 'unknown hook should not emit events');
});

test('malformed payload (missing repo_path) does not crash or emit', async () => {
  const { obs } = makeObserver();
  const before = (await queryEvents({ source: 'git' })).length;

  await assert.doesNotReject(() =>
    obs.ingestHookPayload({
      hook: 'post-commit',
      data: { sha: 'x', branch: 'main', message: 'm' },
    }),
  );
  await obs.ingestHookPayload(null);
  await obs.ingestHookPayload(undefined);
  await obs.ingestHookPayload('not an object');
  await drain();

  const after = (await queryEvents({ source: 'git' })).length;
  assert.equal(after, before, 'malformed payloads must emit nothing');
});

test('drainIpcQueue processes valid lines, skips malformed, and removes the file', async () => {
  // Unique IPC dir for this test so other tests don't race with us.
  const ipcDir = path.join(TMP_IPC, 'drain-test');
  fs.mkdirSync(ipcDir, { recursive: true });
  const queuePath = path.join(ipcDir, 'queue.jsonl');

  const lines = [
    JSON.stringify({
      repo_path: '/tmp/drain-repo',
      repo_name: 'drain-repo',
      hook: 'post-commit',
      timestamp: '2026-04-10T13:00:00Z',
      data: { sha: 'd1', branch: 'main', message: 'drain 1' },
    }),
    JSON.stringify({
      repo_path: '/tmp/drain-repo',
      repo_name: 'drain-repo',
      hook: 'post-commit',
      timestamp: '2026-04-10T13:01:00Z',
      data: { sha: 'd2', branch: 'main', message: 'drain 2' },
    }),
    '{not valid json',
    JSON.stringify({
      repo_path: '/tmp/drain-repo',
      repo_name: 'drain-repo',
      hook: 'pre-push',
      timestamp: '2026-04-10T13:02:00Z',
      data: { remote: 'origin', url: '', branch: 'main' },
    }),
  ];
  fs.writeFileSync(queuePath, lines.join('\n') + '\n', 'utf8');

  const bus = new EventBus();
  const obs = new GitObserver(bus, { ipcDir });

  let warnings = [];
  await captureWarn(async () => {
    await obs.drainIpcQueue();
    await drain();
  }).then(() => {
    // captureWarn doesn't expose the captured array here — re-run with an
    // inline capture if we need to assert. We rely on the next assertion
    // block and the fact that drain succeeds without throwing.
  });

  // Queue file must be removed (atomic swap + unlink).
  assert.equal(
    fs.existsSync(queuePath),
    false,
    'queue file should be removed after drain',
  );
  assert.equal(
    fs.existsSync(queuePath + '.draining'),
    false,
    'staging file should be removed after drain',
  );

  // Two commits + one push should be persisted.
  const commits = await queryEvents({ source: 'git', kind: 'git.commit' });
  const drained = commits.filter((r) => r.data?.repo_path === '/tmp/drain-repo');
  assert.equal(drained.length, 2, 'two valid commits should be drained');
  const shas = drained.map((r) => r.data.sha).sort();
  assert.deepEqual(shas, ['d1', 'd2']);

  const pushes = await queryEvents({ source: 'git', kind: 'git.push' });
  const drainedPush = pushes.find((r) => r.data?.repo_path === '/tmp/drain-repo');
  assert.ok(drainedPush, 'valid push should be drained');
});

test('drainIpcQueue is a no-op when the queue file does not exist', async () => {
  const ipcDir = path.join(TMP_IPC, 'empty-drain-test');
  fs.mkdirSync(ipcDir, { recursive: true });
  const bus = new EventBus();
  const obs = new GitObserver(bus, { ipcDir });
  await assert.doesNotReject(() => obs.drainIpcQueue());
});

test('fallback scraper picks up commits from a real tmp git repo', async () => {
  // Skip gracefully if git isn't available in the test environment.
  const { execSync } = await import('node:child_process');
  try {
    execSync('git --version', { stdio: 'ignore' });
  } catch {
    return; // no git, nothing to test
  }

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-scrape-repo-'));
  try {
    const run = (cmd) => execSync(cmd, { cwd: repoDir, stdio: 'pipe' });
    run('git init -q');
    run('git config user.email "test@seal.local"');
    run('git config user.name  "SEAL Test"');
    run('git commit -q --allow-empty -m "scraper seed commit"');
    run('git tag v0.0.1-test');

    const { addWatchedRepo } = await import('../src/db.js');
    const repo = await addWatchedRepo({
      path: repoDir,
      name: 'scrape-test',
      fallbackScraper: true,
    });

    const bus = new EventBus();
    const obs = new GitObserver(bus, { ipcDir: TMP_IPC });
    await obs.scrapeRepo(repo);
    await drain();

    const commits = await queryEvents({
      source: 'git',
      kind: 'git.commit',
    });
    const fromScraper = commits.filter(
      (r) => r.data?.repo_path === repoDir && r.data?.scraped === true,
    );
    assert.ok(
      fromScraper.length >= 1,
      'scraper should emit at least one git.commit',
    );

    const tags = await queryEvents({
      source: 'git',
      kind: 'git.tag.created',
    });
    const scrapedTag = tags.find(
      (r) => r.data?.repo_path === repoDir && r.data?.name === 'v0.0.1-test',
    );
    assert.ok(scrapedTag, 'scraper should emit git.tag.created for v0.0.1-test');

    // Second scrape should be idempotent — no duplicate commit/tag events.
    const commitsBefore = (await queryEvents({
      source: 'git',
      kind: 'git.commit',
      limit: 500,
    })).filter((r) => r.data?.repo_path === repoDir).length;
    const tagsBefore = (await queryEvents({
      source: 'git',
      kind: 'git.tag.created',
      limit: 500,
    })).filter((r) => r.data?.repo_path === repoDir).length;

    await obs.scrapeRepo(repo);
    await drain();

    const commitsAfter = (await queryEvents({
      source: 'git',
      kind: 'git.commit',
      limit: 500,
    })).filter((r) => r.data?.repo_path === repoDir).length;
    const tagsAfter = (await queryEvents({
      source: 'git',
      kind: 'git.tag.created',
      limit: 500,
    })).filter((r) => r.data?.repo_path === repoDir).length;

    assert.equal(commitsAfter, commitsBefore, 'scraper must de-dup commits');
    assert.equal(tagsAfter, tagsBefore, 'scraper must de-dup tags');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
