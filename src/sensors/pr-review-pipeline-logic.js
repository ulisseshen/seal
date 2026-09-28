import { VOTE_MAP } from './azure-pr-review-logic.js';

export const LOCK_TEXT = '🔍 Revisando…';
export const PUBLISHED_MARKER = '[seal:published]';
export const PUBLISH_FAILED_MARKER = '[seal:publish-failed]';
export const RESULT_BLOCK_START = '<<<SEAL_REVIEW_JSON';
export const RESULT_BLOCK_END = 'SEAL_REVIEW_JSON>>>';

const REVIEWED_MARKER_RE = /<!--\s*seal:reviewed\s+([0-9a-f]{7,40})\s*-->/i;
const SEVERITIES = ['BLOCKER', 'WARNING', 'NIT'];
const KINDS = ['code', 'test-gap', 'doc-request'];
const DAY_MS = 24 * 60 * 60 * 1000;

const THREAD_STATUS_ACTIVE = 1;
const THREAD_STATUS_CLOSED = 4;
const THREAD_STATUS_PENDING = 6;
const MISSING_CRITERIA_RE = /\bsem\s+crit[ée]rios?\s+de\s+aceite\b/i;
export const REMINDER_LABEL = 'LEMBRETE · não bloqueia';

export const isAcceptanceReminder = (finding) => finding?.kind === 'doc-request' && MISSING_CRITERIA_RE.test(finding?.title || '');
export const isBlocking = (finding) => finding?.blocking !== false;
export const blockingFindings = (findings) => (findings || []).filter(isBlocking);

export const reviewedMarker = (sha) => `<!-- seal:reviewed ${sha} -->`;

const commentAt = (comment) => new Date(comment?.publishedDate || comment?.lastUpdatedDate || 0).getTime();
const isMine = (author, myEmail) => (author?.uniqueName || '').toLowerCase() === myEmail;
const isActiveThread = (thread) => thread.status === 'active' || thread.status === THREAD_STATUS_ACTIVE;

export function findLastReviewedSha(threads, myEmail) {
  let latest = null;
  let latestAt = -1;
  for (const thread of threads || []) {
    for (const comment of thread.comments || []) {
      if (!isMine(comment.author, myEmail) || comment.isDeleted) continue;
      const match = (comment.content || '').match(REVIEWED_MARKER_RE);
      if (!match) continue;
      const at = commentAt(comment);
      if (at > latestAt) {
        latestAt = at;
        latest = match[1].toLowerCase();
      }
    }
  }
  return latest;
}

export function hasReviewLock(threads, myEmail) {
  return (threads || []).some((thread) =>
    (thread.comments || []).some((comment) => !comment.isDeleted && isMine(comment.author, myEmail) && (comment.content || '').includes(LOCK_TEXT)),
  );
}

export function decideReviewGate({ pr, threads, myEmail, eligibilityStart = 0, testPrs = new Set(), ledgerForHead = null, lastPublishedSha = null }) {
  const isTestPr = testPrs.has(pr.pullRequestId);
  if ((pr.createdBy?.uniqueName || '').toLowerCase() === myEmail && !isTestPr) return { action: 'skip', reason: 'own-pr' };
  if (pr.isDraft) return { action: 'skip', reason: 'draft' };
  if (new Date(pr.creationDate || 0).getTime() < eligibilityStart && !isTestPr) return { action: 'skip', reason: 'before-start' };

  const myReviewer = (pr.reviewers || []).find((reviewer) => (reviewer.uniqueName || '').toLowerCase() === myEmail);
  if (myReviewer && myReviewer.vote >= VOTE_MAP['approved-with-suggestions']) return { action: 'skip', reason: 'approved' };

  const headSha = (pr.lastMergeSourceCommit?.commitId || '').toLowerCase();
  if (!headSha) return { action: 'skip', reason: 'no-head-sha' };
  const retry = ledgerForHead?.status === 'failed' && Boolean(ledgerForHead.retry_due);
  if (ledgerForHead && !retry) {
    const waiting = ledgerForHead.status === 'failed' && ledgerForHead.retry_at;
    return { action: 'skip', reason: waiting ? 'ledger-failed-retry-later' : `ledger-${ledgerForHead.status}` };
  }

  if (hasReviewLock(threads, myEmail)) return { action: 'skip', reason: 'locked' };

  const extra = retry ? { retry: true } : {};
  const reviewedSha = (lastPublishedSha || findLastReviewedSha(threads, myEmail) || '').toLowerCase() || null;
  if (!reviewedSha) return { action: 'first-review', headSha, ...extra };
  if (headSha.startsWith(reviewedSha) || reviewedSha.startsWith(headSha)) return { action: 'skip', reason: 'up-to-date' };
  return { action: 're-review', headSha, previousSha: reviewedSha, ...extra };
}

export const localRulesInstruction = (paths) =>
  paths.length
    ? `Then read, in this order: ${paths.join(', ')}. They are machine-local review rules that complement the pipeline and the repo's own skills; on conflict the later file wins over everything before it.`
    : null;

export const needsCommitVerification = ({ ledgerForHead }) =>
  ledgerForHead?.status === 'published' && ledgerForHead.verdict === 'needs-work' && Number(ledgerForHead.findings) === 0 && !ledgerForHead.verify_requested_at;

const FAILURE_NOTICE_RE = /^⚠️ A revisão automática (falhou|foi interrompida|não gerou)/;

export function staleFailureNotices({ threads, myEmail, headStatus }) {
  if (headStatus !== 'published') return [];
  return (threads || []).flatMap((thread) =>
    (thread.comments || [])
      .filter((comment) => !comment.isDeleted && isMine(comment.author, myEmail) && FAILURE_NOTICE_RE.test(comment.content || ''))
      .map((comment) => ({ threadId: thread.id, commentId: comment.id })),
  );
}

const TRANSIENT_FAILURE_RE = /sigterm|exit code (143|-2)\b|orphaned|enoent|no such file|worktree missing|econnreset|etimedout|enotfound|eai_again|socket hang up|network|overloaded|api error: 5\d\d|usage limit|limite/i;

