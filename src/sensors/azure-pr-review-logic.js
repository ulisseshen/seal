/**
 * azure-pr-review-logic — pure decision functions.
 *
 * No I/O, no DB, no fetch — just predicates and parsers. Lets us drive
 * the gate logic in unit tests with plain JS objects without mocking
 * the whole stack.
 */

export const REVIEW_TRIGGERS = [
  'review', 'revise', 'revisa', 'revisar',
  'reviw', 'revies', 'rivew', 'revie',
  'reveja', 'revejam',
];

export const VOTE_MAP = {
  'approved': 10,
  'approved-with-suggestions': 5,
  'needs-work': -5,
  'rejected': -10,
};

export const PENDING_RESOLVES_MARKER = '⏸️ resolves pendentes';
export const VOTED_MARKER = '[seal:voted]';

export function commentDate(comment) {
  return new Date(comment?.publishedDate || comment?.lastUpdatedDate || 0).getTime();
}

export function isMyAuthor(author, myEmail) {
  return (author?.uniqueName || '').toLowerCase() === myEmail;
}

/**
 * Decide if a single comment is a review request.
 * Requires BOTH a mention (azure id or name substring) AND a trigger
 * keyword in the same comment text.
 */
export function isReviewRequestComment(comment, opts) {
  const { myAzureId = '', myName = '', eligibilityStart = 0, sinceTs = 0 } = opts;
  const at = commentDate(comment);
  if (at < eligibilityStart) return false;
  if (at < sinceTs) return false;
  const text = (comment?.content || '').toLowerCase();
  if (!text) return false;
  const hasMention =
    (myAzureId && text.includes(myAzureId)) ||
    (myName && text.includes(myName));
  if (!hasMention) return false;
  return REVIEW_TRIGGERS.some(t => text.includes(t));
}

/**
 * Find the most recent review-request comment across all threads.
 * Returns the comment object, or null.
 */
export function findReviewRequestInThreads(threads, opts) {
  let latest = null;
  let latestAt = 0;
  for (const thread of threads || []) {
    for (const comment of thread.comments || []) {
      if (!isReviewRequestComment(comment, opts)) continue;
      const at = commentDate(comment);
      if (at > latestAt) { latestAt = at; latest = comment; }
    }
  }
  return latest;
}

/**
 * Find my most recent comment that is NOT itself a review-request trigger.
 * Trigger comments are intent (asking for review), not response (answering
 * one) — they shouldn't gate themselves out via the lastMyAt check.
 *
 * Returns the comment object or null.
 */
export function findMyLastCommentInThreads(threads, myEmail, opts = {}) {
  const { myAzureId = '', myName = '', eligibilityStart = 0 } = opts;
  let latest = null;
  let latestAt = 0;
  for (const thread of threads || []) {
    for (const comment of thread.comments || []) {
      if (!isMyAuthor(comment.author, myEmail)) continue;
      // Skip my own trigger comments — those are intent, not response.
      if (myName && isReviewRequestComment(comment, {
        myAzureId, myName, eligibilityStart, sinceTs: 0,
      })) continue;
      const at = commentDate(comment);
      if (at > latestAt) { latestAt = at; latest = comment; }
    }
  }
  return latest;
}

/**
 * Count active threads where I have at least one comment.
 */
export function countOpenThreadsByMeIn(threads, myEmail) {
  let n = 0;
  for (const thread of threads || []) {
    if (thread.status !== 'active' && thread.status !== 1) continue;
    if ((thread.comments || []).some(c => isMyAuthor(c.author, myEmail))) n++;
  }
  return n;
}

/**
 * Core gate decision. Returns one of:
 *   { action: 'skip', reason }
 *   { action: 'first-review', triggerCommentId }
 *   { action: 're-review', triggerCommentId }
 *   { action: 'pending-resolves-notice', openCount }
 *
 * Inputs are plain values — caller is responsible for fetching threads,
 * commits, etc. and passing them in.
 */
export function decideAction({
  threads,
  lastCommitAt,
  myEmail,
  myAzureId = '',
  myName = '',
  eligibilityStart = 0,
}) {
  const lastMyComment = findMyLastCommentInThreads(threads, myEmail, {
    myAzureId, myName, eligibilityStart,
  });
  const lastMyAt = lastMyComment ? commentDate(lastMyComment) : 0;

  // Find the most recent review-request comment globally (not gated by
  // my last fala — my own findings don't match the mention+keyword
  // pattern, so we won't false-trigger off them).
  const reviewReq = findReviewRequestInThreads(threads, {
    myAzureId, myName, eligibilityStart, sinceTs: 0,
  });
  if (!reviewReq) return { action: 'skip', reason: 'no-trigger' };

  const triggerAt = commentDate(reviewReq);

  // First review: I haven't spoken yet on this PR.
  if (!lastMyComment) {
    return { action: 'first-review', triggerCommentId: reviewReq.id, triggerAt };
  }

  // Anti-loop: if my last fala is newer than (or equal to) the latest
  // trigger, the trigger has already been handled — stay silent.
  if (triggerAt <= lastMyAt) {
    return { action: 'skip', reason: 'trigger-already-handled' };
  }

  // Re-review: must have a commit after my last fala AND trigger after that commit.
  const commitFresh = lastCommitAt > lastMyAt;
  const triggerAfterCommit = triggerAt > lastCommitAt;

  if (!commitFresh || !triggerAfterCommit) {
    const openCount = countOpenThreadsByMeIn(threads, myEmail);
    const alreadyComplained =
      lastMyComment && (lastMyComment.content || '').includes(PENDING_RESOLVES_MARKER);
    if (openCount === 0 || alreadyComplained) {
      return { action: 'skip', reason: 'stale-trigger-already-handled' };
    }
    return { action: 'pending-resolves-notice', openCount };
  }

  return { action: 're-review', triggerCommentId: reviewReq.id, triggerAt };
}

/**
 * Parse a "[seal:vote] X" line from a task result. Returns the vote
 * value (Azure DevOps integer) or null if not present / malformed.
 * Looks at the LAST occurrence so the most recent verdict wins.
 */
export function parseVoteFromResult(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\[seal:vote\]\s+([a-z-]+)\s*$/i);
    if (m) {
      const tok = m[1].toLowerCase();
      return tok in VOTE_MAP ? VOTE_MAP[tok] : null;
    }
  }
  return null;
}
