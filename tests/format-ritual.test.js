// Formatação da mensagem de ritual.
//
// Esta é a mensagem que o usuário recebe DUAS VEZES POR DIA. Em 10/08 ele
// reclamou: "a mensagem que o SEAL mandou sem formatação nenhuma, bem feia".
// Estava certo — o ritual saía como texto cru, incluindo metadados
// administrativos (PREP_OFFSET, ATTENDEES, FREQUENCY) que só servem ao SEAL.
//
// Se a mensagem dá preguiça de ler, o ritual morre por design ruim e não por
// indisciplina — e aí a revisão de 25/08 mede a coisa errada.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatRitualMessage, stripMeta } from '../src/brain/format-ritual.js';

test('remove metadados administrativos do template', () => {
  const detail = [
    'TEMPLATE:',
    '- Teve algo novo?',
    '- Afeta cliente?',
    '',
    'PREP_OFFSET: 0 minutes before',
    'ATTENDEES: solo',
    'FREQUENCY: every weekday 09:15',
  ].join('\n');

  const out = stripMeta(detail);
  assert.ok(!out.includes('PREP_OFFSET'), 'metadado não é para o leitor');
  assert.ok(!out.includes('ATTENDEES'), 'metadado não é para o leitor');
  assert.ok(!out.includes('FREQUENCY'), 'metadado não é para o leitor');
  assert.ok(!out.includes('TEMPLATE:'), 'rótulo interno não é para o leitor');
  assert.match(out, /Teve algo novo\?/, 'o conteúdo real tem que sobreviver');
});

test('o título vai em negrito e o corpo vem separado', () => {
  const msg = formatRitualMessage({
    summary: 'Radar de incidentes',
    detail: 'TEMPLATE:\n- Teve algo novo?\nPREP_OFFSET: 0 minutes before',
  });

  assert.match(msg, /<b>Radar de incidentes<\/b>/);
  assert.match(msg, /•\s+Teve algo novo\?/);
});

test('bullets viram lista legível em vez de traço solto', () => {
  const msg = formatRitualMessage({
    summary: 'X',
    detail: '- primeiro\n- segundo\n* terceiro',
  });
  const bullets = (msg.match(/•/g) || []).length;
  assert.equal(bullets, 3, 'cada item deve virar um bullet');
});

test('comando shell vira monospace para toque-e-copia no celular', () => {
  const msg = formatRitualMessage({
    summary: 'Revisão',
    detail: 'Roda isso:\nsqlite3 ~/.config/seal/tasks.db "SELECT 1;"',
  });
  assert.match(msg, /<code>sqlite3/, 'comando precisa ser copiável');
});

test('opções de decisão [A]/[B] ficam destacadas', () => {
  const msg = formatRitualMessage({
    summary: 'Revisão 14 dias',
    detail: '[A] adiciona o terceiro\n[B] ajusta horário',
  });
  assert.match(msg, /<b>\[A\]<\/b>/);
  assert.match(msg, /<b>\[B\]<\/b>/);
});

test('escapa < e & para não quebrar o parse do Telegram', () => {
  // Uma fala transcrita ou template com "<" derrubaria o envio inteiro.
  const msg = formatRitualMessage({
    summary: 'Teste & cia',
    detail: '- rodou <4/10 vezes',
  });
  assert.match(msg, /Teste &amp; cia/);
  assert.match(msg, /&lt;4\/10/);
  assert.ok(!/<4\/10/.test(msg), 'o "<" cru quebraria o HTML');
});

test('ritual sem corpo não gera bloco vazio', () => {
  const msg = formatRitualMessage({ summary: 'Só título', detail: '' });
  assert.match(msg, /<b>Só título<\/b>/);
  assert.ok(!msg.includes('─'), 'sem corpo, não desenha separador órfão');
});