export const classifyReviewFailure = (error) => (TRANSIENT_FAILURE_RE.test(String(error || '')) ? 'transient' : 'permanent');

const mentionsPr = (text, prId) =>
  new RegExp(`(pullrequest/${prId}\\b|\\bPR\\s*#?\\s*${prId}\\b|!${prId}\\b)`, 'i').test(text || '');

export function matchPairedPrs(pr, prWorkItemIds, candidates, prStoryIds = []) {
  const ownText = `${pr.title || ''}\n${pr.description || ''}`;
  const ownItems = new Set((prWorkItemIds || []).map(String));
  const ownStories = new Set((prStoryIds || []).map(String));
  const matches = [];
  for (const { pr: candidate, workItemIds = [], storyIds = [] } of candidates || []) {
    const reasons = [];
    if (candidate.sourceRefName && candidate.sourceRefName === pr.sourceRefName) reasons.push('same-branch');
    if (workItemIds.some((id) => ownItems.has(String(id)))) reasons.push('same-work-item');
    else if (storyIds.some((id) => ownStories.has(String(id)))) reasons.push('same-story');
    const candidateText = `${candidate.title || ''}\n${candidate.description || ''}`;
    if (mentionsPr(ownText, candidate.pullRequestId) || mentionsPr(candidateText, pr.pullRequestId)) reasons.push('mentioned');
    if (reasons.length > 0) matches.push({ pr: candidate, reasons });
  }
  return matches;
}

function extractBlock(text) {
  const source = String(text || '');
  const start = source.lastIndexOf(RESULT_BLOCK_START);
  if (start < 0) return null;
  const end = source.indexOf(RESULT_BLOCK_END, start);
  if (end < 0) return null;
  return source
    .slice(start + RESULT_BLOCK_START.length, end)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
}

function normalizeFinding(raw) {
  const severity = String(raw?.severity || '').toUpperCase();
  const kind = KINDS.includes(raw?.kind) ? raw.kind : 'code';
  const line = Number.isInteger(raw?.line) && raw.line > 0 ? raw.line : null;
  const title = String(raw?.title || '').trim();
  return {
    severity: SEVERITIES.includes(severity) ? severity : 'WARNING',
    blocking: raw?.blocking === false ? false : !isAcceptanceReminder({ kind, title }),
    kind,
    file: raw?.file ? String(raw.file).replace(/^\/+/, '') : null,
    line,
    endLine: Number.isInteger(raw?.endLine) && line && raw.endLine >= line ? raw.endLine : line,
    title,
    body: String(raw?.body || '').trim(),
    rule: raw?.rule ? String(raw.rule).trim() : null,
    suggestion: raw?.suggestion ? String(raw.suggestion).trim() : null,
    fixPrompt: raw?.fixPrompt ? String(raw.fixPrompt).trim() : null,
    sources: Array.isArray(raw?.sources) ? raw.sources.map(String) : [],
  };
}

function normalizeUsCoverage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const scenarios = (Array.isArray(raw.scenarios) ? raw.scenarios : [])
    .map((scenario, index) => ({
      id: String(scenario?.id || `C${index + 1}`),
      text: String(scenario?.text || '').trim(),
      covered: scenario?.covered === true,
      test: scenario?.test ? String(scenario.test) : null,
      where: scenario?.where ? String(scenario.where) : null,
    }))
    .filter((scenario) => scenario.text);
  const total = Number(raw.total ?? scenarios.length) || 0;
  const covered = Number(raw.covered ?? scenarios.filter((scenario) => scenario.covered).length) || 0;
  return { total, covered, note: raw.note ? String(raw.note) : '', source: raw.source ? String(raw.source) : null, scenarios };
}

