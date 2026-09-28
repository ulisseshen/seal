import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCK_TEXT,
  RESULT_BLOCK_START,
  RESULT_BLOCK_END,
  buildThreadPayload,
  checkTargetBranch,
  checkBranchName,
  suggestBranchName,
  formatNameBlockSummary,
  pickOriginBranch,
  classifyReviewFailure,
  staleFailureNotices,
  needsCommitVerification,
  localRulesInstruction,
  openBotFindings,
  resolvedBotFindings,
  findingPostedSha,
  buildVerifyResolvedQuestion,
  decideReviewGate,
  deriveVerdict,
  nextReleaseFrom,
  followUpReasons,
  formatFindingComment,
  formatSummaryComment,
  formatTargetBlockSummary,
  hasTargetBlockSummary,
  isMarkedSent,
  postedFindingTitles,
  planReviewChunks,
  needsChunking,
  isGeneratedPath,
  buildChatPrompt,
  parseChatReply,
  authorReplies,
  buildAuthorReplyQuestion,
  findingThreadIdsByTitle,
  CHAT_BLOCK_START,
  CHAT_BLOCK_END,
  sentKey,
  applyUsScenarioFinding,
  countOpenBotThreads,
  verdictFor,
  matchPairedPrs,
  messageDraftFor,
  parseReviewResult,
  reviewedMarker,
  shouldNotify,
} from '../src/sensors/pr-review-pipeline-logic.js';
import { resolveReviewRepos } from '../src/sensors/pr-review-repos.js';

const ME = 'reviewer@example.com';
const AUTHOR = 'author@example.com';
const START = new Date('2026-09-23T00:00:00Z').getTime();
const HEAD = 'ab7cf0d92c0510301161a606705bf1bcd96370cd';

const pr = (overrides = {}) => ({
  pullRequestId: 100,
  title: 'Feature',
  createdBy: { uniqueName: AUTHOR, displayName: 'Autor Silva' },
  creationDate: '2026-09-24T10:00:00Z',
  isDraft: false,
  reviewers: [],
  sourceRefName: 'refs/heads/feat/x',
  lastMergeSourceCommit: { commitId: HEAD },
  ...overrides,
});

const myComment = (content, date = '2026-09-24T12:00:00Z') => ({ author: { uniqueName: ME }, content, publishedDate: date });
const gate = (overrides, threads = []) => decideReviewGate({ pr: pr(overrides), threads, myEmail: ME, eligibilityStart: START });

test('first review for a fresh non-draft PR from someone else', () => {
  assert.deepEqual(gate({}), { action: 'first-review', headSha: HEAD });
});

test('skips own PR, draft and PRs created before the pipeline start', () => {
  assert.equal(gate({ createdBy: { uniqueName: ME } }).reason, 'own-pr');
  assert.equal(gate({ isDraft: true }).reason, 'draft');
  assert.equal(gate({ creationDate: '2026-09-01T00:00:00Z' }).reason, 'before-start');
});

test('test PR whitelist bypasses own-pr and start gates', () => {
  const result = decideReviewGate({
    pr: pr({ createdBy: { uniqueName: ME }, creationDate: '2026-01-01T00:00:00Z' }),
    threads: [],
    myEmail: ME,
    eligibilityStart: START,
    testPrs: new Set([100]),
  });
  assert.equal(result.action, 'first-review');
});

test('approved PR is skipped but a negative vote allows re-review on a new commit', () => {
  assert.equal(gate({ reviewers: [{ uniqueName: ME, vote: 10 }] }).reason, 'approved');
  assert.equal(gate({ reviewers: [{ uniqueName: ME, vote: 5 }] }).reason, 'approved');
  const threads = [{ comments: [myComment(`resumo\n${reviewedMarker('1111111')}`)] }];
  assert.equal(gate({ reviewers: [{ uniqueName: ME, vote: -5 }] }, threads).action, 're-review');
});

test('lock comment blocks a second review', () => {
  assert.equal(gate({}, [{ comments: [myComment(LOCK_TEXT)] }]).reason, 'locked');
});

test('same head sha is up to date; a new commit triggers re-review with the previous sha', () => {
  const threads = [{ comments: [myComment(`ok\n${reviewedMarker(HEAD)}`)] }];
  assert.equal(gate({}, threads).reason, 'up-to-date');
  const old = [{ comments: [myComment(`ok\n${reviewedMarker('deadbeef')}`)] }];
  assert.deepEqual(gate({}, old), { action: 're-review', headSha: HEAD, previousSha: 'deadbeef' });
});

test('reviewed marker from someone else does not count', () => {
  const threads = [{ comments: [{ author: { uniqueName: AUTHOR }, content: reviewedMarker(HEAD), publishedDate: '2026-09-24T12:00:00Z' }] }];
  assert.equal(gate({}, threads).action, 'first-review');
});

test('paired PR matches by branch, shared work item or mention', () => {
  const own = pr({ description: 'Depende do PR 10104 do backend' });
  const candidates = [
    { pr: { pullRequestId: 1, sourceRefName: 'refs/heads/feat/x' }, workItemIds: [] },
    { pr: { pullRequestId: 2, sourceRefName: 'refs/heads/other' }, workItemIds: [555] },
    { pr: { pullRequestId: 10104, sourceRefName: 'refs/heads/zzz' }, workItemIds: [] },
    { pr: { pullRequestId: 3, sourceRefName: 'refs/heads/unrelated', title: 'nada' }, workItemIds: [9] },
  ];
  const matches = matchPairedPrs(own, [555], candidates);
  assert.deepEqual(
    matches.map((match) => [match.pr.pullRequestId, match.reasons]),
    [
      [1, ['same-branch']],
      [2, ['same-work-item']],
      [10104, ['mentioned']],
    ],
  );
});

test('mention does not match a longer PR number', () => {
  assert.equal(matchPairedPrs(pr({ description: 'PR 441889' }), [], [{ pr: { pullRequestId: 10104 } }]).length, 0);
});

const block = (payload) => `blah blah\n${RESULT_BLOCK_START}\n${JSON.stringify(payload)}\n${RESULT_BLOCK_END}\n`;

