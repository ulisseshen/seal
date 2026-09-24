import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsageLimit, resumeAt, usageLimitResult, isUsageLimitResult, usageLimitMessage,
  markUsageLimit, usagePausedUntil, resetUsagePauseForTests,
} from '../src/usage-limit.js';

const REAL_OUTPUT = "You've hit your session limit · resets 6:10pm (America/Sao_Paulo)\n";

test('reconhece a mensagem real do limite de sessão e resolve o reset no fuso dela', () => {
  const failedAt = new Date('2026-09-24T20:16:52.640Z');
  const limit = parseUsageLimit(REAL_OUTPUT, failedAt);
  assert.equal(limit.kind, 'session');
  assert.equal(limit.timeZone, 'America/Sao_Paulo');
  assert.equal(limit.resetAt.toISOString(), '2026-09-24T21:10:00.000Z');
  assert.equal(limit.estimated, false);
});

test('reset que já passou em relação à falha vai para o dia seguinte', () => {
  const limit = parseUsageLimit(REAL_OUTPUT, new Date('2026-09-24T22:00:00.000Z'));
  assert.equal(limit.resetAt.toISOString(), '2026-09-25T21:10:00.000Z');
});

test('limite semanal com data', () => {
  const limit = parseUsageLimit("You've hit your weekly limit · resets Sep 26, 7pm (America/Sao_Paulo)", new Date('2026-09-24T20:00:00Z'));
  assert.equal(limit.kind, 'weekly');
  assert.equal(limit.resetAt.toISOString(), '2026-09-26T22:00:00.000Z');
});

test('saída sem limite não é confundida com limite', () => {
  assert.equal(parseUsageLimit('SessionEnd hook [bash x.sh] failed: Hook cancelled'), null);
  assert.equal(parseUsageLimit('I reviewed part 1 and it has two WARNINGs'), null);
});

test('retoma depois do reset, nunca no passado', () => {
  const limit = parseUsageLimit(REAL_OUTPUT, new Date('2026-09-24T20:16:52Z'));
  assert.equal(resumeAt(limit, new Date('2026-09-24T20:17:00Z')).toISOString(), '2026-09-24T21:12:00.000Z');
  const later = new Date('2026-09-24T21:30:00Z');
  assert.equal(resumeAt(limit, later).toISOString(), later.toISOString());
});

test('resultado sentinela é reconhecido', () => {
  const limit = parseUsageLimit(REAL_OUTPUT, new Date('2026-09-24T20:16:52Z'));
  assert.ok(isUsageLimitResult(usageLimitResult(limit)));
  assert.ok(!isUsageLimitResult('Process killed (SIGTERM)'));
});

test('mensagem diz que o limite acabou e a hora local de retomada', () => {
  const limit = parseUsageLimit(REAL_OUTPUT, new Date('2026-09-24T20:16:52Z'));
  const msg = usageLimitMessage(limit, 'smart-review PR #10110: parte 1/3');
  assert.match(msg, /limite da sessão de 5h do Claude acabou/);
  assert.match(msg, /retoma sozinha às 18:10/);
  assert.match(msg, /#44642/);
});

test('avisa uma vez por janela de limite', () => {
  resetUsagePauseForTests();
  const now = new Date('2026-09-24T20:16:52Z');
  const limit = parseUsageLimit(REAL_OUTPUT, now);
  assert.equal(markUsageLimit(limit), true);
  assert.equal(markUsageLimit(limit), false);
  assert.equal(usagePausedUntil(now.getTime()).toISOString(), '2026-09-24T21:10:00.000Z');
  assert.equal(usagePausedUntil(Date.parse('2026-09-24T21:11:00Z')), null);
  resetUsagePauseForTests();
});
