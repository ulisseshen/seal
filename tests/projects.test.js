import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProject, splitSummary } from '../src/projects.js';

const known = ['painel-time', 'seal', 'api-legada'];
const aliases = { painel: 'painel-time' };

test('a local alias anywhere in the sentence finds the project, and the text is kept whole', () => {
  const found = detectProject('Preciso criar uma parte no painel onde posso pegar o resumo da semana', { known, aliases });
  assert.equal(found.projectName, 'painel-time');
  assert.equal(found.alias, 'painel');
  assert.equal(found.cleanMessage, 'Preciso criar uma parte no painel onde posso pegar o resumo da semana');
});

test('a project name as a whole word anywhere is found too, and the old prefix forms still work', () => {
  assert.equal(detectProject('corrigir o login no api-legada hoje', { known, aliases }).projectName, 'api-legada');
  assert.equal(detectProject('coisas pessoais para ver', { known: [...known, 'pessoais'], aliases }).projectName, null);
  assert.deepEqual(detectProject('seal: rodar os testes', { known, aliases }).cleanMessage, 'rodar os testes');
  assert.equal(detectProject('selar o envelope', { known, aliases }).projectName, null);
});

test('a long single-line message keeps everything: short summary, full text as detail', () => {
  const text = `Preciso criar uma parte no painel onde posso pegar o resumo da semana para passar para o gerente. E olhar as tasks/bugs em aberto para setembro. E cruzar com a planilha da softys.`;
  const { summary, detail } = splitSummary(text);
  assert.ok(summary.length <= 80);
  assert.equal(detail, text);
  assert.deepEqual(splitSummary('curto'), { summary: 'curto', detail: null });
  assert.deepEqual(splitSummary('título\ncorpo'), { summary: 'título', detail: 'corpo' });
});
