import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewResult, deriveVerdict, countBySeverity, buildThreadPayload, formatSummaryComment,
  countOpenBotThreads, formatFindingComment,
} from '../src/sensors/pr-review-pipeline-logic.js';

const ME = 'bot@example.com';
const block = (findings) => `<<<SEAL_REVIEW_JSON\n${JSON.stringify({ verdict: 'needs-work', findings })}\nSEAL_REVIEW_JSON>>>`;
const semCriterio = { severity: 'WARNING', kind: 'doc-request', title: 'US 64128 e Task 20226 sem critério de aceite', body: 'Peça os critérios.' };

test('só a falta de critério de aceite não bloqueia a PR', () => {
  const { data } = parseReviewResult(block([semCriterio]));
  assert.equal(data.findings[0].blocking, false);
  assert.equal(data.verdict, 'approved');
  assert.deepEqual(countBySeverity(data.findings), { blocker: 0, warning: 0, nit: 0 });
});

test('variações reais do título também viram lembrete', () => {
  for (const title of ['US 64128 e Task 20226 sem critérios de aceite', 'US e Task sem critério de aceite: a correção não tem cenário combinado para validar']) {
    const { data } = parseReviewResult(block([{ ...semCriterio, title }]));
    assert.equal(data.findings[0].blocking, false, title);
  }
});

test('o lembrete não esconde os achados que bloqueiam de verdade', () => {
  const { data } = parseReviewResult(block([
    semCriterio,
    { severity: 'BLOCKER', kind: 'code', title: 'Bloquear `body` quebra POST /send/push-notification' },
  ]));
  assert.equal(data.verdict, 'needs-work');
  assert.deepEqual(countBySeverity(data.findings), { blocker: 1, warning: 0, nit: 0 });
});

test('outro pedido de documentação continua bloqueando', () => {
  const { data } = parseReviewResult(block([{ severity: 'WARNING', kind: 'doc-request', title: 'Regras novas de anexo da negociação só existem no código' }]));
  assert.equal(data.findings[0].blocking, true);
  assert.equal(deriveVerdict(data.findings), 'needs-work');
});

test('o revisor pode marcar qualquer achado como lembrete', () => {
  const { data } = parseReviewResult(block([{ severity: 'NIT', kind: 'code', title: 'Nome de variável', blocking: false }]));
  assert.equal(data.verdict, 'approved');
});

test('lembrete é postado já resolvido e com rótulo próprio', () => {
  const { data } = parseReviewResult(block([semCriterio]));
  const payload = buildThreadPayload(data.findings[0]);
  assert.equal(payload.status, 4);
  assert.match(payload.comments[0].content, /^\*\*\[LEMBRETE · não bloqueia\] US 64128/);
});

test('na re-revisão o lembrete aberto não conta como pendência', () => {
  const { data } = parseReviewResult(block([semCriterio]));
  const threads = [{
    id: 1, status: 'active', isDeleted: false,
    comments: [{ author: { uniqueName: ME }, content: formatFindingComment(data.findings[0]) }],
  }];
  assert.equal(countOpenBotThreads(threads, ME), 0);
});

test('resumo aprova e cita o lembrete', () => {
  const { data } = parseReviewResult(block([semCriterio]));
  const summary = formatSummaryComment({ data, headSha: 'abc1234' });
  assert.match(summary, /✅ Aprovado/);
  assert.match(summary, /1 lembrete para o autor, que não bloqueia a aprovação/);
});

import { relabelAsReminder, severityOfComment } from '../src/sensors/pr-review-pipeline-logic.js';

test('comentário antigo de critério vira lembrete e mantém o corpo', () => {
  const old = '**[WARNING · Documentação] US 64128 e Task 20226 sem critério de aceite**\n\nPeça os critérios ao PO.';
  assert.equal(relabelAsReminder(old), '**[LEMBRETE · não bloqueia] US 64128 e Task 20226 sem critério de aceite**\n\nPeça os critérios ao PO.');
  assert.equal(relabelAsReminder(relabelAsReminder(old)), null);
});

test('outros comentários do bot não são tocados', () => {
  assert.equal(relabelAsReminder('**[WARNING · Documentação] Regras novas de anexo da negociação só existem no código**'), null);
  assert.equal(relabelAsReminder('**[BLOCKER] Bloquear `body` quebra POST /send/push-notification**'), null);
  assert.equal(relabelAsReminder('🔍 Revisando…'), null);
});

test('severidade é lida do rótulo, e lembrete não tem severidade', () => {
  assert.equal(severityOfComment('**[BLOCKER] x**'), 'BLOCKER');
  assert.equal(severityOfComment('**[WARNING · Teste faltando] x**'), 'WARNING');
  assert.equal(severityOfComment('**[LEMBRETE · não bloqueia] x**'), null);
});
