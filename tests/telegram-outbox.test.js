import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-outbox-'));
process.env.SEAL_DB_PATH = path.join(dir, 'tasks.db');

const outbox = await import('../src/telegram-outbox.js');

test('every Telegram send is recorded with its source, text and outcome, and can be summarised by source', async () => {
  await outbox.recordTelegram({ source: 'pr-review', text: '✅ !1 revisada', ok: true });
  await outbox.recordTelegram({ source: 'pr-review', text: '✅ !2 revisada', ok: true });
  await outbox.recordTelegram({ source: 'approval', text: '💬 Enviar no Teams?', ok: false });
  const recent = await outbox.recentTelegram({ hours: 1 });
  assert.equal(recent.length, 3);
  assert.deepEqual(recent[0].source, 'approval');
  assert.equal(recent[0].ok, 0);
  assert.deepEqual(await outbox.telegramVolume({ hours: 1 }), [
    { source: 'pr-review', sent: 2, failed: 0 },
    { source: 'approval', sent: 0, failed: 1 },
  ]);
});

test('recording never throws, even with no text', async () => {
  await outbox.recordTelegram({ source: 'x' });
  assert.equal((await outbox.recentTelegram({ hours: 1 })).length, 4);
});

const { db } = await import('../src/db.js');

test('a new offer for a PR supersedes the older pending offers of the same PR and nothing else', async () => {
  await db.run(`CREATE TABLE IF NOT EXISTS pending_actions (id TEXT PRIMARY KEY, action_name TEXT, context TEXT, preview_summary TEXT, preview_details TEXT, preview_impact TEXT, status TEXT, created_at TEXT, confirmed_at TEXT, confirmed_by TEXT, executed_at TEXT, result TEXT)`);
  const add = (id, prId, status = 'pending', name = 'cobranca') => db.run(`INSERT INTO pending_actions (id, action_name, context, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))`, [id, name, JSON.stringify({ prId }), status]);
  await add('a', 10125);
  await add('b', 10125);
  await add('c', 10128);
  await add('d', 10125, 'executed');
  await add('e', 10125, 'pending', 'mensagem');
  assert.equal(await outbox.supersedePendingOffers({ actionName: 'cobranca', prId: 10125 }), 2);
  const status = Object.fromEntries((await db.all(`SELECT id, status FROM pending_actions`)).map((row) => [row.id, row.status]));
  assert.deepEqual(status, { a: 'expired', b: 'expired', c: 'pending', d: 'executed', e: 'pending' });
});

test('the digest slot is due once per slot, at or after 12h and 18h in São Paulo', () => {
  const at = (iso) => new Date(iso).getTime();
  assert.equal(outbox.dueDigestSlot({ now: at('2026-09-25T14:59:00Z'), lastFlushAt: null }), null);
  assert.equal(outbox.dueDigestSlot({ now: at('2026-09-25T15:00:00Z'), lastFlushAt: null }), '2026-09-25T12');
  assert.equal(outbox.dueDigestSlot({ now: at('2026-09-25T16:00:00Z'), lastFlushAt: at('2026-09-25T15:01:00Z') }), null);
  assert.equal(outbox.dueDigestSlot({ now: at('2026-09-25T21:05:00Z'), lastFlushAt: at('2026-09-25T15:01:00Z') }), '2026-09-25T18');
  assert.equal(outbox.dueDigestSlot({ now: at('2026-09-26T02:00:00Z'), lastFlushAt: at('2026-09-25T21:06:00Z') }), null);
  assert.equal(outbox.dueDigestSlot({ now: at('2026-09-26T15:30:00Z'), lastFlushAt: at('2026-09-25T21:06:00Z') }), '2026-09-26T12');
});

test('queued digest lines go out together once the slot is due, and only once', async () => {
  await outbox.queueDigest('✅ !1 aprovada');
  await outbox.queueDigest('✅ !2 aprovada');
  const sent = [];
  const send = async (text) => { sent.push(text); return true; };
  assert.equal(await outbox.flushDigestIfDue({ send, now: new Date('2026-09-25T14:00:00Z').getTime() }), false);
  assert.equal(await outbox.flushDigestIfDue({ send, now: new Date('2026-09-25T15:10:00Z').getTime() }), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /!1 aprovada[\s\S]*!2 aprovada/);
  assert.equal(await outbox.flushDigestIfDue({ send, now: new Date('2026-09-25T15:20:00Z').getTime() }), false);
  assert.equal(sent.length, 1);
});

test('a long digest is split into messages under the Telegram limit, never cutting an item', () => {
  const items = Array.from({ length: 16 }, (_, i) => `item ${i} ${'x'.repeat(600)}`);
  const parts = outbox.digestMessages(items, { limit: 3800, title: '🗞️ Resumo' });
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 3800, part.length);
  assert.match(parts[0], /^🗞️ Resumo \(16\)/);
  assert.match(parts[1], /^🗞️ Resumo \(16\) · 2\/\d+/);
  assert.equal(parts.join('\n').match(/item \d+/g).length, 16);
  const huge = outbox.digestMessages(['y'.repeat(5000)], { limit: 3800, title: 'T' });
  assert.ok(huge[0].length <= 3800);
});

test('a digest part Telegram refuses as HTML goes out as plain text instead of repeating the digest', async () => {
  await outbox.queueDigest('<b>quebrado</b> <a href="x">!9');
  const sent = [];
  const send = async (text) => { sent.push(text); return !/<a href="x">!9$/.test(text); };
  assert.equal(await outbox.flushDigestIfDue({ send, now: new Date('2026-09-26T15:10:00Z').getTime() }), true);
  assert.equal(sent.length, 2);
  assert.doesNotMatch(sent[1], /<[^>]*>?/);
  assert.match(sent[1], /quebrado !9/);
  assert.equal(await outbox.flushDigestIfDue({ send, now: new Date('2026-09-26T16:10:00Z').getTime() }), false);
});

test('a single line longer than the limit is cut as plain text, never inside an HTML tag', () => {
  const html = `📣 <b>PRs</b> ${'<a href="https://x/y">!1 título</a> '.repeat(300)}`;
  const parts = outbox.digestMessages([html], { limit: 3800, title: 'T' });
  for (const part of parts) {
    assert.ok(part.length <= 3800);
    assert.doesNotMatch(part, /<a href/);
  }
});

test('each part marks its own items as sent, a failing part is retried as plain text once and then dropped, never resent', async () => {
  await db.run(`DELETE FROM telegram_digest`);
  for (let i = 0; i < 6; i++) await outbox.queueDigest(`item ${i} ${'x'.repeat(1500)}`);
  const sent = [];
  let calls = 0;
  const send = async (text) => { calls++; if (calls === 3 || calls === 4) return false; sent.push(text); return true; };
  const at = new Date('2026-09-25T21:10:00Z').getTime();
  assert.equal(await outbox.flushDigestIfDue({ send, now: at }), true);
  const pending = await db.get(`SELECT COUNT(*) AS n FROM telegram_digest WHERE flushed_at IS NULL`);
  assert.equal(pending.n, 0);
  const again = [];
  assert.equal(await outbox.flushDigestIfDue({ send: async (t) => { again.push(t); return true; }, now: at + 60_000 }), false);
  assert.equal(again.length, 0);
});
