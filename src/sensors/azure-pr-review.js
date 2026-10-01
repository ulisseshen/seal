import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { insertTaskIfNew, insertEvent, db, updateLastNotified, deferTask } from '../db.js';
import { parseUsageLimit, resumeAt, usageLimitResult, isUsageLimitResult } from '../usage-limit.js';
import { triggerAction } from '../actions/hub.js';
import { getMessagingConnector, readMessagingConfig } from '../messaging/index.js';
import { chargeMessage, chargeKeys, shouldOfferCharge } from './pr-review-charge.js';
import { notify } from '../notify.js';
import { checkClaudeAuth, isLoginExpiredResult } from '../auth.js';
import { VOTE_MAP } from './azure-pr-review-logic.js';
import {
  LOCK_TEXT,
  PUBLISHED_MARKER,
  PUBLISH_FAILED_MARKER,
  RESULT_BLOCK_START,
  RESULT_BLOCK_END,
  applyUsScenarioFinding,
  buildChatPrompt,
  findingThreadIdsByTitle,
  parseChatReply,
  authorReplies,
  buildAuthorReplyQuestion,
  reviewedMarker,
  buildThreadPayload,
  checkTargetBranch,
  checkBranchName,
  formatNameBlockSummary,
  pickOriginBranch,
  countOpenBotThreads,
  needsCommitVerification,
  usCoverageLine,
  localRulesInstruction,
  openBotFindings,
  resolvedBotFindings,
  findingPostedSha,
  buildVerifyResolvedQuestion,
  needsChunking,
  planReviewChunks,
  verdictFor,
  blockingFindings,
  relabelAsReminder,
  severityOfComment,
  countBySeverity,
  deriveVerdict,
  decideReviewGate,
  followUpReasons,
  formatFindingComment,
  formatSummaryComment,
  formatTargetBlockSummary,
  hasTargetBlockSummary,
  isMarkedSent,
  postedFindingTitles,
  matchPairedPrs,
  mentionPullRequests,
  checkVisualEvidence,
  pickConsumerRepos,
  messageDraftFor,
  nextReleaseFrom,
  parseReviewResult,
  shouldNotify,
  staleFailureNotices,
} from './pr-review-pipeline-logic.js';
import { resolveReviewRepos } from './pr-review-repos.js';
import { appendChatEntry, completeChatRequest, enqueueChatRequest, pendingChatRequests, readChatLog } from './pr-review-chat.js';
import { getClaudeBin } from '../claude-bin.js';
import { escapeHtml, readReviewState, readSentMarks, sendTelegram, upsertPrEntry, writeReviewState } from './pr-review-state.js';
import { beginPublish, claimReview, failReview, finishReview, healthIssues, lastConversableReview, lastPublishedReview, markRepliesSeen, markVerifyRequested, reviewedShaAt, setReviewBranches, recordPreReviewBlock, reclaimFailedReview, releaseClaim, releaseOrphanClaims, resumeStalePublishing, reviewForSha } from './pr-review-ledger.js';
import { flushDigestIfDue, queueDigest, supersedePendingOffers } from '../telegram-outbox.js';
import { quietUntil, sleepTracker } from '../sleep-window.js';
import { restState } from '../rest-mode.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

let ORG = '';
let PROJECT = '';
let MY_EMAIL = '';
let ORG_BASE = '';
const MY_AZURE_ID = (process.env.SEAL_AZURE_MY_ID || '').toLowerCase();
const TEST_PRS = new Set(
  (process.env.SEAL_AZURE_TEST_PRS || '')
    .split(',')
    .map((value) => parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value)),
);
const TEST_DRY = process.env.SEAL_AZURE_TEST_DRY === '1';
const PAT = process.env.AZURE_DEVOPS_PAT || process.env.AZURE_DEVOPS_EXT_PAT || '';
const API_VERSION = 'api-version=7.1';

const SUMMARY_PREFIX = 'smart-review PR #';
const PIPELINE_TAG = 'pr-review-pipeline:v2';
const PART_TAG = 'pr-review-part:v1';
const WAITING_FOR_PARTS_AT = '9999-12-31T00:00:00.000Z';
const WORKTREE_ROOT = process.env.SEAL_PR_WORKTREE_ROOT || path.join(os.homedir(), '.seal-worktrees');
const PIPELINE_SKILL_PATH = path.resolve(HERE, '..', '..', 'skills', 'pr-review-pipeline', 'SKILL.md');
const ACCEPTANCE_JUDGE_PATH = path.join(path.dirname(PIPELINE_SKILL_PATH), 'acceptance-judge.md');
const LOCAL_RULES_PATH = process.env.SEAL_REVIEW_RULES || path.join(os.homedir(), '.config', 'seal', 'review-rules.md');
const LOCAL_RULES_DIR = process.env.SEAL_REVIEW_RULES_DIR || path.join(os.homedir(), '.config', 'seal', 'review-rules');
const localRulesLine = (repoName) =>
  localRulesInstruction([LOCAL_RULES_PATH, path.join(LOCAL_RULES_DIR, `${repoName}.md`)].filter((file) => fs.existsSync(file)));
const DEFAULT_START = '2026-09-23T00:00:00Z';
const MAX_RETRIES = 5;
const NAG_COOLDOWN_MIN = 5;

const DENIED_TOOLS = [
  'Edit',
  'NotebookEdit',
  'mcp__azure-devops__repo_pull_request_thread_write',
  'mcp__azure-devops__repo_pull_request_write',
  'mcp__azure-devops__repo_vote_pull_request',
  'mcp__azure-devops__wit_work_item_write',
  'mcp__azure-devops__wit_work_item_comment_write',
  'mcp__azure-devops__wit_work_item_link_write',
  'Bash(git push:*)',
  'Bash(git commit:*)',
  'Bash(git checkout:*)',
  'Bash(git reset:*)',
];

function resolveOcrBin() {
  if (process.env.SEAL_OCR_BIN) return process.env.SEAL_OCR_BIN;
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
  const nvmBins = fs.existsSync(nvmRoot) ? fs.readdirSync(nvmRoot).sort().reverse().map((version) => path.join(nvmRoot, version, 'bin', 'ocr')) : [];
  return [...nvmBins, '/opt/homebrew/bin/ocr', '/usr/local/bin/ocr'].find((candidate) => fs.existsSync(candidate)) || null;
}

const OCR_BIN = resolveOcrBin();

const MCP_DOMAINS = ['core', 'repositories', 'work-items'];

const reviewMcpConfig = () => ({
  mcpServers: {
    'azure-devops': {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@azure-devops/mcp', ORG, '--authentication', 'pat', '-d', ...MCP_DOMAINS],
      env: { PERSONAL_ACCESS_TOKEN: '${PERSONAL_ACCESS_TOKEN}' },
    },
  },
});

export function configureAzure(sensorCfg = {}) {
  ORG = process.env.SEAL_AZURE_ORG || sensorCfg.azure_pr_review_org || '';
  PROJECT = process.env.SEAL_AZURE_PROJECT || sensorCfg.azure_pr_review_project || '';
  MY_EMAIL = (process.env.SEAL_AZURE_MY_EMAIL || sensorCfg.azure_pr_review_my_email || '').toLowerCase();
  const quietMin = Number(sensorCfg.azure_pr_review_reply_quiet_min ?? NaN);
  AUTHOR_REPLY_QUIET_MS = (Number.isFinite(quietMin) && quietMin >= 0 ? quietMin : 3) * 60 * 1000;
  ORG_BASE = `https://dev.azure.com/${ORG}/${PROJECT}/_apis`;
  if (PAT && MY_EMAIL && !process.env.PERSONAL_ACCESS_TOKEN) {
    process.env.PERSONAL_ACCESS_TOKEN = Buffer.from(`${MY_EMAIL}:${PAT}`).toString('base64');
  }
  const missing = [
    !ORG && 'azure_pr_review_org',
    !PROJECT && 'azure_pr_review_project',
    !MY_EMAIL && 'azure_pr_review_my_email',
    !(sensorCfg.azure_pr_review_repos || []).length && 'azure_pr_review_repos',
  ].filter(Boolean);
  return missing;
}

function authHeaders() {
  return {
    Authorization: 'Basic ' + Buffer.from(':' + PAT).toString('base64'),
    'Content-Type': 'application/json',
  };
}

async function azRequest(method, url, body) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}${API_VERSION}`, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Azure API ${res.status}: ${await res.text().catch(() => '(no body)')}`);
  const raw = await res.text();
  return raw ? JSON.parse(raw) : {};
}

const repoUrl = (repo, suffix) => `${ORG_BASE}/git/repositories/${repo.id}${suffix}`;
const prWebUrl = (repoName, prId) => `https://dev.azure.com/${ORG}/${PROJECT}/_git/${repoName}/pullrequest/${prId}`;
const branchOf = (ref) => (ref || '').replace('refs/heads/', '');

async function writeToAzure(label, action) {
  if (TEST_DRY) {
    console.log(`[pr-review] [dry] WOULD ${label}`);
    return null;
  }
  return action();
}

let threadsCache = new Map();
let lastBacklog = 0;
const enqueueFailures = new Map();
const ENQUEUE_BACKOFF_BASE_MS = 5 * 60 * 1000;
const ENQUEUE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
let stuckTickAlertedAt = 0;

export async function reportStuckTick(timeoutMs) {
  if (quietUntil(new Date()) || sleepTracker().sleptWithin(timeoutMs)) return;
  if (Date.now() - stuckTickAlertedAt < 60 * 60 * 1000) return;
  stuckTickAlertedAt = Date.now();
  await sendTelegram(`⚠️ Um tick da revisão automática passou de ${Math.round(timeoutMs / 60000)} min e foi abandonado. O próximo tick segue normalmente; se repetir, algo externo (Azure, git, disco) está travando.`);
}

function backoffActive(key, now) {
  const failure = enqueueFailures.get(key);
  return Boolean(failure && failure.until > now);
}

function recordEnqueueFailure(key, now, message) {
  const count = (enqueueFailures.get(key)?.count || 0) + 1;
  const wait = Math.min(ENQUEUE_BACKOFF_BASE_MS * 2 ** (count - 1), ENQUEUE_BACKOFF_MAX_MS);
  enqueueFailures.set(key, { count, until: now + wait, message });
}
let prByIdCache = new Map();

async function getThreads(repo, prId) {
  const key = `${repo.id}:${prId}`;
  if (threadsCache.has(key)) return threadsCache.get(key);
  let entry;
  try {
    const data = await azRequest('GET', repoUrl(repo, `/pullRequests/${prId}/threads`));
    entry = { ok: true, threads: data.value || [] };
  } catch (err) {
    console.warn(`[pr-review] threads fetch failed for ${repo.name} !${prId}: ${err.message}`);
    entry = { ok: false, threads: [] };
  }
  threadsCache.set(key, entry);
  return entry;
}

async function getPrById(prId) {
  if (prByIdCache.has(prId)) return prByIdCache.get(prId);
  let pr = null;
  try {
    pr = await azRequest('GET', `${ORG_BASE}/git/pullrequests/${prId}`);
  } catch (err) {
    console.warn(`[pr-review] fetch !${prId} failed: ${err.message}`);
  }
  prByIdCache.set(prId, pr);
  return pr;
}

async function getWorkItemIds(repo, prId) {
  try {
    const data = await azRequest('GET', repoUrl(repo, `/pullRequests/${prId}/workitems`));
    return (data.value || []).map((item) => Number(item.id)).filter(Number.isFinite);
  } catch {
    return [];
  }
}

const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.Description',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
  'Microsoft.VSTS.TCM.ReproSteps',
  'System.Parent',
];

const CHILD_ITEM_TYPES = new Set(['Task']);

async function getWorkItemsWithStories(ids) {
  const items = await getWorkItems(ids);
  const known = new Set(items.map((item) => item.id));
  const parentIds = [
    ...new Set(
      items
        .filter((item) => CHILD_ITEM_TYPES.has(item.fields?.['System.WorkItemType']) && item.fields?.['System.Parent'])
        .map((item) => item.fields['System.Parent'])
        .filter((parentId) => !known.has(parentId)),
    ),
  ];
  const parents = await getWorkItems(parentIds);
  return [...parents, ...items];
}

async function getWorkItems(ids) {
  if (ids.length === 0) return [];
  try {
    const data = await azRequest('GET', `${ORG_BASE}/wit/workitems?ids=${ids.join(',')}&fields=${WORK_ITEM_FIELDS.join(',')}`);
    return data.value || [];
  } catch (err) {
    console.warn(`[pr-review] work items fetch failed: ${err.message}`);
    return [];
  }
}

const stripHtml = (html) =>
  String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function renderWorkItemsMarkdown(workItems) {
  if (workItems.length === 0) return '_Nenhum work item vinculado à PR._\n';
  return workItems
    .map((item) => {
      const fields = item.fields || {};
      const sections = [
        `# ${fields['System.WorkItemType']} ${item.id} — ${fields['System.Title']} (${fields['System.State']})`,
        `## Descrição\n\n${stripHtml(fields['System.Description']) || '_vazia_'}`,
        `## Critérios de aceite\n\n${stripHtml(fields['Microsoft.VSTS.Common.AcceptanceCriteria']) || '_vazios_'}`,
      ];
      if (fields['Microsoft.VSTS.TCM.ReproSteps']) sections.push(`## Passos de reprodução\n\n${stripHtml(fields['Microsoft.VSTS.TCM.ReproSteps'])}`);
      return sections.join('\n\n');
    })
    .join('\n\n---\n\n');
}

