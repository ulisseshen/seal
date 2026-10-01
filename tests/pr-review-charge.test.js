import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chargeMessage, chargeKeys, markChargeSent, shouldOfferCharge } from '../src/sensors/pr-review-charge.js';
import { TeamsConnector } from '../src/messaging/teams.js';
import { SendChargeAction } from '../src/actions/send-charge.js';
import { ActionRegistry } from '../src/actions/registry.js';

const base = {
  author: 'Bruno Lima Costa', prId: 10110, title: 'Ajuste no cadastro',
  url: 'https://dev.azure.com/org/Projeto/_git/app-web/pullrequest/10110',
};

test('primeira revisão com pendências diz quantas e o que fazer', () => {
  const msg = chargeMessage({ ...base, verdict: 'needs-work', counts: { blocker: 1, warning: 1, nit: 0 } });
  assert.match(msg, /^Bruno, a revisão automática da !10110 \(Ajuste no cadastro\) terminou: 2 comentários \(1 bloqueador\)\./);
  assert.match(msg, /depois do push o bot revisa de novo/);
  assert.ok(msg.endsWith(base.url));
});

test('re-revisão diz quanto ainda falta e quanto era antes', () => {
  const msg = chargeMessage({ ...base, verdict: 'needs-work', counts: { warning: 2 }, reReview: true, priorOpen: 5 });
  assert.match(msg, /re-revisei a !10110 .* depois do seu push: ainda faltam 2 comentários; eram 5\./);
});

test('re-revisão com um comentário usa singular', () => {
  const msg = chargeMessage({ ...base, verdict: 'needs-work', counts: { blocker: 1 }, reReview: true, priorOpen: 1 });
  assert.match(msg, /ainda falta 1 comentário \(1 bloqueador\)\./);
  assert.doesNotMatch(msg, /eram/);
});

test('aprovada avisa que passou', () => {
  assert.match(chargeMessage({ ...base, verdict: 'approved', counts: {}, reReview: true }),
    /^Bruno, a !10110 .* passou na revisão automática depois do seu push, sem pendências\./);
});

test('título longo é cortado', () => {
  const msg = chargeMessage({ ...base, title: 'x'.repeat(120), verdict: 'approved', counts: {} });
  assert.ok(msg.includes('x'.repeat(59) + '…'));
});

test('chaves de enviada seguem o formato do painel', () => {
  const entry = { prId: 10110, needsAction: [{ reason: 'blocker', since: '2026-09-25T10:00:00.000Z' }] };
  assert.deepEqual(chargeKeys(entry), ['10110:blocker:2026-09-25T10:00:00.000Z']);
});

test('marca enviada sem apagar marcas anteriores', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seal-sent-')), 'sent.json');
  fs.writeFileSync(file, JSON.stringify({ sent: { 'old:x:': '2026-01-01' } }));
  markChargeSent(['10110:blocker:t'], '2026-09-25T10:05:00Z', file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sent, { 'old:x:': '2026-01-01', '10110:blocker:t': '2026-09-25T10:05:00Z' });
});

test('conector do Teams manda para o teamsbot o e-mail e o texto', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, to: 'Bruno Lima Costa', sentAt: '2026-09-25T10:05:00Z' }) };
  };
  const teams = new TeamsConnector({ url: 'http://127.0.0.1:4317/', fetchImpl });
  const res = await teams.sendDirect({ name: 'Bruno Lima Costa', email: 'bruno.costa@example.com' }, 'oi');
  assert.equal(calls[0].url, 'http://127.0.0.1:4317/api/send');
  assert.deepEqual(calls[0].body, { to: 'bruno.costa@example.com', message: 'oi', html: 'oi', headless: true });
  assert.equal(res.sentAt, '2026-09-25T10:05:00Z');
});

test('conector do Teams propaga a recusa do teamsbot', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'Refusing to send: open chat header does not match' }) });
  const teams = new TeamsConnector({ fetchImpl });
  await assert.rejects(teams.sendDirect({ name: 'Bruno' }, 'oi'), /header does not match/);
});

function fakeConnector({ fail } = {}) {
  const sent = [];
  return {
    sent,
    connector: {
      id: 'fake', label: 'Fake', supports: () => true,
      sendDirect: async (person, text) => {
        if (fail) throw new Error(fail);
        sent.push({ person, text });
        return { ok: true, sentAt: '2026-09-25T10:05:00Z' };
      },
    },
  };
}

