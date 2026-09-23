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
const THREAD_STATUS_PENDING = 6;

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
  if (ledgerForHead) return { action: 'skip', reason: `ledger-${ledgerForHead.status}` };

  if (hasReviewLock(threads, myEmail)) return { action: 'skip', reason: 'locked' };

  const reviewedSha = (lastPublishedSha || findLastReviewedSha(threads, myEmail) || '').toLowerCase() || null;
  if (!reviewedSha) return { action: 'first-review', headSha };
  if (headSha.startsWith(reviewedSha) || reviewedSha.startsWith(headSha)) return { action: 'skip', reason: 'up-to-date' };
  return { action: 're-review', headSha, previousSha: reviewedSha };
}

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
  return {
    severity: SEVERITIES.includes(severity) ? severity : 'WARNING',
    kind,
    file: raw?.file ? String(raw.file).replace(/^\/+/, '') : null,
    line,
    endLine: Number.isInteger(raw?.endLine) && line && raw.endLine >= line ? raw.endLine : line,
    title: String(raw?.title || '').trim(),
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

export const deriveVerdict = (findings) => (findings.length > 0 ? 'needs-work' : 'approved');

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
    },
  };
}

export const countBySeverity = (findings) =>
  SEVERITIES.reduce((counts, severity) => ({ ...counts, [severity.toLowerCase()]: findings.filter((finding) => finding.severity === severity).length }), {});

export const threadStatusFor = (severity) => (severity === 'NIT' ? THREAD_STATUS_PENDING : THREAD_STATUS_ACTIVE);

const KIND_LABEL = { 'test-gap': 'Teste faltando', 'doc-request': 'Documentação' };

export function formatFindingComment(finding, { includeLocation = false } = {}) {
  const label = KIND_LABEL[finding.kind] ? ` · ${KIND_LABEL[finding.kind]}` : '';
  const parts = [`**[${finding.severity}${label}] ${finding.title}**`];
  if (includeLocation && finding.file) parts.push(`\`${finding.file}${finding.line ? `:${finding.line}` : ''}\``);
  if (finding.body) parts.push(finding.body);
  const meta = [finding.rule && `**Regra**: ${finding.rule}`, finding.suggestion && `**Sugestão**: ${finding.suggestion}`].filter(Boolean);
  if (meta.length > 0) parts.push(meta.join('\n'));
  if (finding.fixPrompt) {
    parts.push(`<details>\n<summary>🤖 Prompt de correção</summary>\n\n\`\`\`\n${finding.fixPrompt.replace(/```/g, "'''")}\n\`\`\`\n</details>`);
  }
  return parts.join('\n\n');
}

export const pendingCommentsText = (total) =>
  total === 1
    ? '1 comentário nesta PR, com o prompt de correção.'
    : `${total} comentários nesta PR, cada um com o prompt de correção.`;

const OPEN_THREAD_STATUSES = new Set([1, 'active', 6, 'pending']);

export function countOpenBotThreads(threads, myEmail, { excludeThreadIds = [] } = {}) {
  const excluded = new Set(excludeThreadIds.map(Number));
  return (threads || []).filter((thread) => {
    if (excluded.has(Number(thread.id)) || !OPEN_THREAD_STATUSES.has(thread.status) || thread.isDeleted) return false;
    const [first] = thread.comments || [];
    if (!first || first.isDeleted || !isMine(first.author, myEmail)) return false;
    const content = first.content || '';
    return !content.includes(LOCK_TEXT) && !REVIEWED_MARKER_RE.test(content);
  }).length;
}

export const verdictFor = (newFindings, priorOpen = 0) => (newFindings + priorOpen > 0 ? 'needs-work' : 'approved');

export function formatSummaryComment({ data, headSha, priorOpen = 0 }) {
  const total = data.findings.length;
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
  lines.push('', reviewedMarker(headSha));
  return lines.join('\n');
}

export function buildThreadPayload(finding) {
  const payload = {
    comments: [{ parentCommentId: 0, content: formatFindingComment(finding), commentType: 1 }],
    status: threadStatusFor(finding.severity),
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

export function checkTargetBranch({ source, target, nextRelease, defaultBranch = 'main' }) {
  const next = parseVersion(nextRelease);
  if (!next) return null;
  const fixPrompt = `A PR de \`${source}\` aponta para \`${target}\`, mas trabalho novo entra na próxima release, \`${nextRelease}\` (versão da main + 1). No Azure DevOps, edite a PR e troque a branch de destino para \`${nextRelease}\`. Se houver conflito, faça rebase de \`${source}\` sobre \`origin/${nextRelease}\` e rode a suíte de testes do repo antes do push.`;
  const base = { kind: 'code', file: null, line: null, rule: 'Gate de branch de destino', fixPrompt, sources: ['target-gate'] };

  if (target === defaultBranch) {
    if (MAINLINE_SOURCES.test(source)) return null;
    return {
      ...base,
      severity: 'BLOCKER',
      title: `PR de trabalho apontando para \`${defaultBranch}\``,
      body: `\`${source}\` não é release, hotfix nem gmud, então não entra direto em \`${defaultBranch}\`. A próxima release é \`${nextRelease}\`.`,
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
    body: `A main já está na versão dessa release; a próxima é \`${nextRelease}\`. Mudança que entra aqui não sai na próxima entrega.`,
    suggestion: `Trocar o destino para \`${nextRelease}\` (ou uma release futura, se for para depois).`,
  };
}

const STICKY_SENT_REASONS = new Set(['blocker', 'pair-desync']);

export const sentKey = (prId, item) => `${prId}:${item.reason}:${item.since || ''}`;

export function isMarkedSent(sent, prId, item, now = Date.now()) {
  const at = sent?.[sentKey(prId, item)];
  if (!at) return false;
  return STICKY_SENT_REASONS.has(item.reason) || now - new Date(at).getTime() < DAY_MS;
}
