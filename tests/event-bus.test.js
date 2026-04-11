// Stream B — EventBus tests for v0.3.0 "Eye" layer.
//
// Same isolation pattern as tests/db-events.test.js: point SEAL_DB_PATH at a
// temp file BEFORE importing anything that touches src/db.js (src/db.js runs
// schema creation at import time via top-level await).

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DB = path.join(
  os.tmpdir(),
  `seal-test-event-bus-${process.pid}-${Date.now()}.db`
);
process.env.SEAL_DB_PATH = TMP_DB;

// Dynamic imports AFTER setting the env var.
const { EventBus, eventBus } = await import('../src/event-bus.js');
const { queryEvents } = await import('../src/db.js');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
});

// Helper: let the fire-and-forget insertEvent chain drain.
// insertEvent is async; observe() does not await it. We yield the microtask
// queue a few times so the INSERT resolves before we queryEvents().
async function drain() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  // Also yield a macrotask in case better-sqlite3's Promise.resolve wrapper
  // still needs one more tick on some Node versions.
  await new Promise((r) => setImmediate(r));
}

test('EventBus.observe() fills in timestamp when missing', async () => {
  const bus = new EventBus();
  const before = new Date().toISOString();
  let captured;
  bus.on('observation', (e) => { captured = e; });

  bus.observe({
    source: 'test-ts',
    kind: 'test.timestamp.missing',
    data: { n: 1 },
  });

  const after = new Date().toISOString();
  assert.ok(captured, 'listener should have fired');
  assert.ok(captured.timestamp, 'timestamp should be filled in');
  assert.ok(captured.timestamp >= before);
  assert.ok(captured.timestamp <= after);
});

test('EventBus.observe() preserves explicit timestamp', async () => {
  const bus = new EventBus();
  const explicit = '2026-01-01T00:00:00.000Z';
  let captured;
  bus.on('observation', (e) => { captured = e; });

  bus.observe({
    source: 'test-ts',
    kind: 'test.timestamp.explicit',
    timestamp: explicit,
    data: {},
  });

  assert.equal(captured.timestamp, explicit);
});

test('EventBus.observe() fires all three tiers in order with the same payload', async () => {
  const bus = new EventBus();
  const order = [];
  const payloads = [];

  bus.on('observation', (e) => { order.push('all'); payloads.push(e); });
  bus.on('observation:git', (e) => { order.push('source'); payloads.push(e); });
  bus.on('observation:git:git.commit', (e) => { order.push('kind'); payloads.push(e); });

  bus.observe({
    source: 'git',
    kind: 'git.commit',
    timestamp: '2026-04-10T12:00:00.000Z',
    data: { sha: 'deadbeef' },
  });

  assert.deepEqual(order, ['all', 'source', 'kind']);
  assert.equal(payloads.length, 3);
  // All three listeners should receive the exact same (referentially equal)
  // stamped payload.
  assert.equal(payloads[0], payloads[1]);
  assert.equal(payloads[1], payloads[2]);
  assert.equal(payloads[0].data.sha, 'deadbeef');
});

test('EventBus.observe() persists to the events table', async () => {
  // Use the real singleton so persistence goes through insertEvent → db.js.
  const kind = 'test.persist.basic';
  eventBus.observe({
    source: 'bus-test',
    kind,
    timestamp: '2026-04-10T13:00:00.000Z',
    data: { ok: true, n: 42 },
  });

  await drain();

  const rows = await queryEvents({ source: 'bus-test', kind });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].timestamp, '2026-04-10T13:00:00.000Z');
  assert.equal(rows[0].data.ok, true);
  assert.equal(rows[0].data.n, 42);
});

test('EventBus.observe() survives a throwing listener and still persists subsequent events', async () => {
  // Subscribe a listener that throws on a specific kind.
  const throwingListener = (e) => {
    if (e.kind === 'test.throw.boom') {
      throw new Error('intentional listener boom');
    }
  };
  eventBus.on('observation', throwingListener);

  try {
    // First event: triggers the throwing listener. Must not crash.
    assert.doesNotThrow(() => {
      eventBus.observe({
        source: 'bus-test',
        kind: 'test.throw.boom',
        data: { step: 1 },
      });
    });

    // Second event: bus must still be healthy and must still persist.
    eventBus.observe({
      source: 'bus-test',
      kind: 'test.throw.after',
      data: { step: 2 },
    });

    await drain();

    const after = await queryEvents({ source: 'bus-test', kind: 'test.throw.after' });
    assert.equal(after.length, 1);
    assert.equal(after[0].data.step, 2);

    // The throwing event itself should also have persisted — persistence runs
    // after the listener tiers and is independent of listener errors.
    const boom = await queryEvents({ source: 'bus-test', kind: 'test.throw.boom' });
    assert.equal(boom.length, 1);
  } finally {
    eventBus.off('observation', throwingListener);
  }
});

test('EventBus.observe() with circular-ref data does not crash the bus', async () => {
  const circular = { name: 'cycle' };
  circular.self = circular;

  // insertEvent handles the circular internally (returns null). The bus must
  // not throw either — the JSON.stringify failure lives inside insertEvent.
  assert.doesNotThrow(() => {
    eventBus.observe({
      source: 'bus-test',
      kind: 'test.circular',
      data: circular,
    });
  });

  // Subsequent events must still work.
  eventBus.observe({
    source: 'bus-test',
    kind: 'test.circular.after',
    data: { recovered: true },
  });

  await drain();

  const after = await queryEvents({ source: 'bus-test', kind: 'test.circular.after' });
  assert.equal(after.length, 1);
  assert.equal(after[0].data.recovered, true);

  // The circular event should NOT have persisted (insertEvent returned null
  // because JSON.stringify failed).
  const circ = await queryEvents({ source: 'bus-test', kind: 'test.circular' });
  assert.equal(circ.length, 0);
});
