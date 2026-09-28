import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBroadcastLifecycle } from '../src/lifecycle-broadcast.js';

test('PR review tasks and their parts never broadcast their lifecycle, the review sensor already reports them', () => {
  for (const phase of ['start', 'done', 'failed']) {
    assert.equal(shouldBroadcastLifecycle({ id: 'seal_pr_44966', notify_channel: 'system' }, phase), false, phase);
    assert.equal(shouldBroadcastLifecycle({ id: 'seal_pr_44966_p2', notify_channel: 'system' }, phase), false, phase);
  }
});

test('a task already delivered straight to Telegram is not broadcast again to Telegram', () => {
  assert.equal(shouldBroadcastLifecycle({ id: 'abc', notify_channel: 'telegram' }, 'done'), false);
});

test('other tasks keep their lifecycle broadcast', () => {
  assert.equal(shouldBroadcastLifecycle({ id: 'abc', notify_channel: 'system' }, 'failed'), true);
  assert.equal(shouldBroadcastLifecycle({ id: 'abc', notify_channel: 'system' }, 'done'), false);
  assert.equal(shouldBroadcastLifecycle({ id: 'abc', notify_channel: 'system' }, 'start'), false);
  assert.equal(shouldBroadcastLifecycle({ id: 'abc', notify_channel: 'discord' }, 'failed'), true);
});

test('technical preparation drafts are reported by the panel, not broadcast', () => {
  assert.equal(shouldBroadcastLifecycle({ id: 'seal_prep_74148_abc', notify_channel: 'system' }, 'done'), false);
});
