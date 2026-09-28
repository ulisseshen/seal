import test from 'node:test';
import assert from 'node:assert/strict';
import { readyToRestart } from '../src/restart-request.js';

test('the runner restarts only with no task running and no review being published', () => {
  assert.equal(readyToRestart({ runningTasks: 0, publishingReviews: 0 }), true);
  assert.equal(readyToRestart({ runningTasks: 1, publishingReviews: 0 }), false);
  assert.equal(readyToRestart({ runningTasks: 0, publishingReviews: 1 }), false);
});
