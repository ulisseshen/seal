import fs from 'fs';
import os from 'os';
import path from 'path';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'seal');
export const PR_REVIEW_STATE_PATH = process.env.SEAL_PR_REVIEW_STATE || path.join(CONFIG_DIR, 'pr-review-state.json');
const GATEWAY_PATH = path.join(CONFIG_DIR, 'gateway.json');
const SENT_PATH = process.env.SEAL_PR_REVIEW_SENT || path.join(CONFIG_DIR, 'pr-review-sent.json');

export function readSentMarks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SENT_PATH, 'utf8'));
    return parsed && typeof parsed.sent === 'object' ? parsed.sent : {};
  } catch {
    return {};
  }
}

const CLOSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function readReviewState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PR_REVIEW_STATE_PATH, 'utf8'));
    return { updatedAt: parsed.updatedAt || null, prs: parsed.prs && typeof parsed.prs === 'object' ? parsed.prs : {} };
  } catch {
    return { updatedAt: null, prs: {} };
  }
}

export function writeReviewState(state, now = Date.now()) {
  for (const [prId, entry] of Object.entries(state.prs)) {
    if (entry.status !== 'active' && entry.closedAt && now - new Date(entry.closedAt).getTime() > CLOSED_RETENTION_MS) {
      delete state.prs[prId];
    }
  }
  const next = { updatedAt: new Date(now).toISOString(), prs: state.prs };
  const tmp = `${PR_REVIEW_STATE_PATH}.tmp`;
  fs.mkdirSync(path.dirname(PR_REVIEW_STATE_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, PR_REVIEW_STATE_PATH);
  return next;
}

export function upsertPrEntry(state, pr, repoName, org, project) {
  const prId = String(pr.pullRequestId);
  const previous = state.prs[prId] || {};
  const authorName = pr.createdBy?.displayName || previous.author || '';
  state.prs[prId] = {
    notified: {},
    needsAction: [],
    ...previous,
    prId: pr.pullRequestId,
    repo: repoName,
    title: pr.title,
    author: authorName,
    authorFirstName: authorName.split(' ')[0] || authorName,
    authorEmail: (pr.createdBy?.uniqueName || '').toLowerCase(),
    url: `https://dev.azure.com/${org}/${project}/_git/${repoName}/pullrequest/${pr.pullRequestId}`,
    createdAt: pr.creationDate,
    status: pr.status || 'active',
    isDraft: Boolean(pr.isDraft),
  };
  return state.prs[prId];
}

function readTelegramTarget() {
  try {
    const gateway = JSON.parse(fs.readFileSync(GATEWAY_PATH, 'utf8'));
    const channel = gateway?.channels?.telegram;
    if (channel?.token && channel?.chatId) return { token: channel.token, chatId: channel.chatId };
  } catch {}
  return null;
}

export const escapeHtml = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendTelegram(html) {
  if (process.env.SEAL_AZURE_TEST_DRY === '1') {
    console.log(`[pr-review] [dry] WOULD SEND telegram:\n${html}`);
    return false;
  }
  const target = readTelegramTarget();
  if (!target) {
    console.warn('[pr-review] telegram not configured in gateway.json — notification dropped');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${target.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target.chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.warn(`[pr-review] telegram ${res.status}: ${await res.text().catch(() => '')}`);
    return res.ok;
  } catch (err) {
    console.warn(`[pr-review] telegram send failed: ${err.message}`);
    return false;
  }
}
