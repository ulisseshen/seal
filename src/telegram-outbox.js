import { db } from './db.js';

await db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    source TEXT NOT NULL,
    text TEXT,
    ok INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_telegram_outbox_at ON telegram_outbox(at);
  CREATE TABLE IF NOT EXISTS telegram_digest (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    text TEXT NOT NULL,
    flushed_at TEXT
  );
`);

export async function recordTelegram({ source, text = '', ok = true }) {
  try {
    await db.run(`INSERT INTO telegram_outbox (source, text, ok) VALUES (?, ?, ?)`, [source || 'unknown', String(text ?? ''), ok ? 1 : 0]);
  } catch (err) {
    console.warn(`[telegram-outbox] não registrei o envio: ${err.message}`);
  }
}

const since = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

export async function recentTelegram({ hours = 24, limit = 500 } = {}) {
  return db.all(`SELECT id, at, source, text, ok FROM telegram_outbox WHERE at >= ? ORDER BY id DESC LIMIT ?`, [since(hours), limit]);
}

export async function telegramVolume({ hours = 24 } = {}) {
  const rows = await db.all(
    `SELECT source, SUM(ok) AS sent, SUM(1 - ok) AS failed FROM telegram_outbox WHERE at >= ? GROUP BY source ORDER BY COUNT(*) DESC, source`,
    [since(hours)],
  );
  return rows.map((row) => ({ source: row.source, sent: Number(row.sent), failed: Number(row.failed) }));
}

export async function supersedePendingOffers({ actionName, prId }) {
  const result = await db.run(
    `UPDATE pending_actions SET status = 'expired', result = 'substituída por uma oferta mais nova da mesma PR'
     WHERE status = 'pending' AND action_name = ? AND json_extract(context, '$.prId') = ?`,
    [actionName, Number(prId)],
  );
  return result?.changes ?? result?.rowsAffected ?? 0;
}

const DIGEST_HOURS = [12, 18];
const SAO_PAULO_OFFSET = '-03:00';

function saoPauloParts(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function dueDigestSlot({ now = Date.now(), lastFlushAt = null } = {}) {
  const { date, hour } = saoPauloParts(now);
  const slotHour = [...DIGEST_HOURS].reverse().find((candidate) => hour >= candidate);
  if (slotHour === undefined) return null;
  const label = `${date}T${String(slotHour).padStart(2, '0')}`;
  const slotStart = Date.parse(`${label}:00:00${SAO_PAULO_OFFSET}`);
  return lastFlushAt && lastFlushAt >= slotStart ? null : label;
}

const TELEGRAM_SAFE_LIMIT = 3800;

export const plainDigestText = (text) => String(text || '').replace(/<[^>]*>?/g, '');

// A long item is split on line breaks (each bullet is one line with its own closed tags), never mid-tag:
// a cut inside `<a href=…>` makes Telegram refuse the whole message.

const stripHtml = (text) => String(text).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function clipItem(item, max) {
  if (item.length <= max) return item;
  const plain = stripHtml(item);
  return escapeHtml(plain.length > max - 1 ? `${plain.slice(0, max - 1)}…` : plain);
}

export function digestParts(items, { limit = TELEGRAM_SAFE_LIMIT, title }) {
  const groups = [];
  let current = [];
  let size = 0;
  const max = limit - 200;
  const pieces = [];
  for (const [index, raw] of items.entries()) {
    if (raw.length <= max) { pieces.push({ index, text: raw }); continue; }
    let chunk = [];
    let chunkSize = 0;
    for (const line of raw.split('\n').map((l) => clipItem(l, max))) {
      if (chunk.length && chunkSize + line.length + 1 > max) {
        pieces.push({ index, text: chunk.join('\n') });
        chunk = [];
        chunkSize = 0;
      }
      chunk.push(line);
      chunkSize += line.length + 1;
    }
    if (chunk.length) pieces.push({ index, text: chunk.join('\n') });
  }
  for (const piece of pieces) {
    if (current.length && size + piece.text.length + 2 > limit - 120) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(piece);
    size += piece.text.length + 2;
  }
  if (current.length) groups.push(current);
  return groups.map((group, n) => ({
    indexes: [...new Set(group.map((entry) => entry.index))],
    text: [groups.length > 1 && n > 0 ? `${title} (${items.length}) · ${n + 1}/${groups.length}` : `${title} (${items.length})`, ...group.map((entry) => entry.text)].join('\n\n'),
  }));
}

export const digestMessages = (items, options) => digestParts(items, options).map((part) => part.text);

export async function queueDigest(text) {
  await db.run(`INSERT INTO telegram_digest (text) VALUES (?)`, [String(text)]);
}

export async function flushDigestIfDue({ send, now = Date.now() }) {
  const queued = await db.all(`SELECT id, text FROM telegram_digest WHERE flushed_at IS NULL ORDER BY id`);
  if (queued.length === 0) return false;
  const last = await db.get(`SELECT MAX(flushed_at) AS at FROM telegram_digest`);
  if (!dueDigestSlot({ now, lastFlushAt: last?.at ? Date.parse(last.at) : null })) return false;
  const stamp = new Date(now).toISOString();
  for (const part of digestParts(queued.map((row) => row.text), { title: '🗞️ Resumo das revisões' })) {
    const ok = (await send(part.text)) || (await send(escapeHtml(stripHtml(part.text))));
    if (!ok) console.warn(`[telegram-outbox] parte do resumo descartada depois de 2 tentativas (${part.indexes.length} itens)`);
    const ids = part.indexes.map((index) => queued[index].id);
    await db.run(`UPDATE telegram_digest SET flushed_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [stamp, ...ids]);
  }
  return true;
}