async function git(cwd, args, timeout = 60_000) {
  const { stdout } = await execFileP('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function fetchRefs(projectDir, branches, shas = []) {
  const refspecs = branches.filter(Boolean).map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  try {
    await git(projectDir, ['fetch', '--quiet', 'origin', ...refspecs], 120_000);
  } catch (err) {
    console.warn(`[pr-review] fetch ${branches.join(',')} in ${projectDir}: ${err.message.split('\n')[0]}`);
  }
  for (const sha of shas.filter(Boolean)) {
    try {
      await git(projectDir, ['cat-file', '-e', `${sha}^{commit}`]);
    } catch {
      await git(projectDir, ['fetch', '--quiet', 'origin', sha], 120_000).catch(() => {});
    }
  }
}

async function mainVersion(projectDir) {
  await git(projectDir, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], 120_000).catch(() => {});
  for (const [file, pattern] of [
    ['package.json', /"version"\s*:\s*"([^"]+)"/],
    ['pubspec.yaml', /^version:\s*(\S+)/m],
  ]) {
    const content = await git(projectDir, ['show', `origin/main:${file}`]).catch(() => '');
    const match = content.match(pattern);
    if (match) return match[1];
  }
  return git(projectDir, ['describe', '--tags', '--abbrev=0', 'origin/main']).catch(() => null);
}

const worktreePath = (repo, prId) => path.join(WORKTREE_ROOT, repo.name, `pr-${prId}`);

async function removeWorktree(repo, wtPath) {
  try {
    await git(repo.projectDir, ['worktree', 'remove', '--force', wtPath], 30_000);
  } catch {
    fs.rmSync(wtPath, { recursive: true, force: true });
    await git(repo.projectDir, ['worktree', 'prune']).catch(() => {});
  }
}

async function createWorktree(repo, pr, headSha) {
  const wtPath = worktreePath(repo, pr.pullRequestId);
  if (fs.existsSync(wtPath)) await removeWorktree(repo, wtPath);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  const sourceBranch = branchOf(pr.sourceRefName);
  const targetBranch = branchOf(pr.targetRefName);
  await fetchRefs(repo.projectDir, [sourceBranch, targetBranch], [headSha]);
  await git(repo.projectDir, ['worktree', 'add', '--detach', wtPath, headSha], 120_000);

  const mergeBase = await git(wtPath, ['merge-base', `origin/${targetBranch}`, headSha]).catch(() => `origin/${targetBranch}`);

  const nodeModules = path.join(repo.projectDir, 'node_modules');
  if (fs.existsSync(nodeModules) && !fs.existsSync(path.join(wtPath, 'node_modules'))) {
    fs.symlinkSync(nodeModules, path.join(wtPath, 'node_modules'));
  }
  fs.writeFileSync(path.join(wtPath, '.mcp.json'), JSON.stringify(reviewMcpConfig(), null, 2));

  return { wtPath, mergeBase, sourceBranch, targetBranch };
}

