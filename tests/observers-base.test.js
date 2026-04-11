// Stream B — Observer base class tests for v0.3.0 "Eye" layer.
//
// Same isolation pattern as tests/db-events.test.js: point SEAL_DB_PATH at a
// temp file BEFORE importing anything that touches src/db.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DB = path.join(
  os.tmpdir(),
  `seal-test-observers-base-${process.pid}-${Date.now()}.db`
);
process.env.SEAL_DB_PATH = TMP_DB;

const { Observer } = await import('../src/observers/base.js');
const { EventBus, eventBus } = await import('../src/event-bus.js');
const { queryEvents } = await import('../src/db.js');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
});

async function drain() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

test('Observer is abstract — direct instantiation throws', () => {
  const bus = new EventBus();
  assert.throws(() => new Observer('foo', bus), /abstract/i);
});

test('Observer.start() throws if subclass does not override', async () => {
  class NoStart extends Observer {}
  const bus = new EventBus();
  const obs = new NoStart('no-start', bus);
  await assert.rejects(() => obs.start(), /not implemented/i);
});

test('Observer.stop() default is a no-op that sets started=false', async () => {
  class NoStop extends Observer {
    async start() { this.started = true; }
  }
  const bus = new EventBus();
  const obs = new NoStop('no-stop', bus);
  await obs.start();
  assert.equal(obs.started, true);
  await assert.doesNotReject(() => obs.stop());
  assert.equal(obs.started, false);
});

test('Concrete subclass emits through the bus and lands in the DB', async () => {
  class FakeObserver extends Observer {
    async start() { this.started = true; }
    fire(kind, data) { this.emit({ kind, data }); }
  }

  const obs = new FakeObserver('fake-source', eventBus);
  await obs.start();
  obs.fire('fake.kind.one', { hello: 'world', n: 7 });

  await drain();

  const rows = await queryEvents({ source: 'fake-source', kind: 'fake.kind.one' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'fake-source');
  assert.equal(rows[0].kind, 'fake.kind.one');
  assert.equal(rows[0].data.hello, 'world');
  assert.equal(rows[0].data.n, 7);
  assert.ok(rows[0].timestamp, 'timestamp should be auto-filled');
});

test('Observer.emit() without kind logs a warning and drops silently', async () => {
  class Silent extends Observer {
    async start() { this.started = true; }
    tryEmit(e) { this.emit(e); }
  }

  const obs = new Silent('silent-source', eventBus);

  // Snapshot: current event count for this source.
  const before = await queryEvents({ source: 'silent-source' });
  const beforeCount = before.length;

  // Capture console.warn to assert the drop was logged.
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };

  try {
    assert.doesNotThrow(() => obs.tryEmit({ data: { no: 'kind' } }));
    assert.doesNotThrow(() => obs.tryEmit(null));
    assert.doesNotThrow(() => obs.tryEmit(undefined));
  } finally {
    console.warn = origWarn;
  }

  assert.ok(
    warnings.some((w) => w.includes('silent-source') && w.includes('dropped')),
    'should log a "dropped" warning mentioning the observer name'
  );

  await drain();

  const after = await queryEvents({ source: 'silent-source' });
  assert.equal(after.length, beforeCount, 'no events should have been persisted');
});

test('Observer constructor rejects missing name', () => {
  class Ok extends Observer {
    async start() {}
  }
  const bus = new EventBus();
  assert.throws(() => new Ok('', bus), /name/i);
  assert.throws(() => new Ok(null, bus), /name/i);
  assert.throws(() => new Ok(undefined, bus), /name/i);
  assert.throws(() => new Ok(123, bus), /name/i);
});

test('Observer constructor rejects missing or invalid bus', () => {
  class Ok extends Observer {
    async start() {}
  }
  assert.throws(() => new Ok('good', null), /EventBus/i);
  assert.throws(() => new Ok('good', undefined), /EventBus/i);
  assert.throws(() => new Ok('good', {}), /EventBus/i);
  assert.throws(() => new Ok('good', { observe: 'not-a-fn' }), /EventBus/i);
});