export function usScenarioFinding(usCoverage, { repo, prUrl, testSkills = [] } = {}) {
  if (!usCoverage || usCoverage.total <= 0 || usCoverage.covered >= usCoverage.total) return null;
  const missing = usCoverage.scenarios.filter((scenario) => !scenario.covered);
  const gap = usCoverage.total - usCoverage.covered;
  const list = missing.length
    ? missing.map((scenario) => `- **${scenario.id}** ${scenario.text}${scenario.where ? ` → \`${scenario.where}\`` : ''}`).join('\n')
    : `- ${usCoverage.note || 'a revisão não detalhou quais cenários faltam; confira os critérios de aceite da US.'}`;
  const skillHint = testSkills.length ? `Use a skill ${testSkills.map((name) => `/${name}`).join(' ou ')} deste repo.` : 'Siga o padrão de testes que o repo já usa.';
  const scenarioPrompt = missing.length
    ? missing.map((scenario) => `${scenario.id}. ${scenario.text}${scenario.where ? `\n   Onde: ${scenario.where}` : ''}`).join('\n')
    : (usCoverage.note || 'Leia os critérios de aceite da US vinculada e liste os cenários sem teste.');
  return {
    severity: 'WARNING',
    kind: 'test-gap',
    file: null,
    line: null,
    endLine: null,
    title: gap === 1 ? '1 cenário da US sem teste' : `${gap} cenários da US sem teste (de ${usCoverage.total})`,
    body: `${usCoverage.source ? `Critérios de aceite de ${usCoverage.source}. ` : ''}Cenários sem teste que prove o comportamento:\n\n${list}`,
    rule: 'Cobertura dos cenários da US',
    suggestion: gap === 1 ? 'Escrever o teste do cenário acima.' : 'Escrever um teste por cenário acima.',
    fixPrompt: [
      `No repo ${repo}${prUrl ? ` (PR ${prUrl})` : ''}, escreva os testes dos cenários da US que ainda não têm teste:`,
      '',
      scenarioPrompt,
      '',
      skillHint,
      'Padrão /tdd: um teste por cenário, pela interface pública do módulo (o que o chamador/usuário vê), mock só na fronteira (HTTP, banco, tempo), valor esperado vindo do critério de aceite e não recalculado do jeito que o código calcula, nome do teste descrevendo o comportamento.',
      'Não altere código de produção. Se um cenário não passar, reporte o que o código faz em vez de ajustar o teste para passar.',
      'Rode a suíte de testes do repo e confirme que todos os testes novos passam.',
    ].join('\n'),
    sources: ['us-coverage'],
  };
}

export function applyUsScenarioFinding(findings, usCoverage, context) {
  const finding = usScenarioFinding(usCoverage, context);
  if (!finding) return findings;
  const kept = findings.filter((existing) => !(existing.kind === 'test-gap' && existing.sources.length > 0 && existing.sources.every((source) => source === 'us-coverage')));
  return [finding, ...kept];
}

export const deriveVerdict = (findings) => (blockingFindings(findings).length > 0 ? 'needs-work' : 'approved');

export function parseReviewResult(text) {
  const block = extractBlock(text);
  if (!block) return { ok: false, error: 'missing-result-block' };
  let data;
  try {
    data = JSON.parse(block);
  } catch (err) {
    return { ok: false, error: `invalid-json: ${err.message}` };
  }
  const findings = (Array.isArray(data?.findings) ? data.findings : []).map(normalizeFinding).filter((finding) => finding.title);
  const verdict = deriveVerdict(findings);
  return {
    ok: true,
    data: {
      verdict,
      modelVerdict: data?.verdict in VOTE_MAP ? data.verdict : null,
      blockingReason: String(data?.blockingReason || '').trim(),
      summary: String(data?.summary || '').trim(),
      findings,
      usCoverage: normalizeUsCoverage(data?.usCoverage),
      pairedPrs: Array.isArray(data?.pairedPrs) ? data.pairedPrs : [],
      stagesRun: Array.isArray(data?.stagesRun) ? data.stagesRun.map(String) : [],
      priorResolved: (Array.isArray(data?.priorResolved) ? data.priorResolved : [])
        .map((item) => ({ threadId: Number(item?.threadId), title: String(item?.title || '').trim(), reason: String(item?.reason || '').trim() }))
        .filter((item) => Number.isInteger(item.threadId) && item.threadId > 0),
    },
  };
}

export const countBySeverity = (findings) => {
  const blocking = blockingFindings(findings);
  return SEVERITIES.reduce((counts, severity) => ({ ...counts, [severity.toLowerCase()]: blocking.filter((finding) => finding.severity === severity).length }), {});
};

export const threadStatusFor = (severity) => (severity === 'NIT' ? THREAD_STATUS_PENDING : THREAD_STATUS_ACTIVE);

const KIND_LABEL = { 'test-gap': 'Teste faltando', 'doc-request': 'Documentação' };

export function formatFindingComment(finding, { includeLocation = false } = {}) {
  const label = KIND_LABEL[finding.kind] ? ` · ${KIND_LABEL[finding.kind]}` : '';
  const tag = isBlocking(finding) ? `${finding.severity}${label}` : REMINDER_LABEL;
  const parts = [`**[${tag}] ${finding.title}**`];
  if (includeLocation && finding.file) parts.push(`\`${finding.file}${finding.line ? `:${finding.line}` : ''}\``);
  if (finding.body) parts.push(finding.body);
  const meta = [finding.rule && `**Regra**: ${finding.rule}`, finding.suggestion && `**Sugestão**: ${finding.suggestion}`].filter(Boolean);
  if (meta.length > 0) parts.push(meta.join('\n'));
  if (finding.fixPrompt) {
    parts.push(`<details>\n<summary>🤖 Prompt de correção</summary>\n\n\`\`\`\n${finding.fixPrompt.replace(/```/g, "'''")}\n\`\`\`\n</details>`);
  }
  if (finding.headSha) parts.push(`<!-- seal:finding-sha ${finding.headSha} -->`);
  return parts.join('\n\n');
}

export const pendingCommentsText = (total) =>
  total === 1
    ? '1 comentário nesta PR, com o prompt de correção.'
    : `${total} comentários nesta PR, cada um com o prompt de correção.`;

const OPEN_THREAD_STATUSES = new Set([1, 'active', 6, 'pending']);
const FINDING_SHA_RE = /<!--\s*seal:finding-sha\s+([0-9a-f]{7,40})\s*-->/i;
const FIX_PROMPT_RE = /<summary>🤖 Prompt de correção<\/summary>\s*```\n?([\s\S]*?)\n?```/;

export function resolvedBotFindings(threads, myEmail) {
  return (threads || []).flatMap((thread) => {
    if (OPEN_THREAD_STATUSES.has(thread.status) || thread.isDeleted) return [];
    const [first] = thread.comments || [];
    if (!first || first.isDeleted || !isMine(first.author, myEmail)) return [];
    const content = first.content || '';
    if (content.startsWith(`**[${REMINDER_LABEL}]`)) return [];
    const match = content.match(/^\*\*\[[^\]]+\]\s*(.+?)\*\*/);
    if (!match) return [];
    const prompt = content.match(FIX_PROMPT_RE);
    const mark = content.match(FINDING_SHA_RE);
    return [{ threadId: thread.id, title: match[1].trim(), fixPrompt: prompt ? prompt[1].trim() : null, postedAt: first.publishedDate || null, postedSha: mark ? mark[1].toLowerCase() : null }];
  });
}

export function findingPostedSha(finding, threads, myEmail) {
  if (finding.postedSha) return finding.postedSha;
  if (!finding.postedAt) return null;
  const summaries = (threads || []).flatMap((thread) => (thread.comments || [])
    .filter((comment) => !comment.isDeleted && isMine(comment.author, myEmail) && comment.publishedDate >= finding.postedAt)
    .map((comment) => ({ at: comment.publishedDate, sha: (comment.content || '').match(REVIEWED_MARKER_RE)?.[1] }))
    .filter((item) => item.sha));
  summaries.sort((a, b) => a.at.localeCompare(b.at));
  return summaries[0]?.sha?.toLowerCase() || null;
}

