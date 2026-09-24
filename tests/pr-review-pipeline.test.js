import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCK_TEXT,
  RESULT_BLOCK_START,
  RESULT_BLOCK_END,
  buildThreadPayload,
  checkTargetBranch,
  decideReviewGate,
  deriveVerdict,
  nextReleaseFrom,
  followUpReasons,
  formatFindingComment,
  formatSummaryComment,
  isMarkedSent,
  postedFindingTitles,
  planReviewChunks,
  needsChunking,
  isGeneratedPath,
  buildChatPrompt,
  parseChatReply,
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
  assert.deepEqual(parseChatReply(reply), { answer: 'Você tem razão, o backend já ordena.', resolves: [{ title: 'firstAllowedDay supõe ordem', reason: 'o backend garante' }] });
  assert.deepEqual(parseChatReply('Mantenho o achado.'), { answer: 'Mantenho o achado.', resolves: [] });
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