function readFrontmatterField(text, field) {
  const block = text.match(/^---\n([\s\S]*?)\n---/);
  if (!block) return '';
  const lines = block[1].split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${field}:`));
  if (start < 0) return '';
  const inline = lines[start].slice(field.length + 1).trim();
  if (inline && !/^[>|]-?$/.test(inline)) return inline.replace(/^["']|["']$/g, '');
  const folded = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+/.test(line)) break;
    folded.push(line.trim());
  }
  return folded.join(' ');
}

function collectRepoConventions(wtPath) {
  const skillsDir = path.join(wtPath, '.claude', 'skills');
  const repoSkills = fs.existsSync(skillsDir)
    ? fs
        .readdirSync(skillsDir)
        .map((dir) => path.join(skillsDir, dir, 'SKILL.md'))
        .filter((file) => fs.existsSync(file))
        .map((file) => {
          const text = fs.readFileSync(file, 'utf8');
          return { name: readFrontmatterField(text, 'name') || path.basename(path.dirname(file)), description: readFrontmatterField(text, 'description').slice(0, 300) };
        })
    : [];
  const docsDir = path.join(wtPath, 'docs');
  const docsTree = fs.existsSync(docsDir)
    ? fs.readdirSync(docsDir, { withFileTypes: true }).map((entry) => (entry.isDirectory() ? `docs/${entry.name}/` : `docs/${entry.name}`))
    : [];
  return { repoSkills, docsTree };
}

async function storyIdsOf(workItemIds) {
  if (workItemIds.length === 0) return [];
  const items = await getWorkItems(workItemIds);
  return [
    ...new Set(
      items.map((item) => (CHILD_ITEM_TYPES.has(item.fields?.['System.WorkItemType']) && item.fields?.['System.Parent'] ? item.fields['System.Parent'] : item.id)),
    ),
  ];
}

async function findPairContext(repo, repos, pr, workItemIds) {
  const pairRepo = repos.find((candidate) => candidate.name === repo.pair);
  if (!pairRepo) return [];
  let candidates;
  try {
    const data = await azRequest('GET', repoUrl(pairRepo, '/pullRequests?searchCriteria.status=all&$top=100'));
    candidates = data.value || [];
  } catch (err) {
    console.warn(`[pr-review] pair listing failed for ${pairRepo.name}: ${err.message}`);
    return [];
  }
  const ownFull = (await getPrById(pr.pullRequestId)) || pr;
  const ownStories = await storyIdsOf(workItemIds);
  const withItems = [];
  for (const candidate of candidates) {
    const recent = candidate.status === 'active' || Date.now() - new Date(candidate.closedDate || 0).getTime() < 30 * 24 * 60 * 60 * 1000;
    if (!recent) continue;
    const isActive = candidate.status === 'active';
    const full = isActive ? (await getPrById(candidate.pullRequestId)) || candidate : candidate;
    const candidateItems = workItemIds.length > 0 && isActive ? await getWorkItemIds(pairRepo, candidate.pullRequestId) : [];
    withItems.push({ pr: full, workItemIds: candidateItems, storyIds: await storyIdsOf(candidateItems) });
  }
  const matches = matchPairedPrs({ ...pr, description: ownFull.description ?? pr.description }, workItemIds, withItems, ownStories);
  const contexts = [];
  for (const { pr: paired, reasons } of matches.slice(0, 3)) {
    const source = branchOf(paired.sourceRefName);
    const target = branchOf(paired.targetRefName);
    const sha = paired.lastMergeSourceCommit?.commitId;
    await fetchRefs(pairRepo.projectDir, [source, target], [sha]);
    const head = sha || `origin/${source}`;
    const base = await git(pairRepo.projectDir, ['merge-base', `origin/${target}`, head]).catch(() => `origin/${target}`);
    contexts.push({
      repo: pairRepo.name,
      prId: paired.pullRequestId,
      title: paired.title,
      status: paired.status,
      targetBranch: target,
      url: prWebUrl(pairRepo.name, paired.pullRequestId),
      dir: pairRepo.projectDir,
      reasons,
      diffCommand: `git -C ${pairRepo.projectDir} diff ${base}..${head}`,
      showFileCommand: `git -C ${pairRepo.projectDir} show ${head}:<path>`,
    });
  }
  return contexts;
}

async function planForDiff(wtPath, mergeBase, headSha) {
  const out = await git(wtPath, ['diff', '--numstat', `${mergeBase}..${headSha}`], 60_000).catch(() => '');
  const rows = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, ...rest] = line.split('\t');
      return { added: added === '-' ? 0 : added, deleted: deleted === '-' ? 0 : deleted, path: rest.join('\t') };
    });
  return planReviewChunks(rows);
}

function buildPartPrompt(part, total, repoName) {
  return [
    `Read ${PIPELINE_SKILL_PATH} and follow it exactly, in the "Modo parte" section.`,
    localRulesLine(repoName),
    `You review ONLY part ${part.id} of ${total}. The part context is in .seal-review/part-${part.id}.json (relative to the current directory).`,
    'This is an unattended run: never ask the user anything, never post, vote, edit files, commit or push.',
    `Write any intermediate file under .seal-review/part-${part.id}/ so parallel parts never overwrite each other.`,
    `Your final message MUST end with the result block delimited by ${RESULT_BLOCK_START} and ${RESULT_BLOCK_END}.`,
  ].filter(Boolean).join('\n');
}

function readResultFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? `${RESULT_BLOCK_START}\n${raw}\n${RESULT_BLOCK_END}` : null;
  } catch {
    return null;
  }
}

function parseTaskResult(taskResult, resultFile) {
  const fromFile = resultFile ? readResultFile(resultFile) : null;
  if (fromFile) {
    const parsed = parseReviewResult(fromFile);
    if (parsed.ok) return parsed;
  }
  return parseReviewResult(taskResult);
}

function buildPrompt(repoName) {
  return [
    `Read ${PIPELINE_SKILL_PATH} and follow it exactly.`,
    localRulesLine(repoName),
    'The review context is in .seal-review/context.json (relative to the current directory).',
    'This is an unattended run: never ask the user anything, never post, vote, edit files, commit or push.',
    `Your final message MUST end with the result block delimited by ${RESULT_BLOCK_START} and ${RESULT_BLOCK_END}.`,
  ].filter(Boolean).join('\n');
}

async function enqueueReview(args) {
  const { repo, pr, gate } = args;
  const claim = { repo: repo.name, prId: pr.pullRequestId, headSha: gate.headSha };
  if (TEST_DRY) return prepareAndQueue(args);
  const claimFn = gate.retry ? reclaimFailedReview : claimReview;
  if (!(await claimFn({ ...claim, mode: gate.action, taskId: `seal_pr_${pr.pullRequestId}` }))) {
    console.log(`[pr-review] ${repo.name} !${pr.pullRequestId}@${gate.headSha.slice(0, 8)} already claimed, skipping`);
    return false;
  }
  try {
    const queued = await prepareAndQueue(args);
    if (!queued) await releaseClaim({ ...claim, error: 'task-not-inserted' });
    return queued;
  } catch (err) {
    await releaseClaim({ ...claim, error: err.message });
    throw err;
  }
}

async function branchOrigin(repo, headSha) {
  const cwd = repo.projectDir;
  await git(cwd, ['fetch', '--quiet', '--prune', 'origin', '+refs/heads/main:refs/remotes/origin/main',
    '+refs/heads/release/*:refs/remotes/origin/release/*', '+refs/heads/gmud/*:refs/remotes/origin/gmud/*'], 120_000).catch(() => {});
  await fetchRefs(cwd, [], [headSha]);
  if (!(await git(cwd, ['cat-file', '-e', `${headSha}^{commit}`]).then(() => true, () => false))) return null;
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/main', 'refs/remotes/origin/release/', 'refs/remotes/origin/gmud/']).catch(() => ''))
    .split('\n').map((ref) => ref.trim()).filter(Boolean);
  if (refs.length === 0) return null;
  const own = (await git(cwd, ['rev-list', '--first-parent', headSha, '--not', ...refs]).catch(() => '')).split('\n').filter(Boolean);
  const fork = own.length ? await git(cwd, ['rev-parse', `${own[own.length - 1]}^`]).catch(() => null) : headSha;
  if (!fork) return null;
  const containing = [];
  for (const ref of refs) {
    if (await git(cwd, ['merge-base', '--is-ancestor', fork, ref]).then(() => true, () => false)) containing.push(ref.replace(/^origin\//, ''));
  }
  return pickOriginBranch(containing);
}

async function releaseCarriedIntoMain(repo, { nextRelease, headSha }) {
  const cwd = repo.projectDir;
  await fetchRefs(cwd, ['main', nextRelease], [headSha]);
  const targetBase = await git(cwd, ['merge-base', 'origin/main', headSha]).catch(() => null);
  const base = await git(cwd, ['merge-base', `origin/${nextRelease}`, headSha]).catch(() => null);
  if (!targetBase || !base || base === targetBase) return null;
  // Commits on the branch's own first-parent line are its work, even when a paired PR already put them in the
  // release; only what came in from the release by merge or as the starting point counts as carried along.
  const own = new Set((await git(cwd, ['rev-list', '--first-parent', `${targetBase}..${headSha}`]).catch(() => '')).split('\n').filter(Boolean));
  const log = await git(cwd, ['log', '--no-merges', '--format=%H %an', `${targetBase}..${base}`]).catch(() => '');
  const names = log.split('\n').filter(Boolean)
    .map((line) => line.match(/^(\S+) (.*)$/)).filter((match) => match && !own.has(match[1]))
    .map((match) => match[2].trim()).filter(Boolean);
  if (names.length === 0) return null;
  return { release: nextRelease, base, commits: names.length, authors: [...new Set(names)].sort() };
}

// A branch cut from the next release and aimed at main drags the whole release along; reviewing that diff
// blames the author for everyone's code. Block on the target alone, without touching the ledger or the
// reviewed marker, so retargeting the PR (same commit) lets the normal review run on the next tick.
// Posts a pre-review block (the finding, then a "Reprovado" summary without the reviewed marker, then a -10
// vote) once per head, and records it for the panel. The ledger is untouched, so fixing the cause reviews
// the same commit on the next tick.
async function postPreReviewBlock({ repo, pr, gate, kind, finding, summary, logText }) {
  const prId = pr.pullRequestId;
  if (TEST_DRY) {
    console.log(`[pr-review] [dry] WOULD block !${prId} (${kind}): ${logText}`);
    return true;
  }
  threadsCache.delete(`${repo.id}:${prId}`);
  const { ok, threads } = await getThreads(repo, prId);
  if (!ok) return true;
  if (hasTargetBlockSummary(threads, MY_EMAIL, gate.headSha)) return true;
  let threadId = findingThreadIdsByTitle(threads, MY_EMAIL).get(finding.title) || null;
  if (threadId) {
    const existing = threads.find((thread) => Number(thread.id) === Number(threadId));
    await writeToAzure(`refresh ${kind} block on !${prId}`, async () => {
      if (existing?.comments?.[0]?.id) {
        await azRequest('PATCH', repoUrl(repo, `/pullRequests/${prId}/threads/${threadId}/comments/${existing.comments[0].id}`), { content: formatFindingComment({ ...finding, headSha: gate.headSha }) });
      }
      if (![1, 'active'].includes(existing?.status)) await azRequest('PATCH', repoUrl(repo, `/pullRequests/${prId}/threads/${threadId}`), { status: 1 });
    });
  } else {
    const posted = await writeToAzure(`post ${kind} block on !${prId}`, () => postFinding(repo, prId, { ...finding, headSha: gate.headSha }));
    threadId = posted?.id ?? null;
  }
  await writeToAzure(`post ${kind} block summary on !${prId}`, () => azRequest('POST', repoUrl(repo, `/pullRequests/${prId}/threads`), {
    comments: [{ parentCommentId: 0, content: summary({ headSha: gate.headSha, prUrl: prWebUrl(repo.name, prId), threadId }), commentType: 1 }],
    status: 4,
  }));
  await writeToAzure(`vote rejected on !${prId}`, () => setMyVote(prId, VOTE_MAP.rejected, repo)).catch((err) => console.warn(`[pr-review] vote failed on !${prId}: ${err.message}`));
  await recordPreReviewBlock({ repo: repo.name, prId, headSha: gate.headSha, kind, source: branchOf(pr.sourceRefName), target: branchOf(pr.targetRefName), reason: finding.title })
    .catch((err) => console.warn(`[pr-review] record block on !${prId}: ${err.message}`));
  console.log(`[pr-review] !${prId}: bloqueada (${kind}): ${logText}, revisão parada`);
  return true;
}

async function blockOnBranchName({ repo, pr, gate }) {
  if (pr.status && pr.status !== 'active') return false;
  if (repo.branchGate === false) return false;
  const finding = checkBranchName({ source: branchOf(pr.sourceRefName), target: branchOf(pr.targetRefName) });
  if (!finding || finding.blocking === false) return false;
  return postPreReviewBlock({
    repo, pr, gate, kind: 'branch-name', finding,
    summary: (args) => formatNameBlockSummary({ finding, ...args }),
    logText: `branch ${branchOf(pr.sourceRefName)} sem o tipo no nome`,
  });
}

async function blockOnCarriedRelease({ repo, pr, gate }) {
  if (pr.status && pr.status !== 'active') return false;
  if (repo.targetGate === false || branchOf(pr.targetRefName) !== 'main') return false;
  const source = branchOf(pr.sourceRefName);
  const nextRelease = nextReleaseFrom(await mainVersion(repo.projectDir));
  if (!nextRelease) return false;
  if (/^(release|gmud)\//i.test(source)) return false;
  const carried = await releaseCarriedIntoMain(repo, { nextRelease, headSha: gate.headSha });
  if (!carried) return false;
  const targetGate = checkTargetBranch({ source, target: 'main', nextRelease, carried });
  if (!targetGate) return false;
  return postPreReviewBlock({
    repo, pr, gate, kind: 'target', finding: targetGate,
    summary: (args) => formatTargetBlockSummary({ gate: targetGate, ...args }),
    logText: `${carried.commits} commit(s) de ${carried.release} indo para main`,
  });
}

// Checks that stop a PR before any review, cheapest first: the branch name, then where it points.
async function preReviewBlock(args) {
  return (await blockOnBranchName(args)) || (await blockOnCarriedRelease(args));
}

async function consumerContext(repos, repo) {
  const consumers = [];
  for (const front of pickConsumerRepos(repos, repo)) {
    await git(front.projectDir, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main', '+refs/heads/release/*:refs/remotes/origin/release/*'], 120_000).catch(() => {});
    const release = (await git(front.projectDir, ['for-each-ref', '--sort=-v:refname', '--count=1', '--format=%(refname:short)', 'refs/remotes/origin/release/[0-9]*']).catch(() => '')).trim();
    const refs = [release, 'origin/main'].filter(Boolean);
    consumers.push({
      repo: front.name,
      stack: front.stack,
      refs,
      grepCommand: `git -C ${front.projectDir} grep -n -F -e '<trecho da rota>' ${refs.join(' ')} -- . ':!docs' ':!*.md'`,
    });
  }
  return consumers;
}

async function priorFindingsFor(repo, prId, headSha) {
  threadsCache.delete(`${repo.id}:${prId}`);
  const { ok, threads } = await getThreads(repo, prId);
  if (!ok) return [];
  const prior = [];
  for (const item of openBotFindings(threads, MY_EMAIL)) {
    const sinceSha = findingPostedSha(item, threads, MY_EMAIL) || (item.postedAt ? await reviewedShaAt({ repo: repo.name, prId, at: item.postedAt }) : null);
    if (sinceSha === headSha) continue;
    prior.push({
      threadId: item.threadId,
      title: item.title,
      fixPrompt: item.fixPrompt,
      changesSince: sinceSha ? `git diff ${sinceSha}..${headSha}` : null,
      replies: item.replies,
    });
  }
  return prior;
}

async function prepareAndQueue({ repo, repos, pr, gate, sensorCfg, onlyParts = null }) {
  const prId = pr.pullRequestId;
  const workItemIds = await getWorkItemIds(repo, prId);
  const workItems = await getWorkItemsWithStories(workItemIds);
  const { wtPath, mergeBase, targetBranch } = await createWorktree(repo, pr, gate.headSha);
  const originBranch = await branchOrigin(repo, gate.headSha).catch(() => null);
  if (!TEST_DRY) {
    await setReviewBranches({ repo: repo.name, prId, headSha: gate.headSha, source: branchOf(pr.sourceRefName), target: targetBranch, origin: originBranch })
      .catch((err) => console.warn(`[pr-review] branches of !${prId}: ${err.message}`));
  }
  const pair = await findPairContext(repo, repos, pr, workItemIds);
  const targetGate = repo.targetGate === false ? null : checkTargetBranch({
    source: branchOf(pr.sourceRefName),
    target: targetBranch,
    nextRelease: nextReleaseFrom(await mainVersion(repo.projectDir)),
  });

  const priorFindings = await priorFindingsFor(repo, prId, gate.headSha);
  const conventions = collectRepoConventions(wtPath);
  const contextDir = path.join(wtPath, '.seal-review');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, 'us.md'), renderWorkItemsMarkdown(workItems));
  const context = {
    repo: repo.name,
    stack: repo.stack,
    repoSkill: repo.skill,
    repoSkillPath: repo.skillPath && fs.existsSync(repo.skillPath) ? repo.skillPath : null,
    prId,
    prUrl: prWebUrl(repo.name, prId),
    title: pr.title,
    description: pr.description || '',
    author: pr.createdBy?.displayName || '',
    mode: gate.action,
    headSha: gate.headSha,
    previousSha: gate.previousSha || null,
    targetBranch,
    mergeBase,
    diffCommand: `git diff ${mergeBase}..${gate.headSha}`,
    reReviewDiffCommand: gate.previousSha ? `git diff ${gate.previousSha}..${gate.headSha}` : null,
    workItems: workItems.map((item) => ({
      id: item.id,
      type: item.fields?.['System.WorkItemType'],
      title: item.fields?.['System.Title'],
      state: item.fields?.['System.State'],
    })),
    usFile: '.seal-review/us.md',
    ocrBin: OCR_BIN,
    repoSkills: conventions.repoSkills,
    docsTree: conventions.docsTree,
    targetGate,
    pair,
    consumers: await consumerContext(repos, repo).catch(() => []),
    priorFindings,
    resultBlock: { start: RESULT_BLOCK_START, end: RESULT_BLOCK_END },
  };
  const plan = await planForDiff(wtPath, mergeBase, gate.headSha);
  const chunked = repo.chunkReviews !== false && needsChunking(plan);
  const parts = chunked
    ? plan.chunks.map((chunk) => ({ ...chunk, diffCommand: `git diff ${mergeBase}..${gate.headSha} -- ${chunk.paths.map((file) => `'${file.replace(/'/g, "'\\''")}'`).join(' ')}` }))
    : [];
  const authorEmail = (pr.createdBy?.uniqueName || '').toLowerCase();
  const authorComments = repo.evidenceGate === false ? [] : ((await getThreads(repo, prId)).threads || [])
    .flatMap((thread) => thread.comments || [])
    .filter((comment) => !comment.isDeleted && (comment.author?.uniqueName || '').toLowerCase() === authorEmail)
    .map((comment) => comment.content || '');
  const evidenceReminder = repo.evidenceGate === false ? null : checkVisualEvidence({
    stack: repo.stack,
    paths: plan.chunks.flatMap((chunk) => chunk.paths),
    description: pr.description || '',
    authorComments,
    kit: sensorCfg.azure_pr_review_evidence_kit || null,
  });
  context.review = chunked ? 'consolidate-parts' : 'single';
  context.resultFile = '.seal-review/result.json';
  context.plan = { totalLines: plan.totalLines, totalFiles: plan.totalFiles, docLines: plan.docLines, parts: parts.map(({ paths, diffCommand, ...rest }) => ({ ...rest, files: paths.length })) };
  if (chunked) context.partsFindingsFile = '.seal-review/parts-findings.json';
  fs.writeFileSync(path.join(contextDir, 'context.json'), JSON.stringify(context, null, 2));
  for (const part of parts) {
    fs.writeFileSync(path.join(contextDir, `part-${part.id}.json`), JSON.stringify({ ...context, review: 'part', part, partsTotal: parts.length, resultFile: `.seal-review/part-${part.id}/result.json` }, null, 2));
  }

  const lock = await writeToAzure(`post lock on ${repo.name} !${prId}`, () =>
    azRequest('POST', repoUrl(repo, `/pullRequests/${prId}/threads`), {
      comments: [{ parentCommentId: 0, content: `${LOCK_TEXT}\n\n_Revisão automática em andamento (${gate.action})._`, commentType: 1 }],
      status: 4,
    }),
  );

  const task = {
    id: `seal_pr_${prId}`,
    type: 'task',
    summary: `${SUMMARY_PREFIX}${prId}: ${pr.title}`.slice(0, 80),
    detail: JSON.stringify({
      tag: PIPELINE_TAG,
      repo: repo.name,
      prId,
      headSha: gate.headSha,
      mode: gate.action,
      lockThreadId: lock?.id ?? null,
      lockCommentId: lock?.comments?.[0]?.id ?? null,
      pair: pair.map((paired) => ({ repo: paired.repo, prId: paired.prId, status: paired.status })),
      targetGate,
      branchReminder: repo.branchGate === false ? null : checkBranchName({ source: branchOf(pr.sourceRefName), target: targetBranch }),
      evidenceReminder,
      testSkills: conventions.repoSkills.map((skill) => skill.name).filter((name) => /test|tdd/i.test(name)),
      prUrl: prWebUrl(repo.name, prId),
      chunked,
      parts: parts.length,
    }),
    execute_at: chunked ? WAITING_FOR_PARTS_AT : new Date().toISOString(),
    recurrence: null,
    next_run: null,
    prompt: buildPrompt(repo.name),
    project: wtPath,
    allowed_tools: '[]',
    disallowed_tools: JSON.stringify(DENIED_TOOLS),
    session_id: 'pending',
    model: sensorCfg.azure_pr_review_model || null,
    permission_mode: 'bypassPermissions',
    notify_type: 'silent',
    notify_channel: 'system',
    notify_target: null,
    people: JSON.stringify([pr.createdBy?.displayName || 'unknown']),
    priority: 'medium',
    status: 'pending',
    created: new Date().toISOString(),
    max_runs: null,
  };

  if (TEST_DRY) {
    if (chunked) console.log(`[pr-review] [dry] WOULD SPLIT ${repo.name} !${prId} into ${parts.length} parts: ${parts.map((part) => `${part.id}:${part.kind}:${part.lines}`).join(' ')}`);
    console.log(`[pr-review] [dry] WOULD CREATE task ${task.id} (${repo.name}, ${gate.action}, ${branchOf(pr.sourceRefName)} → ${targetBranch}, gate=${targetGate ? targetGate.severity : 'ok'}, pair=${pair.map((paired) => `${paired.repo}!${paired.prId}[${paired.reasons}]`).join(',') || '-'}, us=${workItemIds.join(',') || '-'})`);
    return false;
  }
  try {
    const saved = await upsertReviewTask(task);
    if (!saved) throw new Error(`task ${task.id} is still active`);
    for (const part of parts) {
      if (onlyParts && !onlyParts.includes(part.id)) continue;
      const partSaved = await upsertReviewTask({
        ...task,
        id: `${task.id}_p${part.id}`,
        summary: `${SUMMARY_PREFIX}${prId}: parte ${part.id}/${parts.length} ${part.label}`.slice(0, 80),
        detail: JSON.stringify({ tag: PART_TAG, repo: repo.name, prId, headSha: gate.headSha, part: part.id, parts: parts.length, kind: part.kind, label: part.label }),
        execute_at: new Date().toISOString(),
        prompt: buildPartPrompt(part, parts.length, repo.name),
        session_id: null,
      });
      if (!partSaved) throw new Error(`part ${part.id} of ${task.id} is still active`);
    }
    if (chunked) console.log(`[pr-review] ${repo.name} !${prId} split into ${parts.length} parts (${plan.totalLines} lines of code, ${plan.docLines} of docs)`);
    return true;
  } catch (err) {
    if (lock?.id && lock?.comments?.[0]?.id) {
      await azRequest('DELETE', repoUrl(repo, `/pullRequests/${prId}/threads/${lock.id}/comments/${lock.comments[0].id}`)).catch(() => {});
    }
    throw err;
  }
}

export async function upsertReviewTask(task) {
  const reused = await db.run(
    `UPDATE tasks SET summary = ?, detail = ?, execute_at = ?, prompt = ?, project = ?, allowed_tools = ?, disallowed_tools = ?,
       model = ?, permission_mode = ?, notify_type = ?, notify_channel = ?, notify_target = ?, people = ?, priority = ?,
       session_id = ?, status = 'pending', result = NULL, retry_count = 0, completed_at = NULL, last_notified_at = NULL
     WHERE id = ? AND status IN ('done', 'failed', 'archived', 'acknowledged')`,
    [task.summary, task.detail, task.execute_at, task.prompt, task.project, task.allowed_tools, task.disallowed_tools,
      task.model, task.permission_mode, task.notify_type, task.notify_channel, task.notify_target, task.people, task.priority,
      task.session_id || null, task.id],
  );
  if ((reused?.changes ?? reused?.rowsAffected ?? 0) > 0) return true;
  return insertTaskIfNew(task);
}

const parseDetail = (detail) => {
  try {
    const parsed = JSON.parse(detail || '');
    return parsed?.tag === PIPELINE_TAG ? parsed : null;
  } catch {
    return null;
  }
};

async function setMyVote(prId, vote, repo) {
  if (!MY_AZURE_ID) throw new Error('SEAL_AZURE_MY_ID not configured');
  return azRequest('PUT', repoUrl(repo, `/pullRequests/${prId}/reviewers/${MY_AZURE_ID}`), { vote, id: MY_AZURE_ID });
}

async function updateLock(repo, prId, meta, content) {
  if (!meta.lockThreadId || !meta.lockCommentId) {
    return azRequest('POST', repoUrl(repo, `/pullRequests/${prId}/threads`), {
      comments: [{ parentCommentId: 0, content, commentType: 1 }],
      status: 4,
    });
  }
  return azRequest('PATCH', repoUrl(repo, `/pullRequests/${prId}/threads/${meta.lockThreadId}/comments/${meta.lockCommentId}`), { content });
}

async function postSummaryLast(repo, prId, meta, content) {
  await azRequest('POST', repoUrl(repo, `/pullRequests/${prId}/threads`), {
    comments: [{ parentCommentId: 0, content, commentType: 1 }],
    status: 4,
  });
  if (!meta.lockThreadId || !meta.lockCommentId) return;
  try {
    await azRequest('DELETE', repoUrl(repo, `/pullRequests/${prId}/threads/${meta.lockThreadId}/comments/${meta.lockCommentId}`));
  } catch (err) {
    console.warn(`[pr-review] lock delete failed on !${prId}, closing it instead: ${err.message.slice(0, 160)}`);
    await updateLock(repo, prId, meta, 'Revisão concluída — resumo no último comentário.').catch(() => {});
  }
}

async function postFinding(repo, prId, finding) {
  try {
    return await azRequest('POST', repoUrl(repo, `/pullRequests/${prId}/threads`), buildThreadPayload(finding));
  } catch (err) {
    if (!finding.file) throw err;
    console.warn(`[pr-review] inline thread failed on !${prId} (${finding.file}:${finding.line}), posting general: ${err.message.slice(0, 160)}`);
    return azRequest('POST', repoUrl(repo, `/pullRequests/${prId}/threads`), {
      comments: [{ parentCommentId: 0, content: formatFindingComment(finding, { includeLocation: true }), commentType: 1 }],
      status: buildThreadPayload(finding).status,
    });
  }
}

function reviewHeaderPlain(entry, data, meta) {
  const counts = countBySeverity(data.findings);
  const waiting = data.verdict === 'needs-work';
  return [
    `${waiting ? '⏸️ Aguardando autor' : '✅ Aprovado'} · ${entry.repo} !${entry.prId}${meta.mode === 're-review' ? ' · re-revisão' : ''}`,
    `${entry.title} · ${entry.author}`,
    ...(waiting ? [`🔴 ${counts.blocker} · 🟡 ${counts.warning} · 🔵 ${counts.nit}${data.blockingReason ? ` — ${data.blockingReason}` : ''}`] : []),
    ...(data.usCoverage ? [usCoverageLine(data.usCoverage)] : []),
  ].join('\n');
}

function reviewTelegramText(entry, data, meta) {
  const counts = countBySeverity(data.findings);
  const waiting = data.verdict === 'needs-work';
  const lines = [
    `🤖 <b>${waiting ? '⏸️ Aguardando autor' : '✅ Aprovado'}</b> · ${escapeHtml(entry.repo)} <a href="${entry.url}">!${entry.prId}</a>${meta.mode === 're-review' ? ' · re-revisão' : ''}`,
    `${escapeHtml(entry.title)} · ${escapeHtml(entry.author)}`,
  ];
  if (waiting) {
    lines.push(`🔴 ${counts.blocker} · 🟡 ${counts.warning} · 🔵 ${counts.nit}${data.blockingReason ? ` — ${escapeHtml(data.blockingReason)}` : ''}`);
  }
  if (data.modelVerdict === 'approved' && waiting) lines.push('⚠️ A LLM sugeriu aprovar, mas a regra do sensor não aprova com comentário pendente.');
  if (data.usCoverage) lines.push(usCoverageLine(data.usCoverage));
  if (waiting) {
    lines.push('', '✉️ <b>Mensagem sugerida para o autor:</b>', `<code>${escapeHtml(messageDraftFor('blocker', entry))}</code>`);
  }
  return lines.join('\n');
}

async function offerCharge(entry, data, meta, priorOpen) {
  const config = readMessagingConfig();
  if (config.charge?.enabled === false || !entry.author) return false;
  if (!shouldOfferCharge({ verdict: data.verdict, counts: entry.counts, reReview: meta.mode === 're-review' })) {
    console.log(`[pr-review] !${entry.prId}: re-revisão sem achado novo, só informativo, sem cobrança`);
    return false;
  }
  const message = chargeMessage({
    author: entry.author,
    prId: entry.prId,
    title: entry.title,
    url: entry.url,
    verdict: data.verdict,
    counts: entry.counts,
    reReview: meta.mode === 're-review',
    priorOpen,
  });
  try {
    const expired = await supersedePendingOffers({ actionName: 'cobranca', prId: entry.prId });
    if (expired > 0) console.log(`[pr-review] !${entry.prId}: ${expired} oferta(s) antiga(s) de cobrança substituída(s)`);
    const offer = await triggerAction('cobranca', {
      connector: config.default,
      author: { name: entry.author, email: entry.authorEmail || null },
      message,
      prId: entry.prId,
      sentKeys: chargeKeys(entry),
      header: `${reviewHeaderPlain(entry, data, meta)}\n${entry.url}`,
    });
    return Boolean(offer);
  } catch (err) {
    console.warn(`[pr-review] cobrança de !${entry.prId} não foi oferecida: ${err.message}`);
    return false;
  }
}

async function publishCompletedReviews(repos, state, { taskId = null } = {}) {
  const tasks = await db.all(
    `SELECT id, summary, detail, result, retry_count, session_id, project FROM tasks
     WHERE summary LIKE ? AND detail LIKE ? AND status = 'done' AND result IS NOT NULL
       AND result NOT LIKE ? AND result NOT LIKE ? AND (? IS NULL OR id = ?)`,
    [`${SUMMARY_PREFIX}%`, `%${PIPELINE_TAG}%`, `%${PUBLISHED_MARKER}%`, `%${PUBLISH_FAILED_MARKER}%`, taskId, taskId],
  );
  let published = 0;
  for (const task of tasks) {
    const meta = parseDetail(task.detail);
    if (!meta) continue;
    const repo = repos.find((candidate) => candidate.name === meta.repo);
    if (!repo) continue;
    const prId = meta.prId;
    const claim = { repo: repo.name, prId, headSha: meta.headSha };
    if (!(await beginPublish(claim))) {
      const row = await reviewForSha(claim);
      if (row?.status === 'publishing') continue;
      console.log(`[pr-review] !${prId}@${meta.headSha.slice(0, 8)} is ${row?.status || 'missing'} in the ledger, marking task`);
      await db.run(`UPDATE tasks SET result = result || ? WHERE id = ?`, [`\n\n${PUBLISHED_MARKER} skipped-by-ledger`, task.id]);
      continue;
    }
    const pr = await getPrById(prId);
    if (pr && pr.status !== 'active') {
      console.log(`[pr-review] !${prId} is ${pr.status}, dropping its finished review without posting`);
      await db.run(`UPDATE tasks SET result = result || ? WHERE id = ?`, [`\n\n${PUBLISHED_MARKER} skipped-pr-${pr.status}`, task.id]);
      await finishReview({ ...claim, status: 'cancelled', error: `PR ${pr.status}`, sessionId: task.session_id, worktree: task.project });
      continue;
    }
    const parsed = parseTaskResult(task.result, task.project ? path.join(task.project, '.seal-review', 'result.json') : null);

    if (!parsed.ok && (task.retry_count || 0) < 1) {
      console.warn(`[pr-review] !${prId}: unusable result (${parsed.error}), retrying the review once`);
      await db.run(`UPDATE tasks SET status = 'pending', result = NULL, retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?`, [task.id]);
      await db.run(`UPDATE pr_reviews SET status = 'queued', publish_started_at = NULL WHERE repo = ? AND pr_id = ? AND head_sha = ? AND status = 'publishing'`, [claim.repo, claim.prId, claim.headSha]);
      continue;
    }
    if (!parsed.ok) {
      console.warn(`[pr-review] !${prId}: unusable result (${parsed.error})`);
      await writeToAzure(`mark lock failed on !${prId}`, () =>
        updateLock(repo, prId, meta, `⚠️ A revisão automática não gerou um resultado utilizável (${parsed.error}). Vou tentar de novo no próximo commit.`),
      ).catch((err) => console.warn(`[pr-review] lock update failed: ${err.message}`));
      await db.run(`UPDATE tasks SET result = result || ? WHERE id = ?`, [`\n\n${PUBLISH_FAILED_MARKER} ${parsed.error}`, task.id]);
      await failReview({ ...claim, error: parsed.error });
      await sendTelegram(`⚠️ Review sem resultado utilizável · ${escapeHtml(repo.name)} !${prId} (${escapeHtml(parsed.error)})`);
      continue;
    }

    const { data } = parsed;
    data.findings = applyUsScenarioFinding(data.findings, data.usCoverage, { repo: repo.name, prUrl: meta.prUrl, testSkills: meta.testSkills || [] });
    if (meta.targetGate && !data.findings.some((finding) => (finding.sources || []).includes('target-gate'))) {
      data.findings.unshift(meta.targetGate);
    }
    if (meta.branchReminder?.blocking === false && !data.findings.some((finding) => (finding.sources || []).includes('branch-gate'))) {
      data.findings.push(meta.branchReminder);
    }
    if (meta.evidenceReminder && !data.findings.some((finding) => (finding.sources || []).includes('evidence-gate'))) {
      data.findings.push(meta.evidenceReminder);
    }
    const prMentions = [{ prId, url: prWebUrl(repo.name, prId) }, ...(meta.pair || []).map((paired) => ({ prId: paired.prId, url: prWebUrl(paired.repo, paired.prId) }))];
    data.findings = data.findings.map((finding) => mentionPullRequests(finding, prMentions));
    if (typeof data.summary === 'string') data.summary = mentionPullRequests({ body: data.summary }, prMentions).body;
    data.verdict = deriveVerdict(data.findings);
    if ((data.priorResolved || []).length > 0 && !TEST_DRY) {
      const { resolved } = await resolveFromChat(repo, { pr_id: prId, head_sha: meta.headSha }, data.priorResolved, { approve: false, verified: true })
        .catch((err) => { console.warn(`[pr-review] closing fixed comments on !${prId}: ${err.message}`); return { resolved: [] }; });
      if (resolved.length > 0) console.log(`[pr-review] !${prId}: ${resolved.length} comentário(s) anterior(es) corrigido(s) no código, fechado(s)`);
    }
    threadsCache.delete(`${repo.id}:${prId}`);
    const before = await getThreads(repo, prId);
    const priorOpen = before.ok ? countOpenBotThreads(before.threads, MY_EMAIL, { excludeThreadIds: [meta.lockThreadId].filter(Boolean) }) : 0;
    const priorThreads = before.ok ? openBotFindings(before.threads, MY_EMAIL, { excludeThreadIds: [meta.lockThreadId].filter(Boolean) }) : [];
    data.verdict = verdictFor(blockingFindings(data.findings).length, priorOpen);
    let failures = 0;
    const alreadyPosted = before.ok ? postedFindingTitles(before.threads, MY_EMAIL) : new Set();
    for (const finding of data.findings) {
      if (alreadyPosted.has(finding.title)) continue;
      try {
        await writeToAzure(`post finding on !${prId}: ${finding.title}`, () => postFinding(repo, prId, { ...finding, headSha: meta.headSha }));
      } catch (err) {
        failures++;
        console.warn(`[pr-review] finding post failed on !${prId}: ${err.message.slice(0, 200)}`);
      }
    }
    try {
      await writeToAzure(`post summary last on !${prId}`, () => postSummaryLast(repo, prId, meta, formatSummaryComment({ data, headSha: meta.headSha, priorOpen, priorThreads, prUrl: prWebUrl(repo.name, prId) })));
    } catch (err) {
      console.warn(`[pr-review] summary update failed on !${prId}: ${err.message}`);
    }
    try {
      await writeToAzure(`vote ${data.verdict} on !${prId}`, () => setMyVote(prId, VOTE_MAP[data.verdict], repo));
    } catch (err) {
      console.warn(`[pr-review] vote failed on !${prId}: ${err.message}`);
    }

    const entry = upsertPrEntry(state, pr || { pullRequestId: prId, title: task.summary, status: 'active' }, repo.name, ORG, PROJECT);
    const counts = countBySeverity(data.findings);
    Object.assign(entry, {
      reviewedSha: meta.headSha,
      reviewedAt: new Date().toISOString(),
      verdict: data.verdict,
      counts,
      testGaps: data.findings.filter((finding) => finding.kind === 'test-gap').length,
      docRequests: data.findings.filter((finding) => finding.kind === 'doc-request').length,
      usCoverage: data.usCoverage,
      pairedPrs: meta.pair || [],
      postFailures: failures,
    });
    entry.needsAction = (entry.needsAction || []).filter((item) => item.reason !== 'blocker');
    if (data.verdict === 'needs-work') {
      entry.needsAction.push({ reason: 'blocker', since: entry.reviewedAt, messageDraft: messageDraftFor('blocker', entry) });
      entry.notified = { ...entry.notified, blocker: entry.reviewedAt };
    }

    const offered = await offerCharge(entry, data, meta, priorOpen);
    if (!offered && data.verdict === 'needs-work') await sendTelegram(reviewTelegramText(entry, data, meta));
    if (!offered && data.verdict !== 'needs-work') await queueDigest(reviewTelegramText(entry, data, meta));
    await db.run(`UPDATE tasks SET result = result || ? WHERE id = ?`, [`\n\n${PUBLISHED_MARKER} ${data.verdict} findings=${data.findings.length} failures=${failures}`, task.id]);
    await finishReview({ ...claim, status: 'published', verdict: data.verdict, findings: data.findings.length, sessionId: task.session_id, worktree: task.project });
    published++;
    console.log(`[pr-review] Published !${prId} (${repo.name}): ${data.verdict}, ${data.findings.length} finding(s)`);
  }
  return published;
}

const parseDetailTagged = (detail, tag) => {
  try {
    const parsed = JSON.parse(detail || '');
    return parsed?.tag === tag ? parsed : null;
  } catch {
    return null;
  }
};

async function advanceChunkedReviews() {
  const waiting = await db.all(`SELECT id, detail, project FROM tasks WHERE summary LIKE ? AND status = 'pending' AND execute_at = ?`, [`${SUMMARY_PREFIX}%`, WAITING_FOR_PARTS_AT]);
  let released = 0;
  for (const main of waiting) {
    const meta = parseDetail(main.detail);
    if (!meta?.chunked) continue;
    const partRows = await db.all(`SELECT id, status, result, retry_count, detail FROM tasks WHERE id LIKE ?`, [`${main.id}_p%`]);
    const parts = partRows.map((row) => ({ ...row, meta: parseDetailTagged(row.detail, PART_TAG) })).filter((row) => row.meta && row.meta.headSha === meta.headSha);
    const finished = (row) => row.status === 'done' || row.status === 'archived' || (row.status === 'failed' && (row.retry_count || 0) >= MAX_RETRIES);
    if (parts.length < meta.parts || !parts.every(finished)) continue;
    const summary = parts
      .sort((left, right) => left.meta.part - right.meta.part)
      .map((row) => {
        const parsed = row.status === 'done' ? parseTaskResult(row.result, path.join(main.project, '.seal-review', `part-${row.meta.part}`, 'result.json')) : { ok: false, error: `parte ${row.status}` };
        return {
          part: row.meta.part,
          kind: row.meta.kind,
          label: row.meta.label,
          ok: parsed.ok,
          error: parsed.ok ? null : parsed.error,
          summary: parsed.ok ? parsed.data.summary : null,
          findings: parsed.ok ? parsed.data.findings.map((finding) => ({ ...finding, sources: [...new Set([...finding.sources, `part-${row.meta.part}`])] })) : [],
        };
      });
    fs.writeFileSync(path.join(main.project, '.seal-review', 'parts-findings.json'), JSON.stringify({ parts: summary }, null, 2));
    await db.run(`UPDATE tasks SET execute_at = ? WHERE id = ? AND status = 'pending' AND execute_at = ?`, [new Date().toISOString(), main.id, WAITING_FOR_PARTS_AT]);
    released++;
    const failed = summary.filter((part) => !part.ok);
    console.log(`[pr-review] !${meta.prId}: ${summary.length} parts done (${failed.length} failed), releasing consolidation`);
  }
  return released;
}

async function unblockLoginExpired() {
  const blocked = await db.all(`SELECT id FROM tasks WHERE status = 'failed' AND result LIKE '%login expired%'`);
  if (blocked.length === 0) return;
  const auth = await checkClaudeAuth();
  if (!auth.ok) return;
  const ids = blocked.map((task) => task.id);
  await db.run(`UPDATE tasks SET status = 'pending', result = NULL WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  console.log(`[seal:auth] Claude login restored, unblocking ${ids.length} task(s)`);
}