export function buildVerifyResolvedQuestion({ prId, headSha, findings }) {
  const block = (item) => [
    `${item.open ? 'Ainda aberto' : 'Marcado como resolvido'}: ${item.title} (thread ${item.threadId})`,
    `Commits depois do comentário: \`git log --oneline ${item.sinceSha}..${headSha}\` · mudança: \`git diff ${item.sinceSha}..${headSha}\``,
    item.fixPrompt ? `Prompt de correção original:\n${item.fixPrompt}` : null,
    ...(item.replies || []).map((reply) => `${reply.author}: ${reply.text}`),
  ].filter(Boolean).join('\n');
  return [
    `A revisão do head ${headSha} da PR !${prId} não achou nada novo, mas ficaram comentários anteriores. Confira, nos commits que entraram depois de cada comentário, se a correção está no código:`,
    '',
    findings.map(block).join('\n\n'),
    '',
    'Para cada um:',
    '- Ainda aberto e corrigido no código: liste em "resolve" com o título exato e o motivo.',
    '- Não corrigido, ou corrigido pela metade (aberto ou marcado como resolvido): liste em "reopen": {"reopen": [{"title": "título exato", "missing": "o que ainda falta, com arquivo:linha", "fixPrompt": "prompt autocontido para corrigir só o que falta"}]}.',
    '- Marcado como resolvido e corrigido: não precisa listar.',
    'Uma resposta do autor explicando que já está coberto só vale se o código confirmar.',
  ].join('\n');
}

export function openBotFindings(threads, myEmail, { excludeThreadIds = [] } = {}) {
  const excluded = new Set(excludeThreadIds.map(Number));
  return (threads || []).flatMap((thread) => {
    if (excluded.has(Number(thread.id)) || !OPEN_THREAD_STATUSES.has(thread.status) || thread.isDeleted) return [];
    const [first] = thread.comments || [];
    if (!first || first.isDeleted || !isMine(first.author, myEmail)) return [];
    if ((first.content || '').startsWith(`**[${REMINDER_LABEL}]`)) return [];
    const match = (first.content || '').match(/^\*\*\[[^\]]+\]\s*(.+?)\*\*/);
    if (!match) return [];
    const prompt = (first.content || '').match(FIX_PROMPT_RE);
    const mark = (first.content || '').match(FINDING_SHA_RE);
    const replies = (thread.comments || []).slice(1)
      .filter((comment) => !comment.isDeleted && comment.commentType !== 'system' && !isMine(comment.author, myEmail) && (comment.content || '').trim())
      .map((comment) => ({ author: comment.author?.displayName || comment.author?.uniqueName || 'autor', text: comment.content.trim() }));
    return [{ threadId: thread.id, title: match[1].trim(), fixPrompt: prompt ? prompt[1].trim() : null, postedAt: first.publishedDate || null, postedSha: mark ? mark[1].toLowerCase() : null, replies }];
  });
}

export function countOpenBotThreads(threads, myEmail, { excludeThreadIds = [] } = {}) {
  const excluded = new Set(excludeThreadIds.map(Number));
  return (threads || []).filter((thread) => {
    if (excluded.has(Number(thread.id)) || !OPEN_THREAD_STATUSES.has(thread.status) || thread.isDeleted) return false;
    const [first] = thread.comments || [];
    if (!first || first.isDeleted || !isMine(first.author, myEmail)) return false;
    const content = first.content || '';
    return !content.includes(LOCK_TEXT) && !REVIEWED_MARKER_RE.test(content) && !content.startsWith(`**[${REMINDER_LABEL}]`);
  }).length;
}

export const verdictFor = (newFindings, priorOpen = 0) => (newFindings + priorOpen > 0 ? 'needs-work' : 'approved');

const FINDING_HEADER_RE = /^\*\*\[([^\]]+)\] ([^\n]*?)\*\*/;

export function relabelAsReminder(content) {
  const match = FINDING_HEADER_RE.exec(content || '');
  if (!match) return null;
  const [header, tag, title] = match;
  if (tag === REMINDER_LABEL) return null;
  const kind = /Documentação/.test(tag) ? 'doc-request' : 'code';
  if (!isAcceptanceReminder({ kind, title })) return null;
  return content.replace(header, `**[${REMINDER_LABEL}] ${title}**`);
}

export function severityOfComment(content) {
  const match = FINDING_HEADER_RE.exec(content || '');
  if (!match || match[1] === REMINDER_LABEL) return null;
  const severity = match[1].split(' · ')[0];
  return SEVERITIES.includes(severity) ? severity : null;
}

export function formatSummaryComment({ data, headSha, priorOpen = 0, priorThreads = [], prUrl = null }) {
  const total = blockingFindings(data.findings).length;
  const reminders = data.findings.length - total;
  const pending = total + priorOpen;
  const priorText = priorOpen === 1 ? '1 comentário da revisão anterior continua aberto.' : `${priorOpen} comentários da revisão anterior continuam abertos.`;
  const fallbackReason = total > 0
    ? (total === 1 ? 'há 1 comentário para resolver antes de aprovar.' : `há ${total} comentários para resolver antes de aprovar.`)
    : priorText.charAt(0).toLowerCase() + priorText.slice(1);
  const detail = [total > 0 ? pendingCommentsText(total) : null, priorOpen > 0 && total > 0 ? priorText : null].filter(Boolean).join(' ');
  const lines = pending > 0
    ? [
        `**⏸️ Aguardando autor** — ${data.blockingReason || fallbackReason}`,
        '',
        `${detail ? `${detail} ` : ''}Resolva e faça push: a PR é revisada de novo no próximo commit.`,
      ]
    : ['**✅ Aprovado** — nenhum ponto pendente.'];
  if (pending > 0 && priorThreads.length > 0) {
    const link = (item) => (prUrl ? `[${item.title}](${prUrl}?discussionId=${item.threadId})` : item.title);
    lines.push('', 'Continuam abertos:');
    for (const item of priorThreads) {
      lines.push(`- ${link(item)}`);
    }
    lines.push('', 'O prompt de correção está em cada comentário. A cada push o revisor confere esses pontos no código e fecha sozinho o que foi corrigido.');
  }
  if (reminders > 0) {
    lines.push('', reminders === 1
      ? '📝 1 lembrete para o autor, que não bloqueia a aprovação.'
      : `📝 ${reminders} lembretes para o autor, que não bloqueiam a aprovação.`);
  }
  lines.push('', reviewedMarker(headSha));
  return lines.join('\n');
}

