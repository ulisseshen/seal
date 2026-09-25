import fs from 'fs';
import os from 'os';
import path from 'path';

const SENT_PATH = process.env.SEAL_PR_REVIEW_SENT || path.join(os.homedir(), '.config', 'seal', 'pr-review-sent.json');
const TITLE_MAX = 60;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'oi';

function shortTitle(title) {
  const clean = String(title || '').trim();
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…` : clean;
}

function pendingText(counts = {}) {
  const total = (counts.blocker || 0) + (counts.warning || 0) + (counts.nit || 0);
  const peso = counts.blocker ? ` (${plural(counts.blocker, 'bloqueador', 'bloqueadores')})` : '';
  return { total, text: `${plural(total, 'comentário', 'comentários')}${peso}` };
}

export function chargeMessage({ author, prId, title, url, verdict, counts, reReview = false, priorOpen = 0 }) {
  const name = firstName(author);
  const pr = `!${prId} (${shortTitle(title)})`;
  if (verdict !== 'needs-work') {
    return `${name}, a ${pr} passou na revisão automática${reReview ? ' depois do seu push' : ''}, sem pendências.\n${url}`;
  }
  const { total, text } = pendingText(counts);
  if (reReview) {
    const antes = priorOpen > total ? `; eram ${priorOpen}` : '';
    return `${name}, re-revisei a ${pr} depois do seu push: ainda ${total === 1 ? 'falta' : 'faltam'} ${text}${antes}. Depois do próximo push o bot revisa de novo.\n${url}`;
  }
  return `${name}, a revisão automática da ${pr} terminou: ${text}. Cada comentário traz o prompt de correção; depois do push o bot revisa de novo.\n${url}`;
}

export function chargeKeys(entry) {
  return (entry.needsAction || []).map((item) => `${entry.prId}:${item.reason}:${item.since || ''}`);
}

export function markChargeSent(keys, at = new Date().toISOString(), file = SENT_PATH) {
  let sent = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.sent === 'object') sent = parsed.sent;
  } catch {
    sent = {};
  }
  for (const key of keys) sent[key] = at;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sent }, null, 2));
  fs.renameSync(tmp, file);
  return sent;
}