async function archiveMootTasks() {
  const open = await db.all(
    `SELECT id, summary FROM tasks WHERE summary LIKE ? AND status NOT IN ('done', 'archived', 'acknowledged')`,
    [`${SUMMARY_PREFIX}%`],
  );
  for (const task of open) {
    const match = task.summary.match(/PR #(\d+)/);
    if (!match) continue;
    const pr = await getPrById(Number(match[1]));
    if (!pr) continue;
    const reason = pr.status !== 'active' ? `PR was ${pr.status}` : pr.isDraft ? 'PR became draft' : null;
    if (!reason) continue;
    await db.run(`UPDATE tasks SET status = 'archived', result = ?, completed_at = datetime('now') WHERE id = ?`, [`${reason} (auto-archived)`, task.id]);
    console.log(`[pr-review] Auto-archived ${task.id}: ${reason}`);
  }
}

async function cleanupWorktrees(repos) {
  for (const repo of repos) {
    const base = path.join(WORKTREE_ROOT, repo.name);
    if (!fs.existsSync(base)) continue;
    await git(repo.projectDir, ['worktree', 'prune']).catch(() => {});
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('pr-')) continue;
      const wtPath = path.join(base, dir);
      const needed = await db.get(
        `SELECT id FROM tasks WHERE project = ?
           AND (status IN ('pending', 'running', 'firing') OR (status = 'failed' AND COALESCE(retry_count, 0) < ?))`,
        [wtPath, MAX_RETRIES],
      );
      if (needed) continue;
      await removeWorktree(repo, wtPath);
      console.log(`[pr-review] Cleaned worktree ${wtPath}`);
    }
  }
}

