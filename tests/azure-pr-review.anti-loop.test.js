// Anti-loop tests for the azure-pr-review gate logic.
//
// Drives the pure decision functions in src/sensors/azure-pr-review-logic.js
// with hand-built thread/commit fixtures. No DB, no network, no claude.
// Goal: prove the gate cannot enter a loop where a single comment makes
// us re-trigger reviews indefinitely.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideAction,
  parseVoteFromResult,
  findReviewRequestInThreads,
  PENDING_RESOLVES_MARKER,
} from '../src/sensors/azure-pr-review-logic.js';

const MY_EMAIL = 'ulisses.hen@yandeh.com';
const MY_NAME = 'ulisses';
const SOMEONE = 'colega@yandeh.com';
const ELIGIBILITY_START = new Date('2026-04-30T00:00:00Z').getTime();

const t = (iso) => new Date(iso).getTime();

function comment({ id, author, content, date, by = SOMEONE }) {
  return {
    id,
    author: { uniqueName: author || by },
    content,
    publishedDate: date,
  };
}

function thread({ id, status = 'active', comments }) {
  return { id, status, comments };
}

function decide({ threads, lastCommitAt = 0 }) {
  return decideAction({
    threads,
    lastCommitAt,
    myEmail: MY_EMAIL,
    myAzureId: '',
    myName: MY_NAME,
    eligibilityStart: ELIGIBILITY_START,
  });
}

// ─── Scenario 1: First review on explicit trigger ─────────────

test('first review fires when someone mentions me + asks for review', () => {
  const threads = [
    thread({
      id: 1,
      comments: [
        comment({
          id: 100,
          content: '@ulisses por favor revisa essa PR',
          date: '2026-05-05T10:00:00Z',
        }),
      ],
    }),
  ];
  const decision = decide({ threads });
  assert.equal(decision.action, 'first-review');
  assert.equal(decision.triggerCommentId, 100);
});

test('first review needs BOTH mention and review keyword in same comment', () => {
  // Mention without review keyword → no trigger.
  const onlyMention = decide({
    threads: [thread({
      id: 1,
      comments: [comment({
        id: 100, content: '@ulisses olha isso',
        date: '2026-05-05T10:00:00Z',
      })],
    })],
  });
  assert.equal(onlyMention.action, 'skip');

  // Review keyword without mention → no trigger.
  const onlyKeyword = decide({
    threads: [thread({
      id: 1,
      comments: [comment({
        id: 100, content: 'precisa de review',
        date: '2026-05-05T10:00:00Z',
      })],
    })],
  });
  assert.equal(onlyKeyword.action, 'skip');
});

test('comment before ELIGIBILITY_START is ignored', () => {
  const threads = [thread({
    id: 1,
    comments: [comment({
      id: 100, content: '@ulisses revisa por favor',
      date: '2026-04-01T10:00:00Z', // before window
    })],
  })];
  assert.equal(decide({ threads }).action, 'skip');
});

// ─── Scenario 2: ANTI-LOOP — re-tick on unchanged state ────────

test('after I commented on the PR, repeated ticks with same trigger do NOT re-fire', () => {
  // I posted findings at T2. The original trigger is at T1. No new
  // commit, no new mention. Multiple ticks must not fire again.
  const threads = [
    thread({
      id: 1,
      comments: [
        comment({
          id: 100, content: '@ulisses revisa',
          date: '2026-05-05T10:00:00Z',
        }),
        comment({
          id: 101, content: '✅ Revisão concluída — 0 críticos',
          date: '2026-05-05T11:00:00Z',
          author: MY_EMAIL,
          by: MY_EMAIL,
        }),
      ],
    }),
  ];
  // Commit timestamps don't matter — there's no new trigger comment.
  for (let i = 0; i < 10; i++) {
    const d = decide({ threads, lastCommitAt: t('2026-05-05T09:00:00Z') });
    assert.equal(d.action, 'skip', `tick ${i} should skip`);
  }
});