test('parses the result block, normalizes findings and derives verdict when missing', () => {
  const parsed = parseReviewResult(
    block({
      findings: [
        { severity: 'blocker', file: '/src/a.ts', line: 10, endLine: 8, title: 'quebra' },
        { severity: 'weird', kind: 'nope', title: 'algo' },
        { severity: 'NIT', title: '' },
      ],
    }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.verdict, 'needs-work');
  assert.equal(parsed.data.findings.length, 2);
  assert.deepEqual(
    { ...parsed.data.findings[0], body: undefined },
    { ...parsed.data.findings[0], severity: 'BLOCKER', kind: 'code', file: 'src/a.ts', line: 10, endLine: 10, body: undefined },
  );
  assert.equal(parsed.data.findings[1].severity, 'WARNING');
  assert.equal(parsed.data.findings[1].kind, 'code');
});

test('uses the last block and tolerates a fenced json block', () => {
  const text = `${block({ findings: [{ title: 'antigo' }] })}\n${RESULT_BLOCK_START}\n\`\`\`json\n{"findings":[]}\n\`\`\`\n${RESULT_BLOCK_END}`;
  assert.equal(parseReviewResult(text).data.verdict, 'approved');
});

test('any comment leaves the PR waiting for the author, whatever the model claimed; no comment approves', () => {
  const waiting = parseReviewResult(block({ verdict: 'approved', blockingReason: 'falta teste', findings: [{ severity: 'NIT', title: 'nome' }] })).data;
  assert.equal(waiting.verdict, 'needs-work');
  assert.equal(waiting.modelVerdict, 'approved');
  assert.equal(waiting.blockingReason, 'falta teste');
  assert.equal(parseReviewResult(block({ verdict: 'needs-work', findings: [] })).data.verdict, 'approved');
});

test('missing or broken block is reported, never guessed', () => {
  assert.equal(parseReviewResult('no block here').error, 'missing-result-block');
  assert.match(parseReviewResult(`${RESULT_BLOCK_START}\n{oops\n${RESULT_BLOCK_END}`).error, /^invalid-json/);
});

test('finding comment carries a collapsed fix prompt and never breaks the code fence', () => {
  const comment = formatFindingComment({
    severity: 'WARNING',
    kind: 'test-gap',
    title: 'Cenário sem teste',
    body: 'corpo',
    rule: 'US 123',
    suggestion: 'escrever teste',
    fixPrompt: 'rode ```npm test```',
  });
  assert.match(comment, /^\*\*\[WARNING · Teste faltando\] Cenário sem teste\*\*/);
  assert.match(comment, /<details>\n<summary>🤖 Prompt de correção<\/summary>/);
  assert.equal((comment.match(/```/g) || []).length, 2);
});

test('thread payload anchors inline only when there is file and line; nit is pending', () => {
  const inline = buildThreadPayload({ severity: 'NIT', kind: 'code', file: 'src/a.ts', line: 3, endLine: 5, title: 't' });
  assert.equal(inline.status, 6);
  assert.deepEqual(inline.threadContext, { filePath: '/src/a.ts', rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 5, offset: 1 } });
  const general = buildThreadPayload({ severity: 'BLOCKER', kind: 'doc-request', file: null, line: null, title: 't' });
  assert.equal(general.status, 1);
  assert.equal(general.threadContext, undefined);
});

test('summary is short: waiting for author with the one-line reason, or approved; always carries the sha marker', () => {
  const waiting = formatSummaryComment({ data: { blockingReason: 'aceita data fora da janela', findings: [{ title: 'x' }, { title: 'y' }] }, headSha: HEAD });
  assert.match(waiting, /^\*\*⏸️ Aguardando autor\*\* — aceita data fora da janela/);
  assert.match(waiting, /2 comentários nesta PR, cada um com o prompt de correção\./);
  assert.ok(waiting.includes(reviewedMarker(HEAD)));
  assert.ok(waiting.split('\n').filter(Boolean).length <= 3);
  const approved = formatSummaryComment({ data: { blockingReason: '', findings: [] }, headSha: HEAD });
  assert.match(approved, /^\*\*✅ Aprovado\*\*/);
  assert.ok(!approved.includes(LOCK_TEXT));
});

test('follow-up reasons: open over a day, my thread unanswered, pair already closed', () => {
  const now = new Date('2026-09-26T12:00:00Z').getTime();
  const threads = [
    { status: 'active', comments: [myComment('achado', '2026-09-24T12:00:00Z')] },
    { status: 'closed', comments: [myComment('resumo', '2026-09-24T12:00:00Z')] },
  ];
  assert.deepEqual(followUpReasons({ pr: pr(), threads, myEmail: ME, now, pairedStatuses: ['completed'] }), [
    'open-over-1d',
    'stale-no-response',
    'pair-desync',
  ]);
  const answered = [{ status: 'active', comments: [myComment('achado', '2026-09-24T12:00:00Z'), { author: { uniqueName: AUTHOR }, content: 'feito', publishedDate: '2026-09-25T12:00:00Z' }] }];
  assert.deepEqual(followUpReasons({ pr: pr({ creationDate: '2026-09-26T08:00:00Z' }), threads: answered, myEmail: ME, now }), []);
});

test('notification cooldown is one day per reason', () => {
  const now = new Date('2026-09-26T12:00:00Z').getTime();
  assert.equal(shouldNotify({}, 'blocker', now), true);
  assert.equal(shouldNotify({ blocker: '2026-09-26T00:00:00Z' }, 'blocker', now), false);
  assert.equal(shouldNotify({ blocker: '2026-09-25T11:00:00Z' }, 'blocker', now), true);
});

test('repo config comes only from ingest.json: incomplete or disabled entries are dropped, ~ is expanded', () => {
  assert.deepEqual(resolveReviewRepos(), []);
  const repos = resolveReviewRepos([
    { name: 'front', id: 'guid-1', projectDir: '~/projects/front', skill: 'review', pair: 'back' },
    { name: 'back', id: 'guid-2', projectDir: '/abs/back', skill: 'review', enabled: false },
    { name: 'no-id', projectDir: '/x', skill: 'review' },
  ]);
  assert.deepEqual(repos.map((repo) => repo.name), ['front']);
  assert.ok(!repos[0].projectDir.startsWith('~'));
  assert.ok(repos[0].projectDir.endsWith('/projects/front'));
});

test('next release is main version + 1 minor', () => {
  assert.equal(nextReleaseFrom('1.6.3'), 'release/1.7.0');
  assert.equal(nextReleaseFrom('4.23.1+532'), 'release/4.24.0');
  assert.equal(nextReleaseFrom('v4.23.0'), 'release/4.24.0');
  assert.equal(nextReleaseFrom(null), null);
});

test('target gate: work into main blocks; release/hotfix/gmud into main pass', () => {
  const nextRelease = 'release/1.7.0';
  assert.equal(checkTargetBranch({ source: 'feat/x', target: 'main', nextRelease }).severity, 'BLOCKER');
  for (const source of ['release/1.7.0', 'hotfix/73876-x', 'gmud/4.23.0']) {
    assert.equal(checkTargetBranch({ source, target: 'main', nextRelease }), null);
  }
});

test('target gate: next release and future releases pass; a release already in main warns', () => {
  const nextRelease = 'release/1.7.0';
  assert.equal(checkTargetBranch({ source: 'fix/y', target: 'release/1.7.0', nextRelease }), null);
  assert.equal(checkTargetBranch({ source: 'feat/y', target: 'release/1.8.0', nextRelease }), null);
  const stale = checkTargetBranch({ source: 'fix/y', target: 'release/1.6.0', nextRelease });
  assert.equal(stale.severity, 'WARNING');
  assert.deepEqual(stale.sources, ['target-gate']);
  assert.match(stale.fixPrompt, /release\/1\.7\.0/);
  assert.equal(checkTargetBranch({ source: 'fix/y', target: 'main', nextRelease: null }), null);
});

test('ledger row for the head sha blocks a second review of the same commit, even without any PR comment', () => {
  for (const status of ['queued', 'publishing', 'published', 'failed']) {
    const result = decideReviewGate({ pr: pr(), threads: [], myEmail: ME, eligibilityStart: START, ledgerForHead: { status } });
    assert.deepEqual(result, { action: 'skip', reason: `ledger-${status}` });
  }
});

test('a failed review whose retry is due goes through the gate again for the same commit', () => {
  const due = decideReviewGate({ pr: pr(), threads: [], myEmail: ME, eligibilityStart: START, ledgerForHead: { status: 'failed', retry_due: 1 } });
  assert.deepEqual(due, { action: 'first-review', headSha: HEAD, retry: true });
  const waiting = decideReviewGate({ pr: pr(), threads: [], myEmail: ME, eligibilityStart: START, ledgerForHead: { status: 'failed', retry_due: 0, retry_at: '2099-01-01 00:00:00' } });
  assert.deepEqual(waiting, { action: 'skip', reason: 'ledger-failed-retry-later' });
  const reReview = decideReviewGate({ pr: pr(), threads: [], myEmail: ME, eligibilityStart: START, lastPublishedSha: 'cafebabe', ledgerForHead: { status: 'failed', retry_due: 1 } });
  assert.deepEqual(reReview, { action: 're-review', headSha: HEAD, previousSha: 'cafebabe', retry: true });
});

test('interruptions and outages are transient failures, a bad result or a crash is permanent', () => {
  for (const error of ['Process killed (SIGTERM) — will retry on next boot', 'Exit code 143', 'orphaned by restart', 'ENOENT: no such file', 'worktree missing', 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4', 'API Error: 529 overloaded', 'getaddrinfo ENOTFOUND dev.azure.com']) {
    assert.equal(classifyReviewFailure(error), 'transient', error);
  }
  for (const error of ['sem bloco de resultado', 'JSON inválido', 'TypeError: x is undefined', '']) {
    assert.equal(classifyReviewFailure(error), 'permanent', error);
  }
});

test('ledger last published sha drives re-review when the PR marker is missing', () => {
  const result = decideReviewGate({ pr: pr(), threads: [], myEmail: ME, eligibilityStart: START, lastPublishedSha: 'cafebabe' });
  assert.deepEqual(result, { action: 're-review', headSha: HEAD, previousSha: 'cafebabe' });
});

test('a deleted lock or deleted summary is ignored by the gate', () => {
  const deletedLock = [{ comments: [{ ...myComment(LOCK_TEXT), isDeleted: true }] }];
  assert.equal(gate({}, deletedLock).action, 'first-review');
  const deletedSummary = [{ comments: [{ ...myComment(reviewedMarker(HEAD)), isDeleted: true }] }];
  assert.equal(gate({}, deletedSummary).action, 'first-review');
});

test('singular and plural read naturally in the summary and in the author message', () => {
  const one = formatSummaryComment({ data: { blockingReason: '', findings: [{ title: 'x' }] }, headSha: HEAD });
  assert.match(one, /há 1 comentário para resolver antes de aprovar\./);
  assert.match(one, /1 comentário nesta PR, com o prompt de correção\./);
  assert.ok(!one.includes('(s)'));
  const entry = { authorFirstName: 'Dave', prId: 1, title: 't', url: 'u', counts: { blocker: 1, warning: 0, nit: 0 } };
  assert.match(messageDraftFor('blocker', entry), /deixou 1 comentário para resolver, com o prompt de correção\./);
  assert.match(messageDraftFor('blocker', { ...entry, counts: { blocker: 1, warning: 2, nit: 0 } }), /deixou 3 comentários para resolver, cada um com/);
});

test('sibling tasks under the same story pair the PRs even with different work items and branches', () => {
  const own = pr({ sourceRefName: 'refs/heads/feature/74154-fe' });
  const candidates = [
    { pr: { pullRequestId: 10113, sourceRefName: 'refs/heads/feature/74153-be' }, workItemIds: [20211], storyIds: [20205] },
    { pr: { pullRequestId: 5, sourceRefName: 'refs/heads/other' }, workItemIds: [9], storyIds: [8] },
  ];
  assert.deepEqual(
    matchPairedPrs(own, [20214], candidates, [20205]).map((match) => [match.pr.pullRequestId, match.reasons]),
    [[10113, ['same-story']]],
  );
});

test('a mention deep in a long description still pairs', () => {
  const own = pr({ description: `${'x'.repeat(3000)} depende da !10113` });
  assert.deepEqual(matchPairedPrs(own, [], [{ pr: { pullRequestId: 10113 } }]).map((match) => match.reasons), [['mentioned']]);
});

const scenarios = [
  { id: 'C1', text: 'Dado A, Quando B, Então C', covered: true, test: 't.spec.ts:1' },
  { id: 'C2', text: 'Dado D, Quando E, Então F', covered: false, where: 'src/x.spec.ts' },
  { id: 'C3', text: 'Dado G, Quando H, Então I', covered: false },
];

test('uncovered US scenarios always become one comment with a prompt that writes every missing test', () => {
  const parsed = parseReviewResult(block({ findings: [], usCoverage: { total: 3, covered: 1, source: 'US 1', scenarios } })).data;
  const findings = applyUsScenarioFinding(parsed.findings, parsed.usCoverage, { repo: 'app-web', prUrl: 'u', testSkills: ['unit-test'] });
  assert.equal(findings.length, 1);
  const [gap] = findings;
  assert.equal(gap.kind, 'test-gap');
  assert.equal(gap.title, '2 cenários da US sem teste (de 3)');
  assert.match(gap.body, /\*\*C2\*\* Dado D, Quando E, Então F → `src\/x\.spec\.ts`/);
  assert.ok(!gap.body.includes('C1'));
  assert.match(gap.fixPrompt, /C2\. Dado D.*\n   Onde: src\/x\.spec\.ts\nC3\. Dado G/s);
  assert.match(gap.fixPrompt, /\/unit-test/);
  assert.match(gap.fixPrompt, /Não altere código de produção/);
  assert.equal(deriveVerdict(findings), 'needs-work');
});

test('the aggregated US comment replaces loose us-coverage gaps but keeps every other finding', () => {
  const findings = [
    { kind: 'test-gap', sources: ['us-coverage'], title: 'solto' },
    { kind: 'test-gap', sources: ['tests'], title: 'regra sem teste' },
    { kind: 'code', sources: ['repo-skill', 'us-coverage'], title: 'bug' },
  ];
  const result = applyUsScenarioFinding(findings, { total: 2, covered: 1, scenarios: [], note: 'falta o cenário X' }, { repo: 'r' });
  assert.deepEqual(result.map((finding) => finding.title), ['1 cenário da US sem teste', 'regra sem teste', 'bug']);
  assert.match(result[0].body, /falta o cenário X/);
});

test('full coverage or no criteria adds nothing', () => {
  assert.deepEqual(applyUsScenarioFinding([], { total: 3, covered: 3, scenarios: [] }, { repo: 'r' }), []);
  assert.deepEqual(applyUsScenarioFinding([], { total: 0, covered: 0, scenarios: [] }, { repo: 'r' }), []);
  assert.deepEqual(applyUsScenarioFinding([], null, { repo: 'r' }), []);
});

test('re-review with no new comment but bot threads still open stays waiting for the author', () => {
  const threads = [
    { id: 1, status: 1, comments: [myComment('**[WARNING] antigo**')] },
    { id: 2, status: 6, comments: [myComment('**[NIT] detalhe**')] },
    { id: 3, status: 2, comments: [myComment('**[WARNING] resolvido**')] },
    { id: 4, status: 4, comments: [myComment(`resumo\n${reviewedMarker(HEAD)}`)] },
    { id: 5, status: 1, comments: [myComment(LOCK_TEXT)] },
    { id: 6, status: 1, comments: [{ author: { uniqueName: AUTHOR }, content: 'dúvida do autor' }] },
    { id: 7, status: 1, comments: [{ ...myComment('apagado'), isDeleted: true }] },
  ];
  const priorOpen = countOpenBotThreads(threads, ME);
  assert.equal(priorOpen, 2);
  assert.equal(verdictFor(0, priorOpen), 'needs-work');
  assert.equal(verdictFor(0, 0), 'approved');
  const summary = formatSummaryComment({ data: { blockingReason: '', findings: [] }, headSha: HEAD, priorOpen });
  assert.match(summary, /^\*\*⏸️ Aguardando autor\*\* — 2 comentários da revisão anterior continuam abertos\./);
  assert.ok(!summary.includes('Aprovado'));
});

test('summary mixes new and still-open comments in plain language', () => {
  const summary = formatSummaryComment({ data: { blockingReason: 'falta teste do cenário C2', findings: [{ title: 'x' }] }, headSha: HEAD, priorOpen: 1 });
  assert.match(summary, /1 comentário nesta PR, com o prompt de correção\. 1 comentário da revisão anterior continua aberto\./);
});

test('a nudge marked as sent stays quiet until there is a new reason; time-based nudges come back after a day', () => {
  const now = new Date('2026-09-23T12:00:00Z').getTime();
  const blocker = { reason: 'blocker', since: '2026-09-22T20:00:00Z' };
  const openLong = { reason: 'open-over-1d', since: '2026-09-21T10:00:00Z' };
  const sent = { [sentKey(10116, blocker)]: '2026-09-22T21:00:00Z', [sentKey(10116, openLong)]: '2026-09-22T21:00:00Z' };
  assert.equal(isMarkedSent(sent, 10116, blocker, now), true);
  assert.equal(isMarkedSent(sent, 10116, { reason: 'blocker', since: '2026-09-23T09:00:00Z' }, now), false);
  assert.equal(isMarkedSent(sent, 10116, openLong, now), true);
  assert.equal(isMarkedSent(sent, 10116, openLong, now + 24 * 60 * 60 * 1000), false);
  assert.equal(isMarkedSent({}, 10116, blocker, now), false);
});

test('a resumed publish skips findings already on the PR, matched by title', () => {
  const threads = [
    { comments: [myComment('**[WARNING] Falta teste do fechamento**\n\ncorpo')] },
    { comments: [myComment('**[BLOCKER · Documentação] PR sem US vinculada**')] },
    { comments: [{ author: { uniqueName: AUTHOR }, content: '**[WARNING] Falta teste do fechamento**' }] },
    { comments: [{ ...myComment('**[NIT] apagado**'), isDeleted: true }] },
  ];
  assert.deepEqual([...postedFindingTitles(threads, ME)].sort(), ['Falta teste do fechamento', 'PR sem US vinculada']);
  assert.equal(formatFindingComment({ severity: 'WARNING', kind: 'code', title: 'Falta teste do fechamento' }).match(/^\*\*\[[^\]]+\]\s*(.+?)\*\*/)[1], 'Falta teste do fechamento');
});

test('chat prompt carries the question and the only way the agent can ask for a change', () => {
  const prompt = buildChatPrompt({ prId: 10116, question: '  por que o C2 é bloqueador?  ' });
  assert.match(prompt, /PR !44700/);
  assert.match(prompt, /por que o C2 é bloqueador\?/);
  assert.ok(prompt.includes(CHAT_BLOCK_START) && prompt.includes(CHAT_BLOCK_END));
});

test('chat reply splits the answer from the resolve actions; no block means no action', () => {
  const reply = `Você tem razão, o backend já ordena.\n${CHAT_BLOCK_START}\n{"resolve":[{"title":"firstAllowedDay supõe ordem","reason":"o backend garante"},{"title":""}]}\n${CHAT_BLOCK_END}`;
  assert.deepEqual(parseChatReply(reply), { answer: 'Você tem razão, o backend já ordena.', resolves: [{ title: 'firstAllowedDay supõe ordem', reason: 'o backend garante' }], workItems: [], reopen: [] });
  assert.deepEqual(parseChatReply('Mantenho o achado.'), { answer: 'Mantenho o achado.', resolves: [], workItems: [], reopen: [] });
  assert.deepEqual(parseChatReply(`ok\n${CHAT_BLOCK_START}\n{quebrado\n${CHAT_BLOCK_END}`).resolves, []);
});

test('finding threads are found by title, only among the bot own threads', () => {
  const threads = [
    { id: 11, comments: [myComment('**[WARNING] firstAllowedDay supõe ordem**\n\ncorpo')] },
    { id: 12, comments: [{ author: { uniqueName: AUTHOR }, content: '**[WARNING] firstAllowedDay supõe ordem**' }] },
    { id: 13, comments: [myComment(`resumo\n${reviewedMarker(HEAD)}`)] },
  ];
  assert.deepEqual([...findingThreadIdsByTitle(threads, ME)], [['firstAllowedDay supõe ordem', 11]]);
});

test('generated files never enter the review', () => {
  for (const file of ['package-lock.json', 'a/b/pubspec.lock', 'tests/vrt/__screenshots__/x.png', 'c/__golden__/menu.html', 'dist/index.js', 'x.snap']) {
    assert.equal(isGeneratedPath(file), true, file);
  }
  assert.equal(isGeneratedPath('components/atoms/buttons/SmartButton.vue'), false);
});

test('a big PR is split by area, each part under the line and file caps, nothing lost', () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, index) => ({ path: `components/atoms/buttons/B${String(index).padStart(2, '0')}.vue`, added: 40, deleted: 0 })),
    { path: 'tokens/base.css', added: 200, deleted: 30 },
    { path: 'tokens/Colors.stories.ts', added: 360, deleted: 0 },
    { path: 'scripts/generate-facts.mjs', added: 430, deleted: 0 },
    { path: 'package-lock.json', added: 5000, deleted: 200 },
    { path: 'README.md', added: 20, deleted: 1 },
  ];
  const plan = planReviewChunks(rows, { maxLines: 900, maxFiles: 25 });
  assert.equal(plan.totalFiles, 33);
  assert.deepEqual(plan.chunks.filter((chunk) => chunk.kind === 'docs').map((chunk) => chunk.paths), [['README.md']]);
  assert.equal(needsChunking(plan), true);
  assert.ok(plan.chunks.filter((chunk) => chunk.kind === 'code').every((chunk) => chunk.lines <= 900 && chunk.paths.length <= 25));
  const covered = plan.chunks.flatMap((chunk) => chunk.paths).sort();
  assert.deepEqual(covered, rows.map((row) => row.path).filter((file) => file !== 'package-lock.json').sort());
  assert.ok(plan.chunks.some((chunk) => chunk.label.includes('components/atoms/buttons')));
});

test('a small PR stays in one pass', () => {
  const plan = planReviewChunks([{ path: 'src/a.ts', added: 100, deleted: 10 }, { path: 'src/b.ts', added: 50, deleted: 0 }]);
  assert.equal(plan.chunks.length, 1);
  assert.equal(needsChunking(plan), false);
});

test('once the head commit is published, every failure notice the bot left on the PR is stale, and nothing else is', () => {
  const threads = [
    { id: 1, comments: [{ id: 1, ...myComment('⚠️ A revisão automática falhou. Vou tentar de novo no próximo commit.') }] },
    { id: 2, comments: [{ id: 1, ...myComment('⚠️ A revisão automática foi interrompida (processo encerrado no meio). Tento de novo sozinho a partir de 25/09 06:00.') }] },
    { id: 3, comments: [{ id: 1, ...myComment('⚠️ A revisão automática não gerou um resultado utilizável (sem bloco). Vou tentar de novo no próximo commit.') }] },
    { id: 4, comments: [{ id: 1, ...myComment('**⏸️ Aguardando autor** — resumo') }] },
    { id: 5, comments: [{ id: 1, author: { uniqueName: 'pessoa@example.com' }, content: '⚠️ A revisão automática falhou. Vou tentar de novo no próximo commit.' }] },
    { id: 6, comments: [{ id: 1, isDeleted: true, ...myComment('⚠️ A revisão automática falhou.') }] },
  ];
  assert.deepEqual(staleFailureNotices({ threads, myEmail: ME, headStatus: 'published' }), [
    { threadId: 1, commentId: 1 },
    { threadId: 2, commentId: 1 },
    { threadId: 3, commentId: 1 },
  ]);
  for (const headStatus of ['failed', 'queued', 'publishing', undefined]) {
    assert.deepEqual(staleFailureNotices({ threads, myEmail: ME, headStatus }), [], String(headStatus));
  }
});

const Bruno = 'pessoa@example.com';
const reply = (content, date) => ({ author: { uniqueName: Bruno, displayName: 'Bruno Lima Costa' }, content, publishedDate: date });

test('author replies on the bot findings after the last review are collected once, with the finding title', () => {
  const threads = [
    { id: 10, status: 5, comments: [{ id: 1, ...myComment('**[BLOCKER] O revert volta a gravar autor nulo** detalhe', '2026-09-25T15:07:00Z') }, { id: 2, ...reply('O autor null é decisão do time.', '2026-09-25T15:46:00Z') }] },
    { id: 11, status: 1, comments: [{ id: 1, ...myComment('**[WARNING] Falta teste** x', '2026-09-25T15:07:00Z') }, { id: 2, ...reply('respondido antes', '2026-09-25T15:00:00Z') }] },
    { id: 12, status: 4, comments: [{ id: 1, ...myComment('**⏸️ Aguardando autor** — resumo <!-- seal:reviewed 0fbac71b -->', '2026-09-25T15:07:00Z') }, { id: 2, ...reply('ok', '2026-09-25T15:50:00Z') }] },
    { id: 13, status: 1, comments: [{ id: 1, ...reply('**[WARNING] não é do bot**', '2026-09-25T15:07:00Z') }, { id: 2, ...reply('x', '2026-09-25T15:50:00Z') }] },
    { id: 14, status: 1, comments: [{ id: 1, ...myComment('**[NIT] Nome**', '2026-09-25T15:07:00Z') }, { id: 2, ...myComment('🤖 Resolvido depois de uma conversa', '2026-09-25T15:55:00Z') }] },
  ];
  const found = authorReplies({ threads, myEmail: ME, since: Date.parse('2026-09-25T15:07:30Z') });
  assert.deepEqual(found.disputes, [
    { threadId: 10, title: 'O revert volta a gravar autor nulo', status: 'byDesign', replies: [{ author: 'Bruno Lima Costa', text: 'O autor null é decisão do time.', at: '2026-09-25T15:46:00Z' }] },
  ]);
  assert.equal(found.latestAt, Date.parse('2026-09-25T15:46:00Z'));
  assert.deepEqual(authorReplies({ threads, myEmail: ME, since: found.latestAt }).disputes, []);
});

test('the question to the reviewer carries every reply and asks for work item updates instead of charging the author', () => {
  const question = buildAuthorReplyQuestion({
    prId: 10128,
    disputes: [{ threadId: 10, title: 'O revert volta a gravar autor nulo', status: 'byDesign', replies: [{ author: 'Bruno Lima Costa', text: 'O autor null é decisão do time.', at: 'x' }] }],
  });
  assert.match(question, /!44969/);
  assert.match(question, /O revert volta a gravar autor nulo/);
  assert.match(question, /Bruno Lima Costa: O autor null é decisão do time\./);
  assert.match(question, /work_items/);
});

test('chat reply can list work items the owner must update, ignoring entries without id or change', () => {
  const text = `Aceito a decisão do time.\n${CHAT_BLOCK_START}\n{"resolve":[{"title":"O revert volta a gravar autor nulo","reason":"decisão do time"}],"work_items":[{"id":20223,"change":"tirar o critério que proíbe autor nulo"},{"id":"x"},{"change":"sem id"}]}\n${CHAT_BLOCK_END}`;
  const parsed = parseChatReply(text);
  assert.deepEqual(parsed.workItems, [{ id: 20223, change: 'tirar o critério que proíbe autor nulo' }]);
  assert.equal(parsed.resolves.length, 1);
});

test('a head reviewed with no new finding is verified against the commits once, whatever is still open', () => {
  const head = { status: 'published', verdict: 'needs-work', findings: 0, verify_requested_at: null };
  assert.equal(needsCommitVerification({ ledgerForHead: head }), true);
  assert.equal(needsCommitVerification({ ledgerForHead: { ...head, verify_requested_at: '2026-09-25 20:10:00' } }), false);
  assert.equal(needsCommitVerification({ ledgerForHead: { ...head, findings: 2 } }), false);
  assert.equal(needsCommitVerification({ ledgerForHead: { ...head, verdict: 'approved' } }), false);
  assert.equal(needsCommitVerification({ ledgerForHead: { ...head, status: 'queued' } }), false);
  assert.equal(needsCommitVerification({ ledgerForHead: null }), false);
});

const findingWithPrompt = (title, prompt) => formatFindingComment({ severity: 'BLOCKER', kind: 'code', title, body: 'corpo', fixPrompt: prompt });

test('open bot findings are listed with their title, thread and fix prompt; closed ones and summaries are not', () => {
  const threads = [
    { id: 177466, status: 1, comments: [{ id: 1, ...myComment(findingWithPrompt('Merge rebaixa a versão', 'Volte package.json para 1.7.0')) }] },
    { id: 177467, status: 2, comments: [{ id: 1, ...myComment(findingWithPrompt('Conflito no spec', 'Mantenha os dois testes')) }] },
    { id: 177468, status: 6, comments: [{ id: 1, ...myComment('**[WARNING] Sem prompt** só texto') }] },
    { id: 177469, status: 1, comments: [{ id: 1, ...myComment('**⏸️ Aguardando autor** — resumo') }] },
  ];
  assert.deepEqual(openBotFindings(threads, ME).map(({ threadId, title, fixPrompt }) => ({ threadId, title, fixPrompt })), [
    { threadId: 177466, title: 'Merge rebaixa a versão', fixPrompt: 'Volte package.json para 1.7.0' },
    { threadId: 177468, title: 'Sem prompt', fixPrompt: null },
  ]);
});

test('the summary links each comment still open without repeating its prompt or asking the author to resolve it', () => {
  const text = formatSummaryComment({
    data: { blockingReason: '', findings: [] }, headSha: HEAD, priorOpen: 2,
    priorThreads: [{ threadId: 177466, title: 'Merge rebaixa a versão', fixPrompt: 'Volte package.json para 1.7.0' }, { threadId: 177468, title: 'Sem prompt', fixPrompt: null }],
    prUrl: 'https://dev.azure.com/o/p/_git/r/pullrequest/45103',
  });
  assert.match(text, /Continuam abertos:/);
  assert.match(text, /\[Merge rebaixa a versão\]\(https:\/\/dev\.azure\.com\/o\/p\/_git\/r\/pullrequest\/45103\?discussionId=177466\)/);
  assert.match(text, /\[Sem prompt\]\([^)]*discussionId=177468\)/);
  assert.doesNotMatch(text, /Volte package\.json para 1\.7\.0/);
  assert.doesNotMatch(text, /<details>/);
  assert.doesNotMatch(text, /marque o comentário como resolvido/);
  assert.match(text, /fecha sozinho o que foi corrigido/);
});

test('the review result carries which earlier comments the code already fixes', () => {
  const block = JSON.stringify({ findings: [], priorResolved: [
    { threadId: 177466, title: 'Título reescrito pelo revisor', reason: 'package.json volta a 1.7.0' },
    { threadId: '177468', reason: 'id como texto' },
    { title: 'Merge rebaixa a versão', reason: 'sem thread não fecha nada' },
    { threadId: 0 },
  ] });
  const parsed = parseReviewResult(`<<<SEAL_REVIEW_JSON\n${block}\nSEAL_REVIEW_JSON>>>`);
  assert.deepEqual(parsed.data.priorResolved, [
    { threadId: 177466, title: 'Título reescrito pelo revisor', reason: 'package.json volta a 1.7.0' },
    { threadId: 177468, title: '', reason: 'id como texto' },
  ]);
  assert.deepEqual(parseReviewResult(`<<<SEAL_REVIEW_JSON\n{"findings":[]}\nSEAL_REVIEW_JSON>>>`).data.priorResolved, []);
});

test('resolved bot findings are the closed finding threads, with when they were posted and their prompt', () => {
  const threads = [
    { id: 1, status: 2, comments: [{ id: 1, ...myComment(findingWithPrompt('Versão rebaixada', 'Volte para 1.7.0'), '2026-09-25T19:31:00Z') }] },
    { id: 2, status: 1, comments: [{ id: 1, ...myComment(findingWithPrompt('Aberto', 'x'), '2026-09-25T19:31:00Z') }] },
    { id: 3, status: 4, comments: [{ id: 1, ...myComment('**⏸️ Aguardando autor** — resumo', '2026-09-25T19:31:00Z') }] },
    { id: 4, status: 4, comments: [{ id: 1, ...myComment(`**[${'LEMBRETE · não bloqueia'}] lembrete**`, '2026-09-25T19:31:00Z') }] },
  ];
  assert.deepEqual(resolvedBotFindings(threads, ME), [{ threadId: 1, title: 'Versão rebaixada', fixPrompt: 'Volte para 1.7.0', postedAt: '2026-09-25T19:31:00Z', postedSha: null }]);
});

test('the verification question gives the commit range after each comment and the only way to reopen', () => {
  const question = buildVerifyResolvedQuestion({
    prId: 10134, headSha: 'b5c9d244',
    findings: [
      { threadId: 1, title: 'Versão rebaixada', fixPrompt: 'Volte para 1.7.0', sinceSha: '7ec24643', open: false, replies: [] },
      { threadId: 2, title: 'Cenário sem teste', fixPrompt: 'Teste o C4', sinceSha: '8625d334', open: true, replies: [{ author: 'Carla Souza', text: 'Coberto em debfa2d7' }] },
    ],
  });
  assert.match(question, /Marcado como resolvido[\s\S]*Versão rebaixada/);
  assert.match(question, /Ainda aberto[\s\S]*Cenário sem teste/);
  assert.match(question, /Carla Souza: Coberto em debfa2d7/);
  assert.match(question, /"resolve"/);
  assert.match(question, /!45103/);
  assert.match(question, /git log --oneline 7ec24643\.\.b5c9d244/);
  assert.match(question, /git diff 7ec24643\.\.b5c9d244/);
  assert.match(question, /Versão rebaixada/);
  assert.match(question, /Volte para 1\.7\.0/);
  assert.match(question, /"reopen"/);
});

test('chat reply can ask to reopen a finding with what is missing', () => {
  const text = `Falta um.\n${CHAT_BLOCK_START}\n{"reopen":[{"title":"Versão rebaixada","missing":"o package-lock ainda diz 1.6.3","fixPrompt":"Rode npm install"},{"title":""}]}\n${CHAT_BLOCK_END}`;
  assert.deepEqual(parseChatReply(text).reopen, [{ title: 'Versão rebaixada', missing: 'o package-lock ainda diz 1.6.3', fixPrompt: 'Rode npm install' }]);
});

test('a finding comment carries, hidden, the commit it was posted on', () => {
  const text = formatFindingComment({ severity: 'BLOCKER', kind: 'code', title: 'x', headSha: '7ec2464300000000000000000000000000000000' });
  assert.match(text, /<!-- seal:finding-sha 7ec2464300000000000000000000000000000000 -->/);
  assert.doesNotMatch(formatFindingComment({ severity: 'BLOCKER', kind: 'code', title: 'x' }), /finding-sha/);
});

test('the commit of a resolved finding comes from its own mark, else from the summary posted right after it in the same run', () => {
  const summary = (sha, date) => ({ id: 90, status: 4, comments: [{ id: 1, ...myComment(`**⏸️ Aguardando autor** — r\n\n<!-- seal:reviewed ${sha} -->`, date) }] });
  const marked = { id: 1, status: 2, comments: [{ id: 1, ...myComment(`${findingWithPrompt('A', 'p')}\n\n<!-- seal:finding-sha aaaaaaa1 -->`, '2026-09-25T19:31:00Z') }] };
  const legacy = { id: 2, status: 2, comments: [{ id: 1, ...myComment(findingWithPrompt('B', 'p'), '2026-09-25T19:31:10Z') }] };
  const threads = [marked, legacy, summary('bbbbbbb2', '2026-09-25T19:31:40Z'), summary('ccccccc3', '2026-09-25T19:53:00Z')];
  const [a, b] = resolvedBotFindings(threads, ME);
  assert.equal(a.postedSha, 'aaaaaaa1');
  assert.equal(b.postedSha, null);
  assert.equal(findingPostedSha(a, threads, ME), 'aaaaaaa1');
  assert.equal(findingPostedSha(b, threads, ME), 'bbbbbbb2');
  assert.equal(findingPostedSha({ ...b, postedAt: '2026-09-25T20:00:00Z' }, threads, ME), null);
});

test('machine-local review rules are listed general first, repo-specific last, and the last one wins', () => {
  const line = localRulesInstruction(['/h/.config/seal/review-rules.md', '/h/.config/seal/review-rules/app-mobile.md']);
  assert.match(line, /review-rules\.md[\s\S]*review-rules\/app-mobile\.md/);
  assert.match(line, /later file wins/);
  assert.equal(localRulesInstruction([]), null);
});

test('a branch cut from the next release and aimed at main says what it drags along and that only its own work was reviewed', () => {
  const gate = checkTargetBranch({
    source: 'task/74642-desconto-campaign-precedence', target: 'main', nextRelease: 'release/1.7.0',
    carried: { release: 'release/1.7.0', base: 'abc', commits: 98, authors: ['Hugo Prado', 'Pedro Alves', 'TiagoRamos'] },
  });
  assert.equal(gate.severity, 'BLOCKER');
  assert.match(gate.body, /traz a `release\/1\.7\.0` \(saiu dela ou recebeu merge dela\): mergear em `main` leva junto 98 commits da release \(Hugo Prado, Pedro Alves e TiagoRamos\)/);
  assert.match(gate.body, /revisão do código fica parada até o destino mudar para `release\/1\.7\.0`/);
  assert.equal(gate.carriedRelease, 'release/1.7.0');
  const plain = checkTargetBranch({ source: 'task/1', target: 'main', nextRelease: 'release/1.7.0' });
  assert.doesNotMatch(plain.body, /leva junto/);
  assert.equal(plain.carriedRelease, undefined);
});

test('a target block summary stops the review without the reviewed marker, so retargeting the same commit reviews it', () => {
  const gate = checkTargetBranch({ source: 'task/1', target: 'main', nextRelease: 'release/1.7.0', carried: { release: 'release/1.7.0', commits: 3, authors: ['A'] } });
  const text = formatTargetBlockSummary({ gate, headSha: HEAD, prUrl: 'https://x/pullrequest/9', threadId: 7 });
  assert.match(text, /^\*\*❌ Reprovado\*\*/);
  assert.match(text, /discussionId=7/);
  assert.match(text, /o código não foi revisado/);
  assert.match(text, /Troque o destino para `release\/1\.7\.0`/);
  assert.doesNotMatch(text, /seal:reviewed/);
  const threads = [{ id: 1, status: 4, comments: [{ id: 1, ...myComment(text) }] }];
  assert.equal(hasTargetBlockSummary(threads, ME, HEAD), true);
  assert.equal(hasTargetBlockSummary(threads, ME, 'f'.repeat(40)), false);
  assert.equal(hasTargetBlockSummary([{ id: 1, comments: [{ id: 1, author: { uniqueName: 'other@x' }, content: text }] }], ME, HEAD), false);
  assert.equal(decideReviewGate({ pr: { pullRequestId: 9, creationDate: '2026-09-25', lastMergeSourceCommit: { commitId: HEAD } }, threads, myEmail: ME }).action, 'first-review');
});

test('the origin of a branch is main when main has its fork point, otherwise the oldest release that has it', () => {
  assert.equal(pickOriginBranch(['release/1.8.0', 'main', 'release/1.7.0']), 'main');
  assert.equal(pickOriginBranch(['release/1.10.0', 'release/1.8.0', 'release/1.7.0']), 'release/1.7.0');
  assert.equal(pickOriginBranch(['gmud/4.23.0']), 'gmud/4.23.0');
  assert.equal(pickOriginBranch([]), null);
  assert.equal(pickOriginBranch(['release/pipeline-test-trigger', 'release/4.24.0']), 'release/4.24.0');
  assert.equal(pickOriginBranch(['release/pipeline-test-trigger']), 'release/pipeline-test-trigger');
});

test('feature, bugfix, hotfix, release and gmud branches pass the name check silently', () => {
  for (const source of ['feature/74642-cupom', 'bugfix/1-x', 'hotfix/pallet', 'release/1.7.0', 'gmud/4.23.0']) {
    assert.equal(checkBranchName({ source, target: 'release/1.7.0' }), null, source);
  }
});

test('the names used so far pass with a reminder that teaches the new standard, fix/ by where it points', () => {
  const toMain = checkBranchName({ source: 'fix/pallet', target: 'main' });
  assert.equal(toMain.blocking, false);
  assert.match(toMain.body, /Para a `main`, o prefixo novo é `hotfix\/`/);
  assert.match(toMain.body, /feature\/<id>-descricao[\s\S]*bugfix\/<id>-descricao[\s\S]*hotfix\/<id>-descricao/);
  const toRelease = checkBranchName({ source: 'fix/new-order-product-sku', target: 'release/1.7.0' });
  assert.match(toRelease.body, /Para uma release, o prefixo novo é `bugfix\/`/);
  for (const source of ['task/74642-desconto', 'task-74287/valida-upload', 'feat/x', 'story/y', 'chore/z']) {
    assert.equal(checkBranchName({ source, target: 'release/1.8.0' }).blocking, false, source);
  }
});

test('a branch with no type is blocked with the steps to open a new PR from a branch with the right name', () => {
  const gate = checkBranchName({ source: 'update-release', target: 'release/1.7.0' });
  assert.equal(gate.severity, 'BLOCKER');
  assert.notEqual(gate.blocking, false);
  assert.match(gate.fixPrompt, /git checkout -b feature\/<id>-update-release origin\/update-release/);
  assert.match(gate.suggestion, /abandonar esta/);
  assert.equal(checkBranchName({ source: 'ds-quality-e-padroes-whitelabel', target: 'main' }).severity, 'BLOCKER');
  const summary = formatNameBlockSummary({ finding: gate, headSha: HEAD, prUrl: 'https://x/pullrequest/1', threadId: 3 });
  assert.match(summary, /^\*\*❌ Reprovado\*\*/);
  assert.match(summary, /o código não foi revisado/);
  assert.doesNotMatch(summary, /seal:reviewed/);
  assert.equal(hasTargetBlockSummary([{ id: 1, comments: [{ id: 1, ...myComment(summary) }] }], ME, HEAD), true);
});

test('the suggested name keeps the work item id and picks the type by where the PR points', () => {
  assert.equal(suggestBranchName('task/74642-desconto-campaign-precedence', 'release/1.7.0'), 'feature/74642-desconto-campaign-precedence');
  assert.equal(suggestBranchName('fix/pallet-sem-preco', 'main'), 'hotfix/<id>-pallet-sem-preco');
  assert.equal(suggestBranchName('fix/new-order-product-sku', 'release/1.7.0'), 'bugfix/<id>-new-order-product-sku');
});

test('a hotfix to main that carries release commits is blocked; a clean hotfix and release/gmud pass', () => {
  const carried = { release: 'release/1.7.0', base: 'abc', commits: 4, authors: ['Hugo Prado'] };
  const gate = checkTargetBranch({ source: 'hotfix/pallet', target: 'main', nextRelease: 'release/1.7.0', carried });
  assert.equal(gate.severity, 'BLOCKER');
  assert.equal(gate.carriedRelease, 'release/1.7.0');
  assert.match(gate.title, /Hotfix `hotfix\/pallet` leva a `release\/1\.7\.0` junto para a `main`/);
  assert.match(gate.fixPrompt, /git checkout -b hotfix\/pallet-v2 origin\/main/);
  assert.equal(checkTargetBranch({ source: 'hotfix/pallet', target: 'main', nextRelease: 'release/1.7.0' }), null);
  assert.equal(checkTargetBranch({ source: 'hotfix/pallet', target: 'main', nextRelease: 'release/1.7.0', carried: { ...carried, commits: 0 } }), null);
  assert.equal(checkTargetBranch({ source: 'gmud/1.7.0', target: 'main', nextRelease: 'release/1.7.0', carried }), null);
  const summary = formatTargetBlockSummary({ gate, headSha: HEAD });
  assert.match(summary, /Recrie a branch a partir da `main`/);
  assert.doesNotMatch(summary, /Troque o destino/);
});

test('a wrong target teaches where feature, bugfix and hotfix go, and when it is really a hotfix', () => {
  const toMain = checkTargetBranch({ source: 'feature/1-x', target: 'main', nextRelease: 'release/1.8.0' });
  assert.match(toMain.body, /feature\/<id>-descricao[\s\S]*bugfix\/<id>-descricao[\s\S]*hotfix\/<id>-descricao/);
  assert.match(toMain.body, /bug em produção que não pode esperar a GMUD, é hotfix/);
  assert.match(toMain.body, /troque o destino para `release\/1\.8\.0`/);
  const oldRelease = checkTargetBranch({ source: 'feature/1-x', target: 'release/1.6.0', nextRelease: 'release/1.8.0' });
  assert.match(oldRelease.body, /Para onde cada tipo vai/);
});