const ledgerTime = (value) => (value ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`) || 0 : 0);

let AUTHOR_REPLY_QUIET_MS = 3 * 60 * 1000;

async function approveHead({ repo, prId, headSha, sessionId = null, worktree = null, reason }) {
  await azRequest('POST', repoUrl(repo, `/pullRequests/${prId}/threads`), {
    comments: [{ parentCommentId: 0, content: `**✅ Aprovado** — ${reason}\n\n${reviewedMarker(headSha)}`, commentType: 1 }],
    status: 4,
  });
  await setMyVote(prId, VOTE_MAP.approved, repo);
  await finishReview({ repo: repo.name, prId, headSha, status: 'published', verdict: 'approved', findings: 0, sessionId, worktree });
  const state = readReviewState();
  const entry = state.prs[String(prId)];
  if (entry) {
    Object.assign(entry, { verdict: 'approved', needsAction: (entry.needsAction || []).filter((item) => item.reason !== 'blocker') });
    writeReviewState(state);
  }
  threadsCache.delete(`${repo.id}:${prId}`);
  await queueDigest(`✅ <b>Aprovado</b> · ${escapeHtml(repo.name)} <a href="${prWebUrl(repo.name, prId)}">!${prId}</a> · ${escapeHtml(reason)}`);
}

async function verifyResolvedThenApprove({ repo, pr, threads, ledgerForHead }) {
  if (!needsCommitVerification({ ledgerForHead })) return false;
  const prId = pr.pullRequestId;
  if (TEST_DRY) {
    console.log(`[pr-review] [dry] WOULD verify comments against commits on !${prId}`);
    return false;
  }
  if (!(await markVerifyRequested({ repo: repo.name, prId, headSha: ledgerForHead.head_sha }))) return false;
  const candidates = [
    ...resolvedBotFindings(threads, MY_EMAIL).map((item) => ({ ...item, open: false, replies: [] })),
    ...openBotFindings(threads, MY_EMAIL).map((item) => ({ ...item, open: true })),
  ];
  const findings = [];
  for (const item of candidates) {
    const sinceSha = findingPostedSha(item, threads, MY_EMAIL) || (item.postedAt ? await reviewedShaAt({ repo: repo.name, prId, at: item.postedAt }) : null);
    if (sinceSha && sinceSha !== ledgerForHead.head_sha) findings.push({ ...item, sinceSha });
  }
  const stillOpen = countOpenBotThreads(threads, MY_EMAIL);
  if (findings.length === 0 || !ledgerForHead.session_id) {
    if (stillOpen > 0) return false;
    await approveHead({ repo, prId, headSha: ledgerForHead.head_sha, sessionId: ledgerForHead.session_id, worktree: ledgerForHead.worktree, reason: 'nenhum ponto pendente no commit revisado.' });
    console.log(`[pr-review] !${prId}: nada para conferir, aprovada`);
    return true;
  }
  enqueueChatRequest({ prId, question: buildVerifyResolvedQuestion({ prId, headSha: ledgerForHead.head_sha, findings }), source: 'verify-resolved' });
  console.log(`[pr-review] !${prId}: conferindo ${findings.length} comentário(s) contra os commits (${findings.filter((item) => item.open).length} aberto(s))`);
  return true;
}

async function replyInFindings(repo, row, replies) {
  const prId = row.pr_id;
  threadsCache.delete(`${repo.id}:${prId}`);
  const { ok, threads } = await getThreads(repo, prId);
  if (!ok) return { replied: [], missing: replies.map((item) => item.title) };
  const byTitle = findingThreadIdsByTitle(threads, MY_EMAIL);
  const replied = [];
  const missing = [];
  for (const item of replies) {
    const threadId = byTitle.get(item.title);
    if (!threadId) {
      missing.push(item.title);
      continue;
    }
    await azRequest('POST', repoUrl(repo, `/pullRequests/${prId}/threads/${threadId}/comments`), { parentCommentId: 1, content: `🤖 ${item.text}`, commentType: 1 });
    replied.push(item.title);
  }
  threadsCache.delete(`${repo.id}:${prId}`);
  return { replied, missing };
}

async function reopenFindings(repo, row, reopen, { lead = '🤖 Revisei os commits depois deste comentário e ainda falta:' } = {}) {
  const prId = row.pr_id;
  threadsCache.delete(`${repo.id}:${prId}`);
  const { ok, threads } = await getThreads(repo, prId);
  if (!ok) return { reopened: [], missing: reopen.map((item) => item.title) };
  const byTitle = findingThreadIdsByTitle(threads, MY_EMAIL);
  const reopened = [];
  const missing = [];
  for (const item of reopen) {
    const threadId = byTitle.get(item.title);
    if (!threadId) {
      missing.push(item.title);
      continue;
    }
    const prompt = item.fixPrompt ? `\n\n<details>\n<summary>🤖 Prompt de correção</summary>\n\n\`\`\`\n${item.fixPrompt.replace(/```/g, "'''")}\n\`\`\`\n</details>` : '';
    await azRequest('POST', repoUrl(repo, `/pullRequests/${prId}/threads/${threadId}/comments`), {
      parentCommentId: 1,
      content: `${lead} ${item.missing || 'a correção não aparece no código.'}${prompt}`,
      commentType: 1,
    });
    await azRequest('PATCH', repoUrl(repo, `/pullRequests/${prId}/threads/${threadId}`), { status: 1 });
    reopened.push(item.title);
  }
  threadsCache.delete(`${repo.id}:${prId}`);
  return { reopened, missing };
}

async function forwardAuthorReplies(repo, pr, threads, ledgerForHead) {
  if (ledgerForHead?.status !== 'published' || !ledgerForHead.session_id) return false;
  const since = Math.max(ledgerTime(ledgerForHead.finished_at), ledgerTime(ledgerForHead.replies_seen_at));
  const { disputes, general, latestAt } = authorReplies({ threads, myEmail: MY_EMAIL, since });
  if (disputes.length === 0 && general.length === 0) return false;
  if (Date.now() - latestAt < AUTHOR_REPLY_QUIET_MS) return false;
  if (pendingChatRequests().some((request) => request.prId === pr.pullRequestId && request.source === 'author-reply')) return false;
  if (TEST_DRY) {
    console.log(`[pr-review] [dry] WOULD forward ${disputes.length} author replies on !${pr.pullRequestId}`);
    return false;
  }
  enqueueChatRequest({ prId: pr.pullRequestId, question: buildAuthorReplyQuestion({ prId: pr.pullRequestId, disputes, general, acceptanceRulesPath: ACCEPTANCE_JUDGE_PATH }), source: 'author-reply' });
  await markRepliesSeen({ repo: repo.name, prId: pr.pullRequestId, headSha: ledgerForHead.head_sha, at: new Date(latestAt).toISOString() });
  console.log(`[pr-review] !${pr.pullRequestId}: interação do autor (${disputes.length} achado(s), ${general.length} comentário(s)), reavaliando`);
  return true;
}

async function notifyOwnerWorkItems(prId, workItems) {
  const lines = workItems.map((item) => `• #${item.id}: ${item.change}`);
  const url = (id) => `https://dev.azure.com/${ORG}/${PROJECT}/_workitems/edit/${id}`;
  await sendTelegram([`📝 <b>Work item para você ajustar</b> · !${prId}`, ...lines.map(escapeHtml), '', ...workItems.map((item) => url(item.id))].join('\n')).catch(() => {});
  const config = readMessagingConfig();
  if (config.ownerNotify?.enabled === false) return;
  const text = [`SEAL: a revisão da !${prId} depende de ajuste em work item, e quem ajusta é você:`, ...lines, ...workItems.map((item) => url(item.id))].join('\n');
  await getMessagingConnector(config.default, config)
    .sendDirect({ email: MY_EMAIL }, text)
    .catch((err) => console.warn(`[pr-review] aviso de work item no Teams falhou: ${err.message}`));
}

async function clearStaleFailureNotices(repo, pr, threads, ledgerForHead) {
  const stale = staleFailureNotices({ threads, myEmail: MY_EMAIL, headStatus: ledgerForHead?.status });
  for (const notice of stale) {
    const url = repoUrl(repo, `/pullRequests/${pr.pullRequestId}/threads/${notice.threadId}/comments/${notice.commentId}`);
    await writeToAzure(`delete stale failure notice on !${pr.pullRequestId}`, () => azRequest('DELETE', url));
    console.log(`[pr-review] !${pr.pullRequestId}: aviso de falha apagado, o commit ${ledgerForHead.head_sha.slice(0, 8)} já foi publicado`);
  }
  if (stale.length > 0) threadsCache.delete(`${repo.id}:${pr.pullRequestId}`);
  return stale.length;
}

async function clearZombieLocks(repo, pr, threads) {
  const lockComment = threads
    .flatMap((thread) => (thread.comments || []).map((comment) => ({ thread, comment })))
    .find(({ comment }) => !comment.isDeleted && (comment.author?.uniqueName || '').toLowerCase() === MY_EMAIL && (comment.content || '').includes(LOCK_TEXT));
  if (!lockComment) return false;
  const active = await db.get(
    `SELECT id FROM tasks WHERE id = ? AND (status IN ('pending', 'running', 'firing')
       OR (status = 'done' AND result NOT LIKE ? AND result NOT LIKE ?))`,
    [`seal_pr_${pr.pullRequestId}`, `%${PUBLISHED_MARKER}%`, `%${PUBLISH_FAILED_MARKER}%`],
  );
  if (active) return false;
  const queued = await db.get(`SELECT id FROM pr_reviews WHERE repo = ? AND pr_id = ? AND status IN ('queued', 'publishing')`, [repo.name, pr.pullRequestId]);
  if (queued) return false;
  const lockUrl = repoUrl(repo, `/pullRequests/${pr.pullRequestId}/threads/${lockComment.thread.id}/comments/${lockComment.comment.id}`);
  await writeToAzure(`delete zombie lock on !${pr.pullRequestId}`, () =>
    azRequest('DELETE', lockUrl).catch(() => azRequest('PATCH', lockUrl, { content: 'Revisão automática reiniciada.' })),
  );
  threadsCache.delete(`${repo.id}:${pr.pullRequestId}`);
  return true;
}