test('ação envia e só então marca como enviada', async () => {
  const fake = fakeConnector();
  const marked = [];
  const action = new SendChargeAction({ connectorFor: () => fake.connector, markSent: (keys) => marked.push(...keys) });
  const preview = await action.preview({ author: { name: 'Bruno Lima Costa' }, message: 'texto' });
  assert.equal(preview.summary, '💬 Enviar no Fake para Bruno Lima Costa?');
  assert.equal(preview.details, 'texto');
  const result = await action.execute({ author: { name: 'Bruno Lima Costa' }, message: 'texto', sentKeys: ['k1'] });
  assert.equal(result.success, true);
  assert.deepEqual(fake.sent, [{ person: { name: 'Bruno Lima Costa' }, text: 'texto' }]);
  assert.deepEqual(marked, ['k1']);
});

test('falha no envio não marca como enviada', async () => {
  const fake = fakeConnector({ fail: 'teamsbot fora do ar' });
  const marked = [];
  const action = new SendChargeAction({ connectorFor: () => fake.connector, markSent: (keys) => marked.push(...keys) });
  const result = await action.execute({ author: { name: 'Bruno' }, message: 'x', sentKeys: ['k1'] });
  assert.equal(result.success, false);
  assert.match(result.message, /teamsbot não respondeu/);
  assert.deepEqual(marked, []);
});

function memoryDb() {
  const rows = new Map();
  return {
    rows,
    async run(sql, params) {
      if (/^\s*INSERT INTO pending_actions/i.test(sql)) {
        const [id, action_name, context] = params;
        rows.set(id, { id, action_name, context, status: 'pending' });
      } else if (/SET status = 'confirmed'/.test(sql)) rows.get(params[2]).status = 'confirmed';
      else if (/SET status = 'executed'/.test(sql)) rows.get(params[2]).status = 'executed';
      else if (/SET status = 'error'/.test(sql)) rows.get(params[1]).status = 'error';
      else if (/SET status = 'denied'/.test(sql)) rows.get(params[2]).status = 'denied';
      else if (/SET status = \? WHERE id/.test(sql)) rows.get(params[1]).status = params[0];
      return { changes: 1 };
    },
    async get(_sql, params) { return rows.get(params[0]); },
  };
}

function gatewayStub({ rejectWith } = {}) {
  const messages = [];
  let orphan = null;
  return {
    messages,
    clickAfterRestart: (actionId, choice) => orphan(actionId, { choice, confirmedBy: 'ulisses' }),
    onMessage() {},
    onOrphanConfirmation(handler) { orphan = handler; },
    confirm: () => (rejectWith ? Promise.reject(new Error(rejectWith)) : new Promise(() => {})),
    send: async (msg) => { messages.push(msg.text); },
  };
}

test('clique em Enviar depois de um restart ainda envia', async () => {
  const db = memoryDb();
  const gateway = gatewayStub();
  const fake = fakeConnector();
  const registry = new ActionRegistry(db, gateway, null);
  registry.register(new SendChargeAction({ connectorFor: () => fake.connector, markSent: () => {} }));
  registry.setupGatewayCallbacks();
  const id = await registry.trigger('cobranca', { author: { name: 'Bruno Lima Costa' }, message: 'texto' });
  await gateway.clickAfterRestart(id, 'approve');
  assert.equal(fake.sent.length, 1);
  assert.equal(db.rows.get(id).status, 'executed');
  assert.match(gateway.messages.at(-1), /enviada para Bruno no Fake/);
});