test('lock comment alone (no new trigger) never reopens the gate', () => {
  // The "Revisando…" lock is my own comment; without a fresh trigger
  // newer than it, gate stays closed forever.
  const threads = [
    thread({
      id: 1,
      comments: [
        comment({
          id: 100, content: '@ulisses revisa',
          date: '2026-05-05T10:00:00Z',
        }),
        comment({
          id: 101, content: '🔍 Revisando…',
          date: '2026-05-05T10:05:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
      ],
    }),
  ];
  assert.equal(decide({ threads }).action, 'skip');
});

// ─── Scenario 3: trigger-no-commit (single notice + silence) ───

test('re-review trigger without new commit posts pending-resolves once', () => {
  const threads = [
    thread({
      id: 1, status: 'active',
      comments: [
        comment({
          id: 100, content: '@ulisses revisa',
          date: '2026-05-05T10:00:00Z',
        }),
        comment({
          id: 101, content: '🔵 sugestão: usar const',
          date: '2026-05-05T11:00:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
      ],
    }),
    // New trigger after my last fala BUT no commit between them.
    thread({
      id: 2,
      comments: [
        comment({
          id: 102, content: '@ulisses revisa de novo',
          date: '2026-05-05T12:00:00Z',
        }),
      ],
    }),
  ];

  // Last commit is BEFORE my fala → re-review gate fails.
  const d = decide({
    threads,
    lastCommitAt: t('2026-05-05T09:00:00Z'),
  });
  assert.equal(d.action, 'pending-resolves-notice');
  assert.equal(d.openCount, 1);
});

test('after I post pending-resolves notice, subsequent identical ticks stay silent', () => {
  const threads = [
    thread({
      id: 1, status: 'active',
      comments: [
        comment({
          id: 100, content: '@ulisses revisa',
          date: '2026-05-05T10:00:00Z',
        }),
        comment({
          id: 101, content: '🔵 sugestão',
          date: '2026-05-05T11:00:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
      ],
    }),
    thread({
      id: 2,
      comments: [
        comment({
          id: 102, content: '@ulisses revisa de novo',
          date: '2026-05-05T12:00:00Z',
        }),
        // Sensor posted the notice; this is now my LATEST fala.
        comment({
          id: 103,
          content: `${PENDING_RESOLVES_MARKER}\n\nVocê tem 1 thread...`,
          date: '2026-05-05T12:05:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
      ],
    }),
  ];

  // No new trigger after the notice → skip.
  const d = decide({
    threads,
    lastCommitAt: t('2026-05-05T09:00:00Z'),
  });
  assert.equal(d.action, 'skip');
});

// ─── Scenario 4: trigger + commit + new trigger pós-commit → re-review ─

test('re-review fires only when trigger is posted AFTER a new commit', () => {
  const threads = [
    thread({
      id: 1, status: 'active',
      comments: [
        comment({
          id: 100, content: '@ulisses revisa',
          date: '2026-05-05T10:00:00Z',
        }),
        comment({
          id: 101, content: '🔵 sugestão',
          date: '2026-05-05T11:00:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
      ],
    }),
    thread({
      id: 2,
      comments: [
        // New trigger AFTER the commit at 12:00 → re-review.
        comment({
          id: 102, content: '@ulisses revisa de novo, corrigi',
          date: '2026-05-05T13:00:00Z',
        }),
      ],
    }),
  ];

  const d = decide({
    threads,
    lastCommitAt: t('2026-05-05T12:00:00Z'),
  });
  assert.equal(d.action, 're-review');
  assert.equal(d.triggerCommentId, 102);
});

test('commit alone (without a new trigger after it) does NOT fire re-review', () => {
  // Commit happened, but no one asked for re-review afterwards.
  const threads = [
    thread({
      id: 1, status: 'active',
      comments: [
        comment({
          id: 100, content: '@ulisses revisa',
          date: '2026-05-05T10:00:00Z',
        }),
        comment({
          id: 101, content: '🔵 sugestão',
          date: '2026-05-05T11:00:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
      ],
    }),
  ];

  const d = decide({
    threads,
    lastCommitAt: t('2026-05-05T15:00:00Z'),
  });
  assert.equal(d.action, 'skip');
});

test('trigger BEFORE the new commit is treated as stale', () => {
  // Someone asked at 10:00, I reviewed at 11:00, then they pushed
  // commits at 13:00 — but the only "review again" comment is the
  // OLD one at 10:00. We must not re-fire on stale trigger.
  const threads = [
    thread({
      id: 1, status: 'active',
      comments: [
        comment({
          id: 100, content: '@ulisses revisa',
          date: '2026-05-05T10:00:00Z',
        }),
        comment({
          id: 101, content: '🔵 sugestão',
          date: '2026-05-05T11:00:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
      ],
    }),
  ];

  const d = decide({
    threads,
    lastCommitAt: t('2026-05-05T13:00:00Z'),
  });
  // No trigger newer than my last fala → skip.
  assert.equal(d.action, 'skip');
});

// ─── Scenario 5: I (MY_EMAIL) can also trigger ────────────────

test('I can trigger a review from my own account (first review)', () => {
  // My trigger comments are intent (asking for review), not a response —
  // they shouldn't count as "lastMyComment" for the gate. So a PR where
  // my only comment is a self-trigger fires first-review normally.
  const threads = [
    thread({
      id: 1,
      comments: [
        comment({
          id: 100, content: '@ulisses revisa',
          date: '2026-05-05T10:00:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
      ],
    }),
  ];
  const d = decide({ threads });
  assert.equal(d.action, 'first-review');
  assert.equal(d.triggerCommentId, 100);
});

test('repeat self-trigger after I posted findings does NOT loop', () => {
  // I triggered, I reviewed, I trigger again — but no commit between
  // my findings and my new self-trigger. Gate must skip (anti-loop).
  const threads = [
    thread({
      id: 1, status: 'active',
      comments: [
        comment({
          id: 100, content: '@ulisses revisa',
          date: '2026-05-05T10:00:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
        comment({
          id: 101, content: '🔵 sugestão: usar const',
          date: '2026-05-05T11:00:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
        comment({
          id: 102, content: '@ulisses revisa de novo',
          date: '2026-05-05T11:30:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
      ],
    }),
  ];
  // No commit between my findings and the re-trigger → not eligible.
  const d = decide({
    threads,
    lastCommitAt: t('2026-05-05T09:00:00Z'),
  });
  assert.notEqual(d.action, 're-review');
  assert.notEqual(d.action, 'first-review');
});

test('mixed: someone triggers, I review, I push a commit + re-trigger from my own account', () => {
  const threads = [
    thread({
      id: 1, status: 'active',
      comments: [
        comment({
          id: 100, content: '@ulisses revisa',
          date: '2026-05-05T10:00:00Z',
        }),
        comment({
          id: 101, content: '🔵 sugestão',
          date: '2026-05-05T11:00:00Z',
          author: MY_EMAIL, by: MY_EMAIL,
        }),
      ],
    }),
    thread({
      id: 2,
      comments: [
        comment({
          id: 102, content: '@ulisses revisa de novo, mudei',
          date: '2026-05-05T13:00:00Z',
          author: MY_EMAIL, by: MY_EMAIL, // I trigger from my own account
        }),
      ],
    }),
  ];

  const d = decide({
    threads,
    lastCommitAt: t('2026-05-05T12:00:00Z'),
  });
  assert.equal(d.action, 're-review');
  assert.equal(d.triggerCommentId, 102);
});

// ─── parseVoteFromResult ──────────────────────────────────────

test('parseVoteFromResult: approved → 10', () => {
  assert.equal(parseVoteFromResult('blah\n[seal:vote] approved'), 10);
});
test('parseVoteFromResult: approved-with-suggestions → 5', () => {
  assert.equal(parseVoteFromResult('summary\n[seal:vote] approved-with-suggestions'), 5);
});
test('parseVoteFromResult: needs-work → -5', () => {
  assert.equal(parseVoteFromResult('summary\n[seal:vote] needs-work'), -5);
});
test('parseVoteFromResult: rejected → -10', () => {
  assert.equal(parseVoteFromResult('summary\n[seal:vote] rejected'), -10);
});
test('parseVoteFromResult: missing line → null', () => {
  assert.equal(parseVoteFromResult('no marker here'), null);
});
test('parseVoteFromResult: unknown verdict token → null', () => {
  assert.equal(parseVoteFromResult('[seal:vote] maybe'), null);
});
test('parseVoteFromResult: takes the LAST verdict if multiple', () => {
  assert.equal(parseVoteFromResult('[seal:vote] needs-work\nlater\n[seal:vote] approved'), 10);
});
test('parseVoteFromResult: case-insensitive token', () => {
  assert.equal(parseVoteFromResult('[seal:vote] APPROVED'), 10);
});

// ─── findReviewRequestInThreads typo handling ─────────────────

test('typo variants of review keyword still trigger', () => {
  const variants = ['reviw', 'revies', 'rivew', 'revie', 'revisa', 'reveja'];
  for (const v of variants) {
    const reqs = findReviewRequestInThreads(
      [thread({
        id: 1,
        comments: [comment({
          id: 1, content: `@ulisses ${v} ai`,
          date: '2026-05-05T10:00:00Z',
        })],
      })],
      { myAzureId: '', myName: MY_NAME, eligibilityStart: ELIGIBILITY_START, sinceTs: 0 }
    );
    assert.ok(reqs, `expected match for "${v}"`);
  }
});