async function usageLimitOf(taskId, result) {
  if (isUsageLimitResult(result)) {
    const resetAt = Date.parse(result.split('resets ').pop());
    if (Number.isFinite(resetAt)) return { kind: result.split(' ')[2] || 'usage', resetAt: new Date(resetAt) };
  }
  const run = await db.get(
    `SELECT stdout_preview, stderr_preview, finished_at FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`,
    [taskId],
  );
  if (!run) return null;
  const failedAt = run.finished_at ? new Date(run.finished_at) : new Date();
  return parseUsageLimit(`${run.stdout_preview || ''}\n${run.stderr_preview || ''}`, failedAt);
}

const failureReason = (result) => (/sigterm|exit code 143/i.test(result) ? 'processo encerrado no meio' : result.slice(0, 120) || 'motivo desconhecido');

const formatRetryAt = (retryAt) =>
  new Date(`${retryAt.replace(' ', 'T')}Z`).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function retryFailedReviews(repos) {
  const recoverable = ['sigterm', 'exit code 143', 'exit code -2', 'orphaned', 'enoent', 'no such file', 'worktree missing'];
  const failed = await db.all(
    `SELECT id, summary, detail, result, project, retry_count, last_notified_at FROM tasks WHERE summary LIKE ? AND status = 'failed'`,
    [`${SUMMARY_PREFIX}%`],
  );
  for (const task of failed) {
    const result = task.result || '';
    if (isLoginExpiredResult(result)) continue;
    const usageLimit = await usageLimitOf(task.id, result);
    if (usageLimit) {
      const at = resumeAt(usageLimit);
      await deferTask(task.id, at.toISOString(), usageLimitResult(usageLimit));
      console.log(`[pr-review] ${task.id} parou no limite ${usageLimit.kind} do Claude; retoma em ${at.toISOString()}`);
      continue;
    }
    const retryCount = task.retry_count || 0;
    const isRecoverable = result === '' || recoverable.some((pattern) => result.toLowerCase().includes(pattern));
    if (isRecoverable && retryCount < MAX_RETRIES && fs.existsSync(task.project || '')) {
      await db.run(`UPDATE tasks SET status = 'pending', result = NULL, retry_count = retry_count + 1 WHERE id = ?`, [task.id]);
      console.log(`[pr-review] Retrying ${task.id} (${retryCount + 1}/${MAX_RETRIES})`);
      continue;
    }
    if (task.last_notified_at) {
      const last = new Date(task.last_notified_at + 'Z').getTime();
      if (!Number.isNaN(last) && Date.now() - last < NAG_COOLDOWN_MIN * 60_000) continue;
    }
    notify({ ...task, summary: `FAILED: ${task.summary} — ${result.slice(0, 200) || 'unknown'}`, priority: 'high' }, 'sticky');
    await updateLastNotified(task.id);
    const partMeta = parseDetailTagged(task.detail, PART_TAG);
    if (partMeta && (retryCount >= MAX_RETRIES || !isRecoverable)) {
      await db.run(`UPDATE tasks SET status = 'archived' WHERE id = ?`, [task.id]);
      console.log(`[pr-review] ${task.id} arquivada sem conserto; a consolidação segue sem essa parte`);
      continue;
    }
    const meta = parseDetail(task.detail);
    const repo = meta && repos.find((candidate) => candidate.name === meta.repo);
    if (repo && (retryCount >= MAX_RETRIES || !isRecoverable)) {
      const outcome = await failReview({ repo: repo.name, prId: meta.prId, headSha: meta.headSha, error: result.slice(0, 500) || 'unknown' });
      const lockText = outcome.retryAt
        ? `⚠️ A revisão automática foi interrompida (${failureReason(result)}). Tento de novo sozinho a partir de ${formatRetryAt(outcome.retryAt)}.`
        : '⚠️ A revisão automática falhou. Vou tentar de novo no próximo commit.';
      await writeToAzure(`mark lock failed on !${meta.prId}`, () => updateLock(repo, meta.prId, meta, lockText)).catch(() => {});
      if (!outcome.retryAt) {
        const why = outcome.exhausted ? `interrompida ${outcome.rounds - 1} vezes seguidas` : 'falha que não se resolve sozinha';
        await sendTelegram(`⚠️ Revisão automática desistiu · ${escapeHtml(repo.name)} !${meta.prId} (${why}: ${escapeHtml(result.slice(0, 200) || 'sem detalhe')}). Só volta no próximo commit.`).catch(() => {});
      }
      console.log(`[pr-review] !${meta.prId}@${meta.headSha.slice(0, 8)} falhou (${outcome.kind}, rodada ${outcome.rounds})${outcome.retryAt ? `; nova tentativa a partir de ${outcome.retryAt} UTC` : ''}`);
      await db.run(`UPDATE tasks SET status = 'archived' WHERE id = ?`, [task.id]);
    }
  }
}

function collectFollowUps({ state, repo, pr, threads, now, digest, sentMarks }) {
  const entry = upsertPrEntry(state, pr, repo.name, ORG, PROJECT);
  const pairedStatuses = (entry.pairedPrs || []).map((paired) => prByIdCache.get(paired.prId)?.status || paired.status);
  const reasons = followUpReasons({ pr, threads, myEmail: MY_EMAIL, now, pairedStatuses });
  const keep = (entry.needsAction || [])
    .filter((item) => item.reason === 'blocker')
    .map((item) => ({ ...item, messageDraft: messageDraftFor('blocker', entry) }));
  entry.needsAction = [
    ...keep,
    ...reasons.map((reason) => ({
      reason,
      since: (entry.needsAction || []).find((item) => item.reason === reason)?.since || new Date(now).toISOString(),
      messageDraft: messageDraftFor(reason, entry),
    })),
  ];
  for (const item of entry.needsAction) {
    if (isMarkedSent(sentMarks, entry.prId, item, now)) continue;
    if (!shouldNotify(entry.notified, item.reason, now)) continue;
    entry.notified = { ...entry.notified, [item.reason]: new Date(now).toISOString() };
    digest.push({ entry, item });
  }
}

const REASON_LABEL = {
  blocker: 'reprovada, comentários pendentes',
  'stale-no-response': 'comentário sem resposta há +1 dia',
  'open-over-1d': 'aberta há +1 dia',
  'pair-desync': 'PR par já entrou no outro repo',
};

const HEALTH_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const SLEEP_SENSITIVE_ISSUES = /^(long-run|stuck-claim|publishing):/;
const HEALTH_AFTER_WAKE_MS = 60 * 60 * 1000;

async function alertHealth(state, now, extraIssues = []) {
  const justWoke = sleepTracker().sleptWithin(HEALTH_AFTER_WAKE_MS) || process.uptime() * 1000 < HEALTH_AFTER_WAKE_MS;
  const quiet = Boolean(quietUntil(new Date(now)));
  const issues = [...(await healthIssues()), ...extraIssues].filter((issue) => !(justWoke && SLEEP_SENSITIVE_ISSUES.test(issue.key)));
  const notified = state.health?.notified || {};
  const fresh = issues.filter((issue) => !notified[issue.key] || now - new Date(notified[issue.key]).getTime() >= HEALTH_ALERT_COOLDOWN_MS);
  state.health = {
    checkedAt: new Date(now).toISOString(),
    issues: issues.map((issue) => issue.text),
    notified: Object.fromEntries(Object.entries(notified).filter(([key]) => issues.some((issue) => issue.key === key))),
  };
  if (fresh.length === 0 || quiet) return;
  for (const issue of fresh) state.health.notified[issue.key] = new Date(now).toISOString();
  await sendTelegram(['⚠️ <b>Revisão automática travada</b>', ...fresh.map((issue) => `• ${escapeHtml(issue.text)}`)].join('\n'));
}

const REASON_PRIORITY = ['blocker', 'stale-no-response', 'pair-desync', 'open-over-1d'];

async function sendDigest(digest) {
  if (digest.length === 0) return;
  const byPr = new Map();
  for (const { entry, item } of digest) {
    const group = byPr.get(entry.prId) || { entry, items: [] };
    group.items.push(item);
    byPr.set(entry.prId, group);
  }
  const blocks = [...byPr.values()].map(({ entry, items }) => {
    const sorted = [...items].sort((a, b) => REASON_PRIORITY.indexOf(a.reason) - REASON_PRIORITY.indexOf(b.reason));
    const draft = sorted.find((item) => item.messageDraft)?.messageDraft;
    return [
      `• <a href="${entry.url}">${escapeHtml(entry.repo)} !${entry.prId}</a> — ${sorted.map((item) => escapeHtml(REASON_LABEL[item.reason] || item.reason)).join(' · ')}`,
      `  ${escapeHtml(entry.title)} · ${escapeHtml(entry.author)}`,
      draft ? `  ✉️ <code>${escapeHtml(draft)}</code>` : null,
    ]
      .filter(Boolean)
      .join('\n');
  });
  await queueDigest([`📣 <b>PRs que pedem uma cobrança</b> (${byPr.size})`, ...blocks].join('\n\n'));
}

async function refreshPairStatuses(state) {
  const ids = new Set();
  for (const entry of Object.values(state.prs)) {
    if (entry.status === 'active') for (const paired of entry.pairedPrs || []) ids.add(paired.prId);
  }
  for (const prId of ids) await getPrById(prId);
}

