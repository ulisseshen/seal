import test from 'node:test';
import assert from 'node:assert/strict';

test('each log line starts with the local date and time', async () => {
  const { stamp, withStamp } = await import('../src/log-timestamps.js');
  const at = new Date(2026, 8, 28, 9, 5, 7);
  assert.equal(stamp(at), '2026-09-28 09:05:07');
  assert.equal(withStamp(['[pr-review] Done.', { created: 1 }], at), "[2026-09-28 09:05:07] [pr-review] Done. { created: 1 }");
});
