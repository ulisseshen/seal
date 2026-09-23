import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-chat-'));
process.env.SEAL_PR_REVIEW_CHAT_REQUESTS = path.join(dir, 'requests');
process.env.SEAL_PR_REVIEW_CHAT_LOG = path.join(dir, 'chat.json');

const chat = await import('../src/sensors/pr-review-chat.js');

test('questions queue oldest first, are logged once, and leave the queue when completed', async () => {
  const first = chat.enqueueChatRequest({ prId: 10116, question: '  por que?  ', source: 'telegram', chatId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  chat.enqueueChatRequest({ prId: 10107, question: 'e o C2?', source: 'panel' });
  const pending = chat.pendingChatRequests();
  assert.deepEqual(pending.map((request) => request.prId), [10116, 10107]);
  assert.equal(pending[0].question, 'por que?');
  assert.deepEqual(chat.readChatLog()['10116'].map((entry) => [entry.role, entry.text]), [['user', 'por que?']]);
  chat.completeChatRequest(pending[0]);
  assert.deepEqual(chat.pendingChatRequests().map((request) => request.id).includes(first.id), false);
  chat.appendChatEntry(10116, { role: 'agent', text: 'porque sim', requestId: first.id });
  assert.deepEqual(chat.readChatLog()['10116'].map((entry) => entry.role), ['user', 'agent']);
});

test('a broken request file is ignored instead of blocking the queue', () => {
  fs.writeFileSync(path.join(process.env.SEAL_PR_REVIEW_CHAT_REQUESTS, '0000-broken.json'), '{nope');
  assert.ok(chat.pendingChatRequests().every((request) => request.prId === 10107));
});
