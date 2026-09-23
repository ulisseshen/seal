import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'seal');
export const CHAT_REQUESTS_DIR = process.env.SEAL_PR_REVIEW_CHAT_REQUESTS || path.join(CONFIG_DIR, 'pr-review-chat', 'requests');
export const CHAT_LOG_PATH = process.env.SEAL_PR_REVIEW_CHAT_LOG || path.join(CONFIG_DIR, 'pr-review-chat.json');
const MAX_ENTRIES_PER_PR = 40;

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function enqueueChatRequest({ prId, question, source, chatId = null }) {
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const request = { id, prId: Number(prId), question: String(question).trim(), source, chatId, createdAt: new Date().toISOString() };
  writeAtomic(path.join(CHAT_REQUESTS_DIR, `${id}.json`), JSON.stringify(request, null, 2));
  appendChatEntry(request.prId, { role: 'user', text: request.question, source, at: request.createdAt, requestId: id });
  return request;
}

export function pendingChatRequests() {
  if (!fs.existsSync(CHAT_REQUESTS_DIR)) return [];
  return fs
    .readdirSync(CHAT_REQUESTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      try {
        return { ...JSON.parse(fs.readFileSync(path.join(CHAT_REQUESTS_DIR, name), 'utf8')), file: path.join(CHAT_REQUESTS_DIR, name) };
      } catch {
        return null;
      }
    })
    .filter((request) => request && Number.isFinite(request.prId) && request.question);
}

export function completeChatRequest(request) {
  fs.rmSync(request.file, { force: true });
}

export function readChatLog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CHAT_LOG_PATH, 'utf8'));
    return parsed && typeof parsed.prs === 'object' ? parsed.prs : {};
  } catch {
    return {};
  }
}

export function appendChatEntry(prId, entry) {
  const prs = readChatLog();
  const key = String(prId);
  prs[key] = [...(prs[key] || []), entry].slice(-MAX_ENTRIES_PER_PR);
  writeAtomic(CHAT_LOG_PATH, JSON.stringify({ prs }, null, 2));
}
