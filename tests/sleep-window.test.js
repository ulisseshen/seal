import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { quietWindow, quietUntil, awakeTimer } from '../src/sleep-window.js';

const at = (h, m = 0) => new Date(2026, 8, 25, h, m, 0, 0);

test('padrão dorme das 00h às 6h', () => {
  assert.deepEqual(quietWindow({}), { start: 0, end: 6 });
});

test('dentro da janela adia até as 6h do mesmo dia', () => {
  assert.deepEqual(quietUntil(at(0, 0), { start: 0, end: 6 }), at(6));
  assert.deepEqual(quietUntil(at(3, 47), { start: 0, end: 6 }), at(6));
  assert.deepEqual(quietUntil(at(5, 59), { start: 0, end: 6 }), at(6));
});

test('fora da janela não adia', () => {
  assert.equal(quietUntil(at(6, 0), { start: 0, end: 6 }), null);
  assert.equal(quietUntil(at(23, 59), { start: 0, end: 6 }), null);
});

test('janela que cruza a meia-noite', () => {
  const w = { start: 23, end: 6 };
  assert.deepEqual(quietUntil(at(23, 30), w), new Date(2026, 8, 26, 6));
  assert.deepEqual(quietUntil(at(2), w), at(6));
  assert.equal(quietUntil(at(12), w), null);
});

test('SEAL_QUIET_HOURS=off desliga a janela', () => {
  assert.equal(quietWindow({ SEAL_QUIET_HOURS: 'off' }), null);
  assert.deepEqual(quietWindow({ SEAL_QUIET_HOURS: '1-7' }), { start: 1, end: 7 });
});

test('tempo dormindo não conta para o limite da tarefa', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  let clock = 0;
  let expired = null;
  const timer = awakeTimer(30 * 60_000, (info) => { expired = info; }, { tickMs: 15_000, now: () => clock });
  const tick = (ms) => { clock += ms; mock.timers.tick(15_000); };

  for (let i = 0; i < 40; i++) tick(15_000);
  tick(15.5 * 60_000);
  for (let i = 0; i < 40; i++) tick(15_000);
  tick(15.5 * 60_000);
  assert.equal(expired, null, 'duas sonecas de 15,5 min não podem matar uma tarefa com 20 min acordada');

  for (let i = 0; i < 40; i++) tick(15_000);
  assert.ok(expired, 'com mais de 30 min acordada o limite dispara');
  assert.ok(expired.sleptMs >= 30 * 60_000);
  timer.stop();
  mock.timers.reset();
});

test('the sleep tracker notices a gap between ticks and remembers when the Mac woke up', async () => {
  const { createSleepTracker } = await import('../src/sleep-window.js');
  let clock = 1_000_000;
  const tracker = createSleepTracker({ tickMs: 15_000, sleepGapMs: 60_000, now: () => clock });
  clock += 15_000; tracker.tick();
  assert.equal(tracker.lastWakeAt(), null);
  assert.equal(tracker.sleptWithin(3_600_000), false);
  clock += 15_000 + 20 * 60_000; tracker.tick();
  assert.equal(tracker.lastWakeAt(), clock);
  assert.equal(tracker.sleptWithin(3_600_000), true);
  clock += 61 * 60_000; tracker.tick();
  assert.equal(tracker.sleptWithin(3_600_000), true, 'a gap in this tick is itself a sleep');
  for (let i = 0; i < 124; i++) { clock += 15_000; tracker.tick(); }
  assert.equal(tracker.sleptWithin(30 * 60_000), false);
});