export async function runAzurePrReview(sensorCfg = {}) {
  if (!PAT) {
    console.warn('[pr-review] No AZURE_DEVOPS_PAT in env — skipping');
    return { skipped: true, reason: 'no-pat' };
  }
  const missing = configureAzure(sensorCfg);
  if (missing.length > 0) {
    console.warn(`[pr-review] ingest.json sensors is missing ${missing.join(', ')} — skipping`);
    return { skipped: true, reason: 'missing-config', missing };
  }
  threadsCache = new Map();
  prByIdCache = new Map();

  const repos = resolveReviewRepos(sensorCfg.azure_pr_review_repos).filter((repo) => fs.existsSync(repo.projectDir));
  const eligibilityStart = new Date(process.env.SEAL_AZURE_START_DATE || sensorCfg.azure_pr_review_start || DEFAULT_START).getTime();
  const maxParallel = sensorCfg.azure_pr_review_max_parallel || 2;
  const state = readReviewState();
  const now = Date.now();

  await unblockLoginExpired().catch((err) => console.warn(`[seal:auth] sweep: ${err.message}`));
  await resumeStalePublishing()
    .then((resumed) => resumed.forEach((row) => console.warn(`[pr-review] Resuming interrupted publish ${row.repo} !${row.prId}@${row.headSha.slice(0, 8)}`)))
    .catch((err) => console.warn(`[pr-review] resume publishing: ${err.message}`));
  await releaseOrphanClaims({ maxRetries: MAX_RETRIES })
    .then((released) => released.forEach((orphan) => console.warn(`[pr-review] Released orphan claim ${orphan.repo} !${orphan.prId}@${orphan.headSha.slice(0, 8)} (task: ${orphan.taskStatus || 'missing'})`)))
    .catch((err) => console.warn(`[pr-review] orphan claims: ${err.message}`));
  await advanceChunkedReviews().catch((err) => console.warn(`[pr-review] parts: ${err.message}`));
  await publishCompletedReviews(repos, state).catch((err) => console.warn(`[pr-review] publish: ${err.message}`));
  await archiveMootTasks().catch((err) => console.warn(`[pr-review] archive: ${err.message}`));
  await cleanupWorktrees(repos).catch((err) => console.warn(`[pr-review] cleanup: ${err.message}`));
  await refreshPairStatuses(state).catch(() => {});

  const running = await db.all(`SELECT id FROM tasks WHERE summary LIKE ? AND status IN ('pending', 'running', 'firing')`, [`${SUMMARY_PREFIX}%`]);
  let slots = Math.max(0, maxParallel - running.length);
  const stats = { repos: repos.length, prs: 0, created: 0, skipped: {} };
  const digest = [];
  const listErrors = [];
  const sentMarks = readSentMarks();
  const seenActive = new Set();
  const candidates = [];

  for (const repo of repos) {
    let prs;
    try {
      prs = (await azRequest('GET', repoUrl(repo, '/pullRequests?searchCriteria.status=active&$top=100'))).value || [];
    } catch (err) {
      console.warn(`[pr-review] list failed for ${repo.name}: ${err.message}`);
      listErrors.push({ repo: repo.name, message: err.message });
      continue;
    }
    const unique = [...new Map(prs.map((pr) => [pr.pullRequestId, pr])).values()];
    stats.prs += unique.length;

    for (const pr of unique) {
      seenActive.add(String(pr.pullRequestId));
      insertEvent({
        source: 'azure',
        kind: 'azure.pr.active',
        data: {
          pr_id: pr.pullRequestId,
          title: pr.title,
          source_branch: branchOf(pr.sourceRefName),
          target_branch: branchOf(pr.targetRefName),
          author_name: pr.createdBy?.displayName || '',
          author_email: (pr.createdBy?.uniqueName || '').toLowerCase(),
          is_draft: Boolean(pr.isDraft),
          repo: repo.name,
          url: prWebUrl(repo.name, pr.pullRequestId),
        },
      }).catch(() => {});

      const cheapGate = decideReviewGate({ pr, threads: [], myEmail: MY_EMAIL, eligibilityStart, testPrs: TEST_PRS });
      if (cheapGate.action === 'skip' && ['own-pr', 'draft', 'before-start'].includes(cheapGate.reason)) {
        stats.skipped[cheapGate.reason] = (stats.skipped[cheapGate.reason] || 0) + 1;
        continue;
      }

      const { ok, threads } = await getThreads(repo, pr.pullRequestId);
      if (!ok) continue;
      if (await clearZombieLocks(repo, pr, threads).catch(() => false)) continue;

      collectFollowUps({ state, repo, pr, threads, now, digest, sentMarks });

      const inFlight = await db.get(`SELECT id FROM tasks WHERE id = ? AND status IN ('pending', 'running', 'firing')`, [`seal_pr_${pr.pullRequestId}`]);
      if (inFlight) continue;

      const headSha = (pr.lastMergeSourceCommit?.commitId || '').toLowerCase();
      const ledgerForHead = headSha ? await reviewForSha({ repo: repo.name, prId: pr.pullRequestId, headSha }) : null;
      await clearStaleFailureNotices(repo, pr, threads, ledgerForHead).catch((err) => console.warn(`[pr-review] stale notice cleanup on !${pr.pullRequestId}: ${err.message}`));
      await forwardAuthorReplies(repo, pr, threads, ledgerForHead).catch((err) => console.warn(`[pr-review] author replies on !${pr.pullRequestId}: ${err.message}`));
      if (await verifyResolvedThenApprove({ repo, pr, threads, ledgerForHead }).catch((err) => { console.warn(`[pr-review] verify resolved on !${pr.pullRequestId}: ${err.message}`); return false; })) continue;
      const gate = decideReviewGate({
        pr,
        threads,
        myEmail: MY_EMAIL,
        eligibilityStart,
        testPrs: TEST_PRS,
        ledgerForHead,
        lastPublishedSha: (await lastPublishedReview({ repo: repo.name, prId: pr.pullRequestId }))?.head_sha || null,
      });
      if (gate.action === 'skip') {
        stats.skipped[gate.reason] = (stats.skipped[gate.reason] || 0) + 1;
        continue;
      }
      candidates.push({ repo, pr, gate });
    }
  }

  candidates.sort((left, right) => new Date(left.pr.creationDate).getTime() - new Date(right.pr.creationDate).getTime());
  for (const { repo, pr, gate } of candidates) {
    const failureKey = `${repo.name}:${pr.pullRequestId}:${gate.headSha}`;
    if (backoffActive(failureKey, now)) {
      stats.skipped.backoff = (stats.skipped.backoff || 0) + 1;
      continue;
    }
    if (await preReviewBlock({ repo, pr, gate }).catch((err) => { console.warn(`[pr-review] pre-review block on !${pr.pullRequestId}: ${err.message}`); return false; })) {
      stats.skipped['pre-review-blocked'] = (stats.skipped['pre-review-blocked'] || 0) + 1;
      continue;
    }
    if (slots <= 0) {
      stats.skipped['no-slot'] = (stats.skipped['no-slot'] || 0) + 1;
      continue;
    }
    try {
      if (await enqueueReview({ repo, repos, pr, gate, sensorCfg })) {
        enqueueFailures.delete(failureKey);
        slots--;
        stats.created++;
        console.log(`[pr-review] Queued ${repo.name} !${pr.pullRequestId} (${gate.action}, created ${pr.creationDate})`);
      }
    } catch (err) {
      recordEnqueueFailure(failureKey, now, err.message);
      console.warn(`[pr-review] enqueue failed for ${repo.name} !${pr.pullRequestId}: ${err.message}`);
    }
  }

  for (const [prId, entry] of Object.entries(state.prs)) {
    if (entry.status === 'active' && !seenActive.has(prId) && repos.some((repo) => repo.name === entry.repo)) {
      const pr = prByIdCache.get(Number(prId)) || (await getPrById(Number(prId)));
      if (pr && pr.status === 'active') continue;
      Object.assign(entry, { status: pr?.status || 'closed', closedAt: new Date(now).toISOString(), needsAction: [] });
    }
  }

  const extraIssues = [];
  if (repos.length > 0 && listErrors.length === repos.length) {
    const auth = listErrors.some((failure) => /Azure API (401|403)/.test(failure.message));
    extraIssues.push({
      key: auth ? 'azure-auth' : 'azure-unavailable',
      text: auth
        ? 'o Azure recusou o PAT em todos os repos (401/403): o token venceu ou perdeu permissão'
        : `não consegui listar as PRs de nenhum repo: ${listErrors[0].message.slice(0, 120)}`,
    });
  }
  const loginExpired = await db.get(`SELECT COUNT(*) AS total FROM tasks WHERE id LIKE 'seal_pr_%' AND status = 'failed' AND result LIKE '%login expired%'`).catch(() => null);
  if (loginExpired?.total > 0) {
    extraIssues.push({ key: 'claude-login', text: `o login do Claude expirou e ${loginExpired.total} review(s) estão parados até você rodar claude /login` });
  }
  for (const [key, failure] of enqueueFailures) {
    if (failure.count >= 3) extraIssues.push({ key: `enqueue:${key}`, text: `falhei ${failure.count} vezes seguidas ao preparar ${key.split(':').slice(0, 2).join(' !')}: ${failure.message.slice(0, 120)}` });
  }
  await sendDigest(digest);
  await alertHealth(state, now, extraIssues).catch((err) => console.warn(`[pr-review] health: ${err.message}`));
  writeReviewState(state, now);
  await retryFailedReviews(repos).catch((err) => console.warn(`[pr-review] retry: ${err.message}`));
  // The digest (approvals, follow-ups to charge) lives in the panel; Telegram gets it only when turned on.
  const digestOut = sensorCfg.azure_pr_review_telegram_digest === true
    ? flushDigestIfDue({ send: sendTelegram })
    : db.run(`UPDATE telegram_digest SET flushed_at = ? WHERE flushed_at IS NULL`, [new Date().toISOString()]);
  await digestOut.catch((err) => console.warn(`[pr-review] digest: ${err.message}`));

  lastBacklog = stats.skipped['no-slot'] || 0;
  console.log(`[pr-review] Done. ${JSON.stringify(stats)}`);
  return stats;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSinglePrReview({ repoName, prId, sensorCfg = {}, timeoutMs = 45 * 60 * 1000, pollMs = 15_000 }) {
  if (!PAT) throw new Error('AZURE_DEVOPS_PAT not set');
  const missing = configureAzure(sensorCfg);
  if (missing.length > 0) throw new Error(`ingest.json sensors is missing ${missing.join(', ')}`);
  threadsCache = new Map();
  prByIdCache = new Map();
  const repos = resolveReviewRepos(sensorCfg.azure_pr_review_repos).filter((repo) => fs.existsSync(repo.projectDir));
  const repo = repos.find((candidate) => candidate.name === repoName);
  if (!repo) throw new Error(`repo ${repoName} is not configured or its projectDir is missing`);

  const pr = await azRequest('GET', repoUrl(repo, `/pullRequests/${prId}`));
  if (pr.status !== 'active') return { skipped: `pr-${pr.status}` };
  const { ok, threads } = await getThreads(repo, prId);
  if (!ok) throw new Error('could not read PR threads');
  const headSha = (pr.lastMergeSourceCommit?.commitId || '').toLowerCase();
  const gate = decideReviewGate({
    pr,
    threads,
    myEmail: MY_EMAIL,
    eligibilityStart: 0,
    testPrs: new Set([prId]),
    ledgerForHead: headSha ? await reviewForSha({ repo: repo.name, prId, headSha }) : null,
    lastPublishedSha: (await lastPublishedReview({ repo: repo.name, prId }))?.head_sha || null,
  });
  if (gate.action === 'skip') return { skipped: gate.reason };
  if (await preReviewBlock({ repo, pr, gate })) return { skipped: 'pre-review-blocked' };
  if (!(await enqueueReview({ repo, repos, pr, gate, sensorCfg }))) return { skipped: TEST_DRY ? 'dry-run' : 'already-claimed' };

  const taskId = `seal_pr_${prId}`;
  console.log(`[pr-review] ${repo.name} !${prId} queued as ${taskId} (${gate.action}); waiting for the SEAL executor…`);
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    task = await db.get(`SELECT status, result FROM tasks WHERE id = ?`, [taskId]);
    if (task && ['done', 'failed', 'archived'].includes(task.status)) break;
    await sleep(pollMs);
  }
  if (!task || !['done', 'failed', 'archived'].includes(task.status)) {
    return { waiting: true, note: 'o runner continua a revisão e publica sozinho quando terminar' };
  }
  if (task.status !== 'done') {
    await failReview({ repo: repo.name, prId, headSha: gate.headSha, error: task.result?.slice(0, 500) || `task ${task.status}` });
    return { failed: task.status, result: task.result?.slice(0, 500) };
  }
  const state = readReviewState();
  const published = await publishCompletedReviews(repos, state, { taskId });
  writeReviewState(state);
  await cleanupWorktrees([repo]).catch((err) => console.warn(`[pr-review] cleanup: ${err.message}`));
  return { published, verdict: state.prs[String(prId)]?.verdict, counts: state.prs[String(prId)]?.counts };
}

// Anything on this machine (the team panel's "verificar agora") asks for a scan by touching this file.
export const TICK_REQUEST_FILE = path.join(os.homedir(), '.config', 'seal', 'run', 'pr-review.tick-now');

