// Testes do roteador de voz.
//
// O Ulisses responde os rituais "na sequência": manda um áudio no Telegram sem
// dizer a que ritual se refere. O roteador decide pelo CONTEÚDO.
//
// Estes testes cobrem a heurística determinística — a camada que roda sem IA e
// que é o fallback quando o provider cai. Isso importa porque a IA do SEAL já
// caiu inteira uma vez (chat-config com model gpt-5 que o codex rejeitava), e
// nesse cenário o roteador precisa continuar acertando os casos óbvios em vez
// de perder a resposta do usuário.

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyByHeuristic, renderStructured } from '../src/brain/route-voice.js';

test('reconhece um TL Log típico pelo enquadramento retrospectivo', () => {
  const fala =
    'Hoje eu aprendi que o fluxo de pedido passa por dois contratos diferentes ' +
    'antes de bater no backend. O risco que apareceu é que ninguém documentou ' +
    'isso. Decidi que amanhã vou pedir pro Felipe desenhar o fluxo.';

  const r = classifyByHeuristic(fala);
  assert.equal(r.kind, 'tl-log');
  assert.ok(r.confidence >= 0.7, `confiança deveria bastar sem IA, veio ${r.confidence}`);
});

test('reconhece um radar de incidentes pelo tom de triagem', () => {
  const fala =
    'Teve um incidente no Flutter legado, caiu o login de uns clientes. ' +
    'O impacto é médio, a hipótese é token expirando cedo, o Hugo já atuou.';

  const r = classifyByHeuristic(fala);
  assert.equal(r.kind, 'radar');
  assert.ok(r.confidence >= 0.7, `confiança deveria bastar sem IA, veio ${r.confidence}`);
});

test('NÃO classifica como radar só porque o TL Log menciona incidente', () => {
  // Este é o erro que mais importa evitar: um TL Log honesto quase sempre cita
  // o incidente do dia. Se a menção sozinha bastasse, todo TL Log viraria radar
  // e a contagem da revisão de 25/08 sairia errada.
  const fala =
    'Aprendi bastante hoje sobre como o incidente de ontem se propagou. ' +
    'A decisão foi adicionar log no backend. Ajudei a Carla com o teste.';

  const r = classifyByHeuristic(fala);
  assert.notEqual(r.kind, 'radar', 'menção a incidente não pode sequestrar o TL Log');
});

test('texto vago não é chutado — devolve unknown para o SEAL perguntar', () => {
  // Áudio curto e ambíguo deve virar pergunta, não palpite. Chutar em silêncio
  // corrompe o dado exatamente onde ele importa.
  for (const vago of ['foi tranquilo hoje', 'nada demais', 'depois eu falo']) {
    const r = classifyByHeuristic(vago);
    assert.equal(r.kind, 'unknown', `"${vago}" deveria ser unknown`);
    assert.ok(r.confidence < 0.6, 'confiança baixa obriga o SEAL a perguntar');
  }
});

test('empate entre os dois vira unknown, não um chute', () => {
  const ambiguo = 'Teve incidente e eu aprendi uma coisa com isso.';
  const r = classifyByHeuristic(ambiguo);
  assert.equal(r.kind, 'unknown');
});

test('renderStructured monta o TL Log só com os campos preenchidos', () => {
  // Log com 2 de 6 campos é log honesto. Não pode inventar linha vazia por
  // simetria — a ausência é sinal para a revisão.
  const out = renderStructured('tl-log', {
    aprendizado: 'o fluxo passa por dois contratos',
    risco: null,
    decisao: null,
    prevencao: null,
    ajudei: 'Carla',
    amanha: null,
  }, 'cru');

  assert.match(out, /Aprendi: o fluxo passa por dois contratos/);
  assert.match(out, /Ajudei: Carla/);
  assert.ok(!out.includes('Risco:'), 'campo vazio não deve aparecer');
  assert.ok(!out.includes('Amanhã:'), 'campo vazio não deve aparecer');
});

test('renderStructured trata "nada novo" como radar válido', () => {
  // "Não teve nada hoje" é ritual CUMPRIDO — o valor está em ter olhado.
  const out = renderStructured('radar', { nada_novo: true, incidentes: [] }, 'cru');
  assert.match(out, /Nada novo/);
});

test('renderStructured lista incidentes com os campos que existem', () => {
  const out = renderStructured('radar', {
    nada_novo: false,
    incidentes: [
      { o_que: 'login caindo', impacto: 'uns clientes', sistema: 'flutter', dono: null, hipotese: 'token expirando', proximo_passo: null },
    ],
  }, 'cru');

  assert.match(out, /login caindo/);
  assert.match(out, /impacto: uns clientes/);
  assert.match(out, /hipótese: token expirando/);
  assert.ok(!out.includes('dono:'), 'campo nulo não deve aparecer');
});

test('sem estrutura, cai para o texto cru em vez de perder a resposta', () => {
  const out = renderStructured('tl-log', null, 'o texto original falado');
  assert.equal(out, 'o texto original falado');
});