test('desligar o SEAL não expira a cobrança pendente', async () => {
  const db = memoryDb();
  const gateway = gatewayStub({ rejectWith: 'Gateway shutting down' });
  const registry = new ActionRegistry(db, gateway, null);
  registry.register(new SendChargeAction({ connectorFor: () => fakeConnector().connector, markSent: () => {} }));
  const id = await registry.trigger('cobranca', { author: { name: 'Bruno' }, message: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(db.rows.get(id).status, 'pending');
});

import { friendlyError } from '../src/actions/send-charge.js';
import { upsertPrEntry } from '../src/sensors/pr-review-state.js';

test('conector do Teams manda pelo e-mail quando tem, não pelo nome do Azure', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const teams = new TeamsConnector({ fetchImpl });
  await teams.sendDirect({ name: 'Diego Rocha Nunes', email: 'diego.nunes@example.com' }, 'oi');
  assert.equal(calls[0].to, 'diego.nunes@example.com');
});

test('recusa do Teams vira aviso claro e não marca como enviada', async () => {
  const marked = [];
  const connector = {
    id: 'teams', label: 'Microsoft Teams', supports: () => true,
    sendDirect: async () => { throw new Error('Refusing to send to "Bruno": open chat header does not match this person.'); },
  };
  const action = new SendChargeAction({ connectorFor: () => connector, markSent: (keys) => marked.push(...keys) });
  const result = await action.execute({ author: { name: 'Diego Rocha Nunes' }, message: 'x', sentKeys: ['k'] });
  assert.equal(result.success, false);
  assert.match(result.message, /não enviei para Diego: o Teams abriu uma conversa que não era dessa pessoa/);
  assert.match(result.message, /Nada foi enviado/);
  assert.deepEqual(marked, []);
  assert.match(friendlyError('Teams web session is not authenticated. Open the login browser first.'), /sessão do Teams web caiu/);
});

test('se a consulta da PR falhar, o e-mail do autor não se perde', () => {
  const state = { prs: {} };
  upsertPrEntry(state, { pullRequestId: 10110, title: 't', status: 'active', createdBy: { displayName: 'Bruno Lima Costa', uniqueName: 'Bruno.Costa@example.com' } }, 'app-web', 'org', 'Projeto');
  const entry = upsertPrEntry(state, { pullRequestId: 10110, title: 't', status: 'active' }, 'app-web', 'org', 'Projeto');
  assert.equal(entry.authorEmail, 'bruno.costa@example.com');
});

test('oferta que o Telegram não entregou é reenviada, não expira', async () => {
  const db = memoryDb();
  let calls = 0;
  const gateway = {
    onMessage() {}, onOrphanConfirmation() {},
    confirm: () => { calls += 1; return calls === 1 ? Promise.reject(new Error('EFATAL: Error: read EADDRNOTAVAIL')) : new Promise(() => {}); },
    send: async () => {},
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return 0; };
  try {
    const registry = new ActionRegistry(db, gateway, null);
    registry.register(new SendChargeAction({ connectorFor: () => fakeConnector().connector, markSent: () => {} }));
    const id = await registry.trigger('cobranca', { author: { name: 'Bruno' }, message: 'x' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(db.rows.get(id).status, 'pending');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('conector resolve a pessoa pelo teamsbot e manda pelo e-mail resolvido', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    if (url.includes('/api/people/resolve')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, status: 'ok', person: { name: 'Diego Rocha Nunes', email: 'diego.nunes@example.com' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const teams = new TeamsConnector({ fetchImpl });
  await teams.sendDirect({ name: 'Diego Nunes' }, 'oi');
  assert.match(calls[0].url, /\/api\/people\/resolve\?q=Diego%20Nunes$/);
  assert.equal(calls[1].body.to, 'diego.nunes@example.com');
});

test('nome ambíguo não envia para ninguém', async () => {
  const sends = [];
  const fetchImpl = async (url, opts) => {
    if (url.includes('/api/people/resolve')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, status: 'ambiguous', candidates: [{ name: 'A' }, { name: 'B' }] }) };
    }
    sends.push(opts);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const teams = new TeamsConnector({ fetchImpl });
  await assert.rejects(teams.sendDirect({ name: 'Bruno' }, 'oi'), /bate com 2 pessoas/);
  assert.equal(sends.length, 0);
});

test('ação mensagem mostra destinatário com e-mail e quem pediu', async () => {
  const action = new SendChargeAction({ name: 'mensagem', connectorFor: () => fakeConnector().connector, markSent: () => {} });
  assert.equal(action.name, 'mensagem');
  const preview = await action.preview({ author: { name: 'Diego Nunes', email: 'diego.nunes@example.com' }, message: 'oi', origin: 'sessão do Claude Code (MCP do Teams)' });
  assert.match(preview.summary, /para Diego Nunes <diego\.nunes@example\.com>\?\nPedido por: sessão do Claude Code/);
});

test('a re-review with no new finding is only informative: no charge is offered to send', () => {
  assert.equal(shouldOfferCharge({ verdict: 'needs-work', counts: {}, reReview: true }), false);
  assert.equal(shouldOfferCharge({ verdict: 'needs-work', counts: { warning: 0, blocker: 0 }, reReview: true }), false);
  assert.equal(shouldOfferCharge({ verdict: 'needs-work', counts: { warning: 1 }, reReview: true }), true);
  assert.equal(shouldOfferCharge({ verdict: 'needs-work', counts: { blocker: 2 }, reReview: false }), true);
  assert.equal(shouldOfferCharge({ verdict: 'approved', counts: {}, reReview: true }), false);
  assert.equal(shouldOfferCharge({ verdict: 'approved', counts: {}, reReview: false }), false);
});