function takeTickRequest() {
  try {
    fs.unlinkSync(TICK_REQUEST_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function shouldTickNow() {
  if (takeTickRequest()) return 'manual';
  const awaitingPublish = await db.get(
    `SELECT id FROM tasks WHERE summary LIKE ? AND detail LIKE ? AND status = 'done' AND result IS NOT NULL AND result NOT LIKE ? AND result NOT LIKE ?
       AND id NOT IN (SELECT task_id FROM pr_reviews WHERE status = 'publishing' AND task_id IS NOT NULL) LIMIT 1`,
    [`${SUMMARY_PREFIX}%`, `%${PIPELINE_TAG}%`, `%${PUBLISHED_MARKER}%`, `%${PUBLISH_FAILED_MARKER}%`],
  );
  if (awaitingPublish) return 'review-finished';
  const waitingParts = await db.get(
    `SELECT main.id FROM tasks main WHERE main.summary LIKE ? AND main.status = 'pending' AND main.execute_at = ?
       AND NOT EXISTS (SELECT 1 FROM tasks part WHERE part.id LIKE main.id || '_p%' AND part.status IN ('pending', 'running', 'firing'))
     LIMIT 1`,
    [`${SUMMARY_PREFIX}%`, WAITING_FOR_PARTS_AT],
  );
  if (waitingParts) return 'parts-finished';
  if (lastBacklog === 0) return null;
  const inFlight = await db.get(`SELECT id FROM tasks WHERE summary LIKE ? AND status IN ('pending', 'running', 'firing') LIMIT 1`, [`${SUMMARY_PREFIX}%`]);
  return inFlight ? null : 'backlog-free-slot';
}

let chatting = false;

async function ensureReviewWorktree(repo, row) {
  if (fs.existsSync(row.worktree)) return;
  fs.mkdirSync(path.dirname(row.worktree), { recursive: true });
  await fetchRefs(repo.projectDir, [], [row.head_sha]);
  await git(repo.projectDir, ['worktree', 'prune']).catch(() => {});
  await git(repo.projectDir, ['worktree', 'add', '--detach', row.worktree, row.head_sha], 120_000);
  const nodeModules = path.join(repo.projectDir, 'node_modules');
  if (fs.existsSync(nodeModules)) fs.symlinkSync(nodeModules, path.join(row.worktree, 'node_modules'));
  fs.writeFileSync(path.join(row.worktree, '.mcp.json'), JSON.stringify(reviewMcpConfig(), null, 2));
}

async function askReviewAgent(row, question) {
  const { stdout } = await execFileP(
    getClaudeBin(),
    [
      '-p', buildChatPrompt({ prId: row.pr_id, question }),
      '--resume', row.session_id,
      '--output-format', 'text',
      '--permission-mode', 'bypassPermissions',
      '--strict-mcp-config', '--mcp-config', path.join(row.worktree, '.mcp.json'),
      '--disallowedTools', DENIED_TOOLS.join(','),
    ],
    { cwd: row.worktree, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: process.env },
  );
  return stdout.trim();
}

async function resolveFromChat(repo, row, resolves, { approve = true, verified = false } = {}) {
  const prId = row.pr_id;
  threadsCache.delete(`${repo.id}:${prId}`);
  const { ok, threads } = await getThreads(repo, prId);
  if (!ok) return { resolved: [], missing: resolves.map((item) => item.title), approved: false };
  const byTitle = findingThreadIdsByTitle(threads, MY_EMAIL);
  const openIds = new Set(openBotFindings(threads, MY_EMAIL).map((item) => Number(item.threadId)));
  const resolved = [];
  const missing = [];
  for (const item of resolves) {
    const threadId = item.threadId ? (openIds.has(Number(item.threadId)) ? Number(item.threadId) : null) : byTitle.get(item.title);
    if (!threadId) {
      missing.push(item.title || `thread ${item.threadId}`);
      continue;
    }
    await azRequest('POST', repoUrl(repo, `/pullRequests/${prId}/threads/${threadId}/comments`), {
      parentCommentId: 1,
      content: verified
        ? `🤖 Conferi os commits depois deste comentário e a correção está no código: ${item.reason || 'corrigido.'}`
        : `🤖 Resolvido depois de uma conversa com o revisor: ${item.reason || 'o achado não se sustenta.'}`,
      commentType: 1,
    });
    await azRequest('PATCH', repoUrl(repo, `/pullRequests/${prId}/threads/${threadId}`), { status: verified ? 2 : 3 });
    resolved.push(item.title || `thread ${threadId}`);
  }
  threadsCache.delete(`${repo.id}:${prId}`);
  const after = await getThreads(repo, prId);
  const stillOpen = after.ok ? countOpenBotThreads(after.threads, MY_EMAIL) : 1;
  const approved = approve && resolved.length > 0 && stillOpen === 0;
  if (approved) {
    await azRequest('POST', repoUrl(repo, `/pullRequests/${prId}/threads`), {
      comments: [{ parentCommentId: 0, content: `**✅ Aprovado** — os pontos pendentes foram resolvidos na conversa com o revisor.\n\n${reviewedMarker(row.head_sha)}`, commentType: 1 }],
      status: 4,
    });
    await setMyVote(prId, VOTE_MAP.approved, repo);
  }
  return { resolved, missing, approved };
}

const AUTOMATIC_CHAT_SOURCES = new Set(['author-reply', 'verify-resolved']);

export async function processNextChatRequest(sensorCfg = {}) {
  if (chatting) return false;
  const requests = pendingChatRequests();
  if (requests.length === 0) return false;
  const resting = (await restState(Date.now(), { ignoreBattery: true })).resting;
  const request = resting ? requests.find((item) => !AUTOMATIC_CHAT_SOURCES.has(item.source)) : requests[0];
  if (!request) return false;
  chatting = true;
  try {
    const logged = (readChatLog()[String(request.prId)] || []).some((entry) => entry.requestId === request.id && entry.role === 'user');
    if (!logged) appendChatEntry(request.prId, { role: 'user', text: request.question, source: request.source, at: request.createdAt, requestId: request.id });
    const missing = configureAzure(sensorCfg);
    if (missing.length > 0) throw new Error(`ingest.json sensors is missing ${missing.join(', ')}`);
    const repos = resolveReviewRepos(sensorCfg.azure_pr_review_repos);
    const row = await lastConversableReview(request.prId);
    let answer;
    let outcome = { resolved: [], missing: [], approved: false };
    let workItems = [];
    if (!row) {
      answer = `Não tenho uma revisão com sessão guardada para a !${request.prId}. Só as revisões feitas depois desta função guardam a conversa; a próxima revisão desta PR já vai permitir.`;
    } else {
      const repo = repos.find((candidate) => candidate.name === row.repo);
      if (!repo) throw new Error(`repo ${row.repo} não está configurado`);
      const pr = await azRequest('GET', repoUrl(repo, `/pullRequests/${row.pr_id}`)).catch(() => null);
      if (pr && pr.status !== 'active') {
        const closed = pr.status === 'abandoned' ? 'abandonada' : pr.status === 'completed' ? 'concluída' : pr.status;
        appendChatEntry(request.prId, { role: 'agent', text: `A !${request.prId} está ${closed}: não há nada a fazer nela.`, actions: [], at: new Date().toISOString(), requestId: request.id });
        if (!AUTOMATIC_CHAT_SOURCES.has(request.source)) await sendTelegram(`🤖 <b>Revisor da !${request.prId}</b>\n\nA PR está ${escapeHtml(closed)}: não há nada a fazer nela.`);
        return true;
      }
      await ensureReviewWorktree(repo, row);
      const reply = parseChatReply(await askReviewAgent(row, request.question));
      answer = reply.answer || '(o revisor não respondeu nada)';
      if (reply.resolves.length > 0 && !TEST_DRY) outcome = await resolveFromChat(repo, row, reply.resolves, { approve: request.source !== 'verify-resolved', verified: request.source === 'verify-resolved' });
      workItems = reply.workItems;
      if (workItems.length > 0 && !TEST_DRY) await notifyOwnerWorkItems(request.prId, workItems);
      if (request.source === 'author-reply' && !TEST_DRY) {
        const { replied, missing: noReply } = reply.replies.length ? await replyInFindings(repo, row, reply.replies) : { replied: [], missing: [] };
        const { reopened, missing: noReopen } = reply.reopen.length
          ? await reopenFindings(repo, row, reply.reopen, { lead: '🤖 Reabri: o achado continua valendo no código atual. Falta:' })
          : { reopened: [], missing: [] };
        outcome = { ...outcome, replied, reopened, missing: [...outcome.missing, ...noReply, ...noReopen] };
      }
      if (request.source === 'verify-resolved' && !TEST_DRY) {
        const { reopened, missing: notFound } = reply.reopen.length ? await reopenFindings(repo, row, reply.reopen) : { reopened: [], missing: [] };
        outcome = { ...outcome, reopened, missing: [...outcome.missing, ...notFound] };
        threadsCache.delete(`${repo.id}:${row.pr_id}`);
        const after = await getThreads(repo, row.pr_id);
        const openAfter = after.ok ? countOpenBotThreads(after.threads, MY_EMAIL) : 1;
        if (reopened.length === 0 && notFound.length === 0 && openAfter === 0) {
          await approveHead({ repo, prId: row.pr_id, headSha: row.head_sha, sessionId: row.session_id, worktree: row.worktree, reason: 'conferi os commits depois de cada comentário resolvido e as correções estão no código.' });
          outcome = { ...outcome, approved: true };
        }
      }
      if (outcome.approved) {
        const state = readReviewState();
        const entry = state.prs[String(request.prId)];
        if (entry) {
          Object.assign(entry, { verdict: 'approved', needsAction: (entry.needsAction || []).filter((item) => item.reason !== 'blocker') });
          writeReviewState(state);
        }
      }
    }
    const actions = [
      ...outcome.resolved.map((title) => `resolvido: ${title}`),
      ...outcome.missing.map((title) => `não achei a thread de: ${title}`),
      ...(outcome.approved ? ['PR aprovada: não sobrou comentário aberto'] : []),
      ...workItems.map((item) => `ajustar #${item.id}: ${item.change}`),
      ...(outcome.reopened || []).map((title) => `reaberto, ainda falta: ${title}`),
      ...(outcome.replied || []).map((title) => `respondido no thread: ${title}`),
    ];
    appendChatEntry(request.prId, { role: 'agent', text: answer, actions, at: new Date().toISOString(), requestId: request.id });
    const heading = request.source === 'author-reply' ? `🤖 <b>Revisor da !${request.prId}</b> · reavaliou as respostas do autor` : `🤖 <b>Revisor da !${request.prId}</b>`;
    const lines = [heading, '', escapeHtml(answer.slice(0, 3500))];
    if (actions.length > 0) lines.push('', ...actions.map((action) => `• ${escapeHtml(action)}`));
    const informOnly = request.source === 'verify-resolved' && !(outcome.reopened || []).length;
    if (!informOnly && (request.source !== 'author-reply' || actions.length > 0)) await sendTelegram(lines.join('\n'));
  } catch (err) {
    console.warn(`[pr-review] chat !${request.prId} failed: ${err.message}`);
    appendChatEntry(request.prId, { role: 'agent', text: `Não consegui falar com o revisor: ${err.message.slice(0, 300)}`, actions: [], at: new Date().toISOString(), requestId: request.id, error: true });
    await sendTelegram(`⚠️ Não consegui falar com o revisor da !${request.prId}: ${escapeHtml(err.message.slice(0, 300))}`);
  } finally {
    completeChatRequest(request);
    chatting = false;
  }
  return true;
}

export const hasPendingChat = () => pendingChatRequests().length > 0;

export async function requeueReviewParts({ repoName, prId, parts: onlyParts, sensorCfg = {} }) {
  const missing = configureAzure(sensorCfg);
  if (missing.length > 0) throw new Error(`ingest.json sensors is missing ${missing.join(', ')}`);
  const repos = resolveReviewRepos(sensorCfg.azure_pr_review_repos);
  const repo = repos.find((candidate) => candidate.name === repoName);
  if (!repo) throw new Error(`repo ${repoName} is not configured`);
  const pr = await azRequest('GET', repoUrl(repo, `/pullRequests/${prId}`));
  const headSha = (pr.lastMergeSourceCommit?.commitId || '').toLowerCase();
  const row = await reviewForSha({ repo: repo.name, prId, headSha });
  if (!row) throw new Error(`no ledger row for !${prId}@${headSha.slice(0, 8)}; run a normal review instead`);
  if (!['failed', 'queued'].includes(row.status)) throw new Error(`ledger row is ${row.status}; nothing to recover`);
  await db.run(`UPDATE pr_reviews SET status = 'queued', error = NULL, finished_at = NULL WHERE id = ?`, [row.id]);
  const gate = { action: row.mode, headSha, previousSha: null };
  await prepareAndQueue({ repo, repos, pr, gate, sensorCfg, onlyParts });
  return { requeued: onlyParts, headSha };
}

// One-off for ledger rows written before the branches were recorded: source and target come from the PR as it
// is now; the origin only for PRs still open, since after the merge the branch's commits are in every mainline.
export async function backfillReviewBranches({ sensorCfg = {} } = {}) {
  const missing = configureAzure(sensorCfg);
  if (missing.length > 0) throw new Error(`ingest.json sensors is missing ${missing.join(', ')}`);
  const repos = resolveReviewRepos(sensorCfg.azure_pr_review_repos);
  const rows = await db.all(`SELECT DISTINCT repo, pr_id FROM pr_reviews WHERE source_branch IS NULL OR origin_branch IS NULL`);
  let filled = 0;
  for (const row of rows) {
    const repo = repos.find((candidate) => candidate.name === row.repo);
    if (!repo) continue;
    const pr = await azRequest('GET', repoUrl(repo, `/pullRequests/${row.pr_id}`)).catch(() => null);
    if (!pr) continue;
    const headSha = (pr.lastMergeSourceCommit?.commitId || '').toLowerCase();
    const origin = pr.status === 'active' && headSha ? await branchOrigin(repo, headSha).catch(() => null) : null;
    await db.run(
      `UPDATE pr_reviews SET source_branch = COALESCE(source_branch, ?), target_branch = COALESCE(target_branch, ?), origin_branch = COALESCE(origin_branch, ?)
       WHERE repo = ? AND pr_id = ? AND (source_branch IS NULL OR origin_branch IS NULL)`,
      [branchOf(pr.sourceRefName), branchOf(pr.targetRefName), origin, row.repo, row.pr_id],
    );
    filled++;
  }
  return { prs: rows.length, filled };
}

export async function blockPrOnTarget({ repoName, prId, sensorCfg = {} }) {
  const missing = configureAzure(sensorCfg);
  if (missing.length > 0) throw new Error(`ingest.json sensors is missing ${missing.join(', ')}`);
  const repo = resolveReviewRepos(sensorCfg.azure_pr_review_repos).find((candidate) => candidate.name === repoName);
  if (!repo) throw new Error(`repo ${repoName} is not configured`);
  const pr = await azRequest('GET', repoUrl(repo, `/pullRequests/${prId}`));
  const headSha = (pr.lastMergeSourceCommit?.commitId || '').toLowerCase();
  return { blocked: await preReviewBlock({ repo, pr, gate: { headSha } }), headSha };
}

export async function relabelReminderThreads({ repoName, prId, sensorCfg = {} }) {
  const missing = configureAzure(sensorCfg);
  if (missing.length > 0) throw new Error(`ingest.json sensors is missing ${missing.join(', ')}`);
  const repo = resolveReviewRepos(sensorCfg.azure_pr_review_repos).find((candidate) => candidate.name === repoName);
  if (!repo) throw new Error(`repo ${repoName} is not configured`);
  const mine = (comment) => (comment?.author?.uniqueName || '').toLowerCase() === MY_EMAIL;
  const { ok, threads } = await getThreads(repo, prId);
  if (!ok) throw new Error(`não consegui ler as threads de !${prId}`);

  const relabeled = [];
  for (const thread of threads) {
    const [first] = thread.comments || [];
    if (!first || first.isDeleted || thread.isDeleted || !mine(first)) continue;
    const content = relabelAsReminder(first.content);
    if (!content) continue;
    await writeToAzure(`relabel reminder on !${prId}`, () => azRequest('PATCH', repoUrl(repo, `/pullRequests/${prId}/threads/${thread.id}/comments/${first.id}`), { content }));
    await writeToAzure(`close reminder on !${prId}`, () => azRequest('PATCH', repoUrl(repo, `/pullRequests/${prId}/threads/${thread.id}`), { status: 4 }));
    relabeled.push(thread.id);
  }
  if (!relabeled.length) return { prId, relabeled, summaryUpdated: false };

  threadsCache.delete(`${repo.id}:${prId}`);
  const fresh = (await getThreads(repo, prId)).threads;
  const openFindings = fresh.filter((thread) => {
    const [first] = thread.comments || [];
    return first && !first.isDeleted && !thread.isDeleted && mine(first)
      && (thread.status === 'active' || thread.status === 1 || thread.status === 'pending' || thread.status === 6)
      && severityOfComment(first.content);
  });
  const counts = { blocker: 0, warning: 0, nit: 0 };
  for (const thread of openFindings) counts[severityOfComment(thread.comments[0].content).toLowerCase()] += 1;
  const reminders = fresh.filter((thread) => mine(thread.comments?.[0]) && (thread.comments[0].content || '').startsWith('**[LEMBRETE')).length;

  let summaryUpdated = false;
  const summary = fresh
    .filter((thread) => mine(thread.comments?.[0]) && /seal:reviewed\s+([0-9a-f]{7,40})/i.test(thread.comments[0].content || ''))
    .sort((a, b) => new Date(b.publishedDate || 0) - new Date(a.publishedDate || 0))[0];
  if (summary) {
    const first = summary.comments[0];
    const headSha = /seal:reviewed\s+([0-9a-f]{7,40})/i.exec(first.content)[1];
    const reason = /^\*\*⏸️ Aguardando autor\*\* — (.*)$/m.exec(first.content)?.[1];
    const findings = [
      ...openFindings.map(() => ({ blocking: true })),
      ...Array.from({ length: reminders }, () => ({ blocking: false })),
    ];
    const content = formatSummaryComment({ data: { findings, blockingReason: openFindings.length ? reason : '' }, headSha });
    await writeToAzure(`refresh summary on !${prId}`, () => azRequest('PATCH', repoUrl(repo, `/pullRequests/${prId}/threads/${summary.id}/comments/${first.id}`), { content }));
    summaryUpdated = true;
  }

  let approved = false;
  if (openFindings.length === 0) {
    await writeToAzure(`vote approved on !${prId}`, () => setMyVote(prId, VOTE_MAP.approved, repo));
    approved = true;
  }
  const state = readReviewState();
  const entry = Object.values(state.prs || {}).find((candidate) => candidate.prId === prId);
  if (entry) {
    entry.counts = counts;
    if (approved) {
      entry.verdict = 'approved';
      entry.needsAction = (entry.needsAction || []).filter((item) => item.reason !== 'blocker');
    }
    if (!TEST_DRY) writeReviewState(state);
  }
  return { prId, relabeled, summaryUpdated, counts, stillBlocking: openFindings.length, approved };
}