export function buildThreadPayload(finding) {
  const payload = {
    comments: [{ parentCommentId: 0, content: formatFindingComment(finding), commentType: 1 }],
    status: isBlocking(finding) ? threadStatusFor(finding.severity) : THREAD_STATUS_CLOSED,
  };
  if (finding.file && finding.line) {
    payload.threadContext = {
      filePath: `/${finding.file}`,
      rightFileStart: { line: finding.line, offset: 1 },
      rightFileEnd: { line: finding.endLine || finding.line, offset: 1 },
    };
  }
  return payload;
}

export function followUpReasons({ pr, threads, myEmail, now = Date.now(), pairedStatuses = [] }) {
  const reasons = [];
  if (now - new Date(pr.creationDate || now).getTime() > DAY_MS) reasons.push('open-over-1d');

  const staleThreads = (threads || []).filter((thread) => {
    if (!isActiveThread(thread) || thread.isDeleted) return false;
    const comments = (thread.comments || []).filter((comment) => comment.commentType !== 'system' && !comment.isDeleted);
    const last = comments[comments.length - 1];
    return last && isMine(last.author, myEmail) && now - commentAt(last) > DAY_MS;
  });
  if (staleThreads.length > 0) reasons.push('stale-no-response');

  if (pairedStatuses.some((status) => status === 'completed' || status === 'abandoned')) reasons.push('pair-desync');
  return reasons;
}

export function shouldNotify(notified, reason, now = Date.now(), cooldownMs = DAY_MS) {
  const last = notified?.[reason] ? new Date(notified[reason]).getTime() : 0;
  return now - last >= cooldownMs;
}

