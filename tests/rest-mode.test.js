import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRest, parseOnBattery } from '../src/rest-mode.js';

const NOW = Date.parse('2026-09-25T23:30:00-03:00');

test('on battery the SEAL rests, on the charger it works', () => {
  assert.deepEqual(decideRest({ now: NOW, onBattery: true }), { resting: true, reason: 'bateria' });
  assert.deepEqual(decideRest({ now: NOW, onBattery: false }), { resting: false, reason: null });
});

test('quiet hours rest even on the charger', () => {
  assert.deepEqual(decideRest({ now: NOW, onBattery: false, quiet: true }), { resting: true, reason: 'madrugada' });
});

test('a manual choice wins while it lasts, then the automatic rule comes back', () => {
  const until = new Date(NOW + 3_600_000).toISOString();
  assert.deepEqual(decideRest({ now: NOW, onBattery: true, manual: { mode: 'off', until } }), { resting: false, reason: 'manual' });
  assert.deepEqual(decideRest({ now: NOW, onBattery: false, manual: { mode: 'on', until } }), { resting: true, reason: 'manual' });
  assert.deepEqual(decideRest({ now: NOW + 7_200_000, onBattery: true, manual: { mode: 'off', until } }), { resting: true, reason: 'bateria' });
});

test('pmset output tells battery from the charger', () => {
  assert.equal(parseOnBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 3%; discharging"), true);
  assert.equal(parseOnBattery("Now drawing from 'AC Power'\n -InternalBattery-0 80%; charging"), false);
  assert.equal(parseOnBattery(''), false);
});

test('pr review tasks and their parts are the ones that keep running on battery', async () => {
  const { isPrReviewTask } = await import('../src/rest-mode.js');
  assert.equal(isPrReviewTask('seal_pr_45106'), true);
  assert.equal(isPrReviewTask('seal_pr_45106_p2'), true);
  assert.equal(isPrReviewTask('seal_briefing_1'), false);
  assert.equal(isPrReviewTask(null), false);
});
