import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NudgeBehaviorAction, fallbackNudge } from '../src/actions/nudge-behavior.js';

test('fallbackNudge: burnout signal → check load suggestion', () => {
  const r = fallbackNudge({ summary: 'Carla: historico de burnout', detail: 'sinal de sobrecarga', people: '["Carla"]' });
  assert.equal(r.source, 'fallback');
  assert.match(r.suggestion, /carga|pausa/i);
});

test('fallbackNudge: isolation signal → pair/1:1 suggestion', () => {
  const r = fallbackNudge({ summary: 'Rafael: isolamento o trava', detail: 'sozinho leva mais tempo', people: '["Rafael"]' });
  assert.match(r.suggestion, /pair|1:1/i);
});

test('fallbackNudge: PDI signal → reschedule suggestion', () => {
  const r = fallbackNudge({ summary: 'Carla: reagendar PDI perdido', detail: 'perdi a data do PDI', people: '["Carla"]' });
  assert.match(r.suggestion, /pdi/i);
});

test('fallbackNudge: unknown signal → generic next-step suggestion', () => {
  const r = fallbackNudge({ summary: 'algo generico', detail: '', people: '[]' });
  assert.equal(r.source, 'fallback');
  assert.ok(r.suggestion.length > 0);
});

test('fallbackNudge: tags the suggestion as basic (LLM-down marker)', () => {
  // The deterministic fallback is what preview() shows when the LLM is down.
  // We test it directly (no real provider call — fast, not flaky). The 'basic'
  // tag is applied in preview() when result.source === 'fallback'.
  const r = fallbackNudge({ summary: 'Felipe: revisar PDI', detail: 'PDI em aberto', people: '["Felipe"]' });
  assert.equal(r.source, 'fallback');
  assert.ok(r.suggestion.length > 0);
});

test('preview: always returns a summary + suggestion (LLM or fallback)', async () => {
  // Robust to whichever path runs: it must always produce a usable card.
  const action = new NudgeBehaviorAction({ run: async () => {} });
  const preview = await action.preview({
    task: { id: 't1', summary: 'Felipe: revisar PDI', detail: 'PDI em aberto', people: '["Felipe"]' },
  });
  assert.match(preview.summary, /Felipe/);
  assert.match(preview.details, /Sugest/);
});

test('execute: marks the associated note done via db.run', async () => {
  let ran = null;
  const fakeDb = { run: async (sql, params) => { ran = { sql, params }; } };
  const action = new NudgeBehaviorAction(fakeDb);
  const result = await action.execute({ task: { id: 'abc123', summary: 'Felipe: revisar PDI' } });
  assert.equal(result.success, true);
  assert.match(ran.sql, /UPDATE tasks SET status = 'done'/);
  assert.deepEqual(ran.params, ['abc123']);
});

test('execute: fails gracefully when no task id', async () => {
  const action = new NudgeBehaviorAction({ run: async () => {} });
  const result = await action.execute({ task: {} });
  assert.equal(result.success, false);
});

test('execute: surfaces db errors as a failed result, not a throw', async () => {
  const fakeDb = { run: async () => { throw new Error('db locked'); } };
  const action = new NudgeBehaviorAction(fakeDb);
  const result = await action.execute({ task: { id: 'x', summary: 's' } });
  assert.equal(result.success, false);
  assert.match(result.message, /db locked/);
});