const REASON_TEXT = {
  blocker: (entry) => {
    const total = Object.values(entry.counts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const pending = total === 1 ? 'deixou 1 comentário para resolver, com o prompt de correção' : `deixou ${total || 'alguns'} comentários para resolver, cada um com o prompt de correção`;
    return `Oi ${entry.authorFirstName}, a PR !${entry.prId} (${entry.title}) ficou aguardando você: a revisão ${pending}. Depois do push ela é revisada de novo. ${entry.url}`;
  },
  'stale-no-response': (entry) => `Oi ${entry.authorFirstName}, ficaram comentários sem resposta há mais de 1 dia na PR !${entry.prId} (${entry.title}). Pode responder ou marcar como resolvido? ${entry.url}`,
  'open-over-1d': (entry) => `Oi ${entry.authorFirstName}, a PR !${entry.prId} (${entry.title}) está aberta há mais de 1 dia. Falta algo para ela andar? ${entry.url}`,
  'pair-desync': (entry) => `Oi ${entry.authorFirstName}, a PR par da !${entry.prId} já foi fechada no outro repo e esta segue aberta. As duas precisam subir juntas — dá para alinhar? ${entry.url}`,
};

export function messageDraftFor(reason, entry) {
  const build = REASON_TEXT[reason];
  return build ? build(entry) : null;
}

const MAINLINE_SOURCES = /^(release|hotfix|gmud)\//i;

const parseVersion = (text) => {
  const match = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
};

const compareVersions = (left, right) => {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};

export function nextReleaseFrom(mainVersion) {
  const version = parseVersion(mainVersion);
  return version ? `release/${version[0]}.${version[1] + 1}.0` : null;
}

// Branch naming. The team's new standard is feature/bugfix/hotfix; the names used so far still pass with a
// reminder, and a branch with no type at all is sent back before any review (it is the cheapest fix, so first).
const CANONICAL_BRANCH = /^(feature|bugfix|hotfix|release|gmud)\//;
const LEGACY_BRANCH = /^(fix|feat|task|tasks?-[\w-]+|story|chore|merge|sync|docs|test|bugfix-[\w-]+)\//;

const BRANCH_TYPES_TEXT = [
  '- `feature/<id>-descricao`: funcionalidade nova ou mudança de comportamento. Sai da próxima release e volta para ela.',
  '- `bugfix/<id>-descricao`: bug que ainda não chegou em produção (está na release). Sai da release e volta para ela.',
  '- `hotfix/<id>-descricao`: bug em produção que não pode esperar a próxima GMUD. Sai da `main` e volta para a `main`.',
].join('\n');

export function suggestBranchName(source, target) {
  const rest = String(source || '').replace(/^[^/]*\//, '');
  const id = (String(source).match(/\d{4,}/) || [])[0] || '<id>';
  const slug = rest.replace(/\d{4,}/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'descricao';
  const kind = target === 'main' ? 'hotfix' : /^(fix|bugfix)|bug|fix/i.test(source) ? 'bugfix' : 'feature';
  return `${kind}/${id}-${slug}`;
}

export function checkBranchName({ source, target }) {
  if (!source || CANONICAL_BRANCH.test(source)) return null;
  const suggestion = suggestBranchName(source, target);
  if (LEGACY_BRANCH.test(source)) {
    const hint = /^fix\//.test(source)
      ? (target === 'main' ? 'Para a `main`, o prefixo novo é `hotfix/`.' : 'Para uma release, o prefixo novo é `bugfix/`.')
      : `O prefixo novo para este trabalho seria \`${suggestion.split('/')[0]}/\`.`;
    return {
      kind: 'doc-request', blocking: false, file: null, line: null, rule: 'Nome da branch',
      severity: 'NIT',
      title: `Branch \`${source}\` no padrão antigo de nome`,
      body: `${hint} Nas próximas, use o padrão novo:\n\n${BRANCH_TYPES_TEXT}`,
      suggestion: `Na próxima branch, algo como \`${suggestion}\`. Não precisa refazer esta PR.`,
      sources: ['branch-gate'],
    };
  }
  return {
    kind: 'code', severity: 'BLOCKER', file: null, line: null, rule: 'Nome da branch',
    title: `Branch \`${source}\` sem o tipo no nome`,
    body: `O nome da branch diz o tipo do trabalho e para onde ele vai. Os tipos são:\n\n${BRANCH_TYPES_TEXT}\n\nO Azure não deixa trocar a branch de uma PR aberta, então o caminho é abrir outra.`,
    suggestion: `Criar \`${suggestion}\` a partir desta branch, abrir uma PR nova com ela e abandonar esta.`,
    fixPrompt: `A branch \`${source}\` não segue o padrão de nome (feature/, bugfix/ ou hotfix/). Crie a branch certa a partir dela e publique: \`git fetch origin && git checkout -b ${suggestion} origin/${source} && git push -u origin ${suggestion}\`. Abra uma PR nova de \`${suggestion}\` para \`${target}\` com o mesmo título e descrição, e abandone a PR atual.`,
    sources: ['branch-gate'],
  };
}

export function formatNameBlockSummary({ finding, headSha, prUrl = null, threadId = null }) {
  const title = prUrl && threadId ? `[${finding.title}](${prUrl}?discussionId=${threadId})` : finding.title;
  return [
    `**❌ Reprovado** — ${title}.`,
    '',
    'Revisei só o nome da branch: o código não foi revisado. Abra uma PR nova com a branch no padrão (o passo a passo está no comentário) e abandone esta; a revisão roda na PR nova.',
    '',
    `<!-- seal:target-blocked ${headSha} -->`,
  ].join('\n');
}

const listNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`);

// Where a branch was cut from: of the mainline refs that contain its fork point, main wins (release
// branches contain main's history too), then the oldest release, which is where that commit was born.
export function pickOriginBranch(containing) {
  const refs = (containing || []).filter(Boolean);
  if (refs.includes('main')) return 'main';
  const releases = refs.filter((ref) => /^release\//.test(ref));
  const versioned = releases.filter((ref) => parseVersion(ref)).sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)));
  return versioned[0] || releases.sort()[0] || refs.sort()[0] || null;
}

export function checkTargetBranch({ source, target, nextRelease, defaultBranch = 'main', carried = null }) {
  const next = parseVersion(nextRelease);
  if (!next) return null;
  const fixPrompt = `A PR de \`${source}\` aponta para \`${target}\`, mas trabalho novo entra na próxima release, \`${nextRelease}\` (versão da main + 1). No Azure DevOps, edite a PR e troque a branch de destino para \`${nextRelease}\`. Se houver conflito, faça rebase de \`${source}\` sobre \`origin/${nextRelease}\` e rode a suíte de testes do repo antes do push.`;
  const base = { kind: 'code', file: null, line: null, rule: 'Gate de branch de destino', fixPrompt, sources: ['target-gate'] };

  if (target === defaultBranch) {
    if (/^hotfix\//i.test(source) && carried?.commits > 0) {
      return {
        ...base,
        fixPrompt: `O hotfix \`${source}\` leva para \`${defaultBranch}\` ${carried.commits} commits da \`${carried.release}\` que não são dele. Crie a branch de novo a partir da main (\`git fetch origin && git checkout -b ${source}-v2 origin/${defaultBranch}\`), traga só os commits do hotfix com \`git cherry-pick\`, publique, abra uma PR nova para \`${defaultBranch}\` e abandone esta.`,
        severity: 'BLOCKER',
        carriedRelease: carried.release,
        title: `Hotfix \`${source}\` leva a \`${carried.release}\` junto para a \`${defaultBranch}\``,
        body: `Hotfix sai da \`${defaultBranch}\` e leva só a correção. Esta branch traz ${carried.commits === 1 ? '1 commit' : `${carried.commits} commits`} da \`${carried.release}\`${carried.authors?.length ? ` (${listNames(carried.authors)})` : ''} que ainda não passaram pela GMUD. A revisão do código fica parada até a branch levar só o hotfix.`,
        suggestion: 'Recriar a branch a partir da main com cherry-pick só dos commits do hotfix, abrir uma PR nova e abandonar esta.',
      };
    }
    if (MAINLINE_SOURCES.test(source)) return null;
    const carriedText = carried?.commits > 0
      ? ` A branch traz a \`${carried.release}\` (saiu dela ou recebeu merge dela): mergear em \`${defaultBranch}\` leva junto ${carried.commits === 1 ? '1 commit' : `${carried.commits} commits`} da release${carried.authors?.length ? ` (${listNames(carried.authors)})` : ''} que ainda não passaram pela GMUD. A revisão do código fica parada até o destino mudar para \`${carried.release}\`.`
      : '';
    return {
      ...base,
      severity: 'BLOCKER',
      title: `PR de trabalho apontando para \`${defaultBranch}\``,
      body: `\`${source}\` não é release, hotfix nem gmud, então não entra direto em \`${defaultBranch}\`. A próxima release é \`${nextRelease}\`.${carriedText}\n\nPara onde cada tipo vai:\n\n${BRANCH_TYPES_TEXT}\n\nSe é bug em produção que não pode esperar a GMUD, é hotfix: recrie a branch como \`hotfix/…\` a partir da \`${defaultBranch}\`. Senão, troque o destino para \`${nextRelease}\`.`,
      ...(carried?.commits > 0 ? { carriedRelease: carried.release } : {}),
      suggestion: `Trocar o destino para \`${nextRelease}\`, ou renomear a branch para \`hotfix/…\` se for de fato um hotfix.`,
    };
  }
  const targetVersion = /^release\//.test(target) ? parseVersion(target) : null;
  if (!targetVersion || MAINLINE_SOURCES.test(source)) return null;
  if (compareVersions(targetVersion, next) >= 0) return null;
  return {
    ...base,
    severity: 'WARNING',
    title: `Destino \`${target}\` é uma release que já foi para a main`,
    body: `A main já está na versão dessa release; a próxima é \`${nextRelease}\`. Mudança que entra aqui não sai na próxima entrega.\n\nPara onde cada tipo vai:\n\n${BRANCH_TYPES_TEXT}`,
    suggestion: `Trocar o destino para \`${nextRelease}\` (ou uma release futura, se for para depois).`,
  };
}

const TARGET_BLOCK_RE = /<!--\s*seal:target-blocked\s+([0-9a-f]{7,40})\s*-->/i;

export function formatTargetBlockSummary({ gate, headSha, prUrl = null, threadId = null }) {
  const title = prUrl && threadId ? `[${gate.title}](${prUrl}?discussionId=${threadId})` : gate.title;
  const hotfix = /^Hotfix /.test(gate.title);
  return [
    hotfix
      ? `**❌ Reprovado** — ${title}.`
      : `**❌ Reprovado** — ${title.replace(/^PR de trabalho/, 'a PR de trabalho')}, e a branch traz a \`${gate.carriedRelease}\` junto.`,
    '',
    hotfix
      ? 'Revisei só o que a branch leva para a `main`: o código não foi revisado. Recrie a branch a partir da `main` só com os commits do hotfix (o passo a passo está no comentário), abra uma PR nova e abandone esta.'
      : `Revisei só o destino: o código não foi revisado, porque contra \`main\` o diff mistura o trabalho desta PR com o da release inteira. Troque o destino para \`${gate.carriedRelease}\` e a revisão roda sozinha no mesmo commit.`,
    '',
    `<!-- seal:target-blocked ${headSha} -->`,
  ].join('\n');
}

export const hasTargetBlockSummary = (threads, myEmail, headSha) =>
  (threads || []).some((thread) => (thread.comments || []).some((comment) =>
    !comment.isDeleted && isMine(comment.author, myEmail) && (comment.content || '').match(TARGET_BLOCK_RE)?.[1]?.toLowerCase() === headSha.toLowerCase()));

const STICKY_SENT_REASONS = new Set(['blocker', 'pair-desync']);

export const sentKey = (prId, item) => `${prId}:${item.reason}:${item.since || ''}`;

export function isMarkedSent(sent, prId, item, now = Date.now()) {
  const at = sent?.[sentKey(prId, item)];
  if (!at) return false;
  return STICKY_SENT_REASONS.has(item.reason) || now - new Date(at).getTime() < DAY_MS;
}

const FINDING_TITLE_RE = /^\*\*\[[^\]]+\]\s*(.+?)\*\*/;

export function postedFindingTitles(threads, myEmail) {
  const titles = new Set();
  for (const thread of threads || []) {
    const [first] = thread.comments || [];
    if (!first || first.isDeleted || !isMine(first.author, myEmail)) continue;
    const match = (first.content || '').match(FINDING_TITLE_RE);
    if (match) titles.add(match[1].trim());
  }
  return titles;
}

export const CHAT_BLOCK_START = '<<<SEAL_CHAT_ACTIONS';
export const CHAT_BLOCK_END = 'SEAL_CHAT_ACTIONS>>>';

export function buildChatPrompt({ prId, question }) {
  return [
    `Pergunta do dono do SEAL sobre a sua revisão da PR !${prId}:`,
    '',
    question.trim(),
    '',
    'Responda em português, direto, citando arquivo:linha quando falar de código. Você pode reler o código deste worktree.',
    'Não poste, não vote, não edite arquivos: quem executa qualquer mudança é o sensor.',
    `Só se você concluir que um achado seu publicado NÃO se sustenta, termine a resposta com o bloco abaixo, usando o título exato do achado:`,
    `${CHAT_BLOCK_START}`,
    '{"resolve": [{"title": "título exato do achado", "reason": "por que ele não se sustenta"}]}',
    `${CHAT_BLOCK_END}`,
    'Se o que falta não é código e sim ajustar um work item (critério de aceite de US/Bug, task), liste em "work_items" no mesmo bloco: {"work_items": [{"id": 123, "change": "o que mudar"}]}. Quem ajusta é o dono do SEAL, não o autor da PR.',
    'Se nenhum achado deve ser resolvido e nenhum work item precisa mudar, não inclua o bloco.',
  ].join('\n');
}

const THREAD_STATUS_NAMES = { 1: 'active', 2: 'fixed', 3: 'wontFix', 4: 'closed', 5: 'byDesign', 6: 'pending' };

export function authorReplies({ threads, myEmail, since = 0 }) {
  const disputes = [];
  let latestAt = since;
  for (const thread of threads || []) {
    const [first, ...rest] = thread.comments || [];
    if (!first || first.isDeleted || thread.isDeleted || !isMine(first.author, myEmail)) continue;
    const match = (first.content || '').match(FINDING_TITLE_RE);
    if (!match) continue;
    const replies = rest
      .filter((comment) => !comment.isDeleted && comment.commentType !== 'system' && !isMine(comment.author, myEmail) && (comment.content || '').trim())
      .filter((comment) => Date.parse(comment.publishedDate || 0) > since)
      .map((comment) => ({ author: comment.author?.displayName || comment.author?.uniqueName || 'autor', text: comment.content.trim(), at: comment.publishedDate }));
    if (replies.length === 0) continue;
    for (const item of replies) latestAt = Math.max(latestAt, Date.parse(item.at));
    disputes.push({ threadId: thread.id, title: match[1].trim(), status: THREAD_STATUS_NAMES[thread.status] || String(thread.status ?? ''), replies });
  }
  return { disputes, latestAt };
}

export function buildAuthorReplyQuestion({ prId, disputes }) {
  const blocks = disputes.map((dispute) =>
    [`Achado: ${dispute.title} (thread ${dispute.threadId}, status ${dispute.status || '?'})`, ...dispute.replies.map((item) => `${item.author}: ${item.text}`)].join('\n'),
  );
  return [
    `O autor respondeu aos seus achados na PR !${prId}, sem commit novo. Reavalie cada um à luz da resposta:`,
    '',
    blocks.join('\n\n'),
    '',
    'Para cada achado, diga se ele se sustenta. Uma decisão do time registrada na PR é um argumento válido para código; não repita o mesmo achado só porque o critério escrito do work item ainda não mudou.',
    'Se o que impede aprovar é só o work item desatualizado, resolva o achado e liste o ajuste em "work_items": o dono do SEAL é avisado para fazer.',
  ].join('\n');
}

export function parseChatReply(text) {
  const source = String(text || '');
  const start = source.lastIndexOf(CHAT_BLOCK_START);
  const end = start >= 0 ? source.indexOf(CHAT_BLOCK_END, start) : -1;
  if (start < 0 || end < 0) return { answer: source.trim(), resolves: [], workItems: [], reopen: [] };
  let resolves = [];
  let workItems = [];
  let reopen = [];
  try {
    const parsed = JSON.parse(source.slice(start + CHAT_BLOCK_START.length, end).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    resolves = (Array.isArray(parsed?.resolve) ? parsed.resolve : [])
      .map((item) => ({ title: String(item?.title || '').trim(), reason: String(item?.reason || '').trim() }))
      .filter((item) => item.title);
    workItems = (Array.isArray(parsed?.work_items) ? parsed.work_items : [])
      .map((item) => ({ id: Number(item?.id), change: String(item?.change || '').trim() }))
      .filter((item) => Number.isInteger(item.id) && item.id > 0 && item.change);
    reopen = (Array.isArray(parsed?.reopen) ? parsed.reopen : [])
      .map((item) => ({ title: String(item?.title || '').trim(), missing: String(item?.missing || '').trim(), fixPrompt: String(item?.fixPrompt || '').trim() }))
      .filter((item) => item.title);
  } catch {
    resolves = [];
    workItems = [];
    reopen = [];
  }
  return { answer: (source.slice(0, start) + source.slice(end + CHAT_BLOCK_END.length)).trim(), resolves, workItems, reopen };
}

export function findingThreadIdsByTitle(threads, myEmail) {
  const byTitle = new Map();
  for (const thread of threads || []) {
    const [first] = thread.comments || [];
    if (!first || first.isDeleted || !isMine(first.author, myEmail)) continue;
    const match = (first.content || '').match(FINDING_TITLE_RE);
    if (match && !byTitle.has(match[1].trim())) byTitle.set(match[1].trim(), thread.id);
  }
  return byTitle;
}

const GENERATED_PATH = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|pubspec\.lock)$|\.(png|jpe?g|gif|webp|ico|snap)$|(^|\/)__golden__\/|(^|\/)__screenshots__\/|(^|\/)(dist|build|coverage)\//i;

export const isGeneratedPath = (file) => GENERATED_PATH.test(file);

const DOC_PATH = /(^|\/)docs\/|\.(md|mdx)$/i;

export const isDocPath = (file) => DOC_PATH.test(file);

function areaOf(file) {
  const parts = file.split('/');
  if (parts[0] === 'components' && parts.length > 3) return parts.slice(0, 3).join('/');
  if (['src', 'lib', 'test', 'tests'].includes(parts[0]) && parts.length > 3) return parts.slice(0, 3).join('/');
  if (parts.length > 2) return parts.slice(0, 2).join('/');
  if (parts.length === 2) return parts[0];
  return '(raiz)';
}

export function planReviewChunks(rows, { maxLines = 1500, maxFiles = 40 } = {}) {
  const all = (rows || [])
    .filter((row) => row.path && !isGeneratedPath(row.path))
    .map((row) => ({ path: row.path, lines: (Number(row.added) || 0) + (Number(row.deleted) || 0) }));
  const docs = all.filter((row) => isDocPath(row.path));
  const reviewable = all.filter((row) => !isDocPath(row.path));
  const areas = new Map();
  for (const row of reviewable) {
    const area = areaOf(row.path);
    areas.set(area, [...(areas.get(area) || []), row]);
  }
  const chunks = [];
  let current = null;
  const flush = () => {
    if (current && current.paths.length > 0) chunks.push(current);
    current = null;
  };
  for (const [area, files] of [...areas.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const areaLines = files.reduce((sum, file) => sum + file.lines, 0);
    if (areaLines > maxLines || files.length > maxFiles) {
      flush();
      let part = null;
      for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
        if (part && (part.lines + file.lines > maxLines || part.paths.length >= maxFiles)) {
          chunks.push(part);
          part = null;
        }
        part = part || { areas: [area], paths: [], lines: 0 };
        part.paths.push(file.path);
        part.lines += file.lines;
      }
      current = part;
      continue;
    }
    if (current && (current.lines + areaLines > maxLines || current.paths.length + files.length > maxFiles)) flush();
    current = current || { areas: [], paths: [], lines: 0 };
    current.areas.push(area);
    current.paths.push(...files.map((file) => file.path));
    current.lines += areaLines;
  }
  flush();
  const planned = chunks.map((chunk) => ({ kind: 'code', label: chunk.areas.join(', '), paths: chunk.paths, lines: chunk.lines }));
  if (docs.length > 0) planned.push({ kind: 'docs', label: 'documentação', paths: docs.map((row) => row.path), lines: docs.reduce((sum, row) => sum + row.lines, 0) });
  return {
    totalLines: reviewable.reduce((sum, row) => sum + row.lines, 0),
    totalFiles: reviewable.length,
    docLines: docs.reduce((sum, row) => sum + row.lines, 0),
    chunks: planned.map((chunk, index) => ({ id: index + 1, ...chunk })),
  };
}

export const needsChunking = (plan, { maxLines = 1500, maxFiles = 40 } = {}) =>
  plan.chunks.length > 1 && (plan.totalLines > maxLines || plan.totalFiles > maxFiles);
