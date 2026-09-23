import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { insertTaskIfNew, insertEvent, db, updateLastNotified } from '../db.js';
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
  buildThreadPayload,
  checkTargetBranch,
  countOpenBotThreads,
  verdictFor,
  countBySeverity,
  deriveVerdict,
  decideReviewGate,
  followUpReasons,
  formatFindingComment,
  formatSummaryComment,
  isMarkedSent,
  postedFindingTitles,
  matchPairedPrs,
  messageDraftFor,
  nextReleaseFrom,
  parseReviewResult,
  shouldNotify,
} from './pr-review-pipeline-logic.js';
import { resolveReviewRepos } from './pr-review-repos.js';
import { escapeHtml, readReviewState, readSentMarks, sendTelegram, upsertPrEntry, writeReviewState } from './pr-review-state.js';
import { beginPublish, claimReview, finishReview, healthIssues, lastPublishedReview, releaseClaim, releaseOrphanClaims, resumeStalePublishing, reviewForSha } from './pr-review-ledger.js';

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
const WORKTREE_ROOT = process.env.SEAL_PR_WORKTREE_ROOT || path.join(os.homedir(), '.seal-worktrees');
const PIPELINE_SKILL_PATH = path.resolve(HERE, '..', '..', 'skills', 'pr-review-pipeline', 'SKILL.md');
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

function buildPrompt() {
  return [
    `Read ${PIPELINE_SKILL_PATH} and follow it exactly.`,
    'The review context is in .seal-review/context.json (relative to the current directory).',
    'This is an unattended run: never ask the user anything, never post, vote, edit files, commit or push.',
    `Your final message MUST end with the result block delimited by ${RESULT_BLOCK_START} and ${RESULT_BLOCK_END}.`,
  ].join('\n');
}

async function enqueueReview(args) {
  const { repo, pr, gate } = args;
  const claim = { repo: repo.name, prId: pr.pullRequestId, headSha: gate.headSha };
  if (TEST_DRY) return prepareAndQueue(args);
  if (!(await claimReview({ ...claim, mode: gate.action, taskId: `seal_pr_${pr.pullRequestId}` }))) {
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

async function prepareAndQueue({ repo, repos, pr, gate, sensorCfg }) {
  const prId = pr.pullRequestId;
  const workItemIds = await getWorkItemIds(repo, prId);
  const workItems = await getWorkItemsWithStories(workItemIds);
  const { wtPath, mergeBase, targetBranch } = await createWorktree(repo, pr, gate.headSha);
  const pair = await findPairContext(repo, repos, pr, workItemIds);
  const targetGate = repo.targetGate === false ? null : checkTargetBranch({
    source: branchOf(pr.sourceRefName),
    target: targetBranch,
    nextRelease: nextReleaseFrom(await mainVersion(repo.projectDir)),
  });

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
    resultBlock: { start: RESULT_BLOCK_START, end: RESULT_BLOCK_END },
  };
  fs.writeFileSync(path.join(contextDir, 'context.json'), JSON.stringify(context, null, 2));

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
      testSkills: conventions.repoSkills.map((skill) => skill.name).filter((name) => /test|tdd/i.test(name)),
      prUrl: prWebUrl(repo.name, prId),
    }),
    execute_at: new Date().toISOString(),
    recurrence: null,
    next_run: null,
    prompt: buildPrompt(),
    project: wtPath,
    allowed_tools: '[]',
    disallowed_tools: JSON.stringify(DENIED_TOOLS),
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
    console.log(`[pr-review] [dry] WOULD CREATE task ${task.id} (${repo.name}, ${gate.action}, ${branchOf(pr.sourceRefName)} → ${targetBranch}, gate=${targetGate ? targetGate.severity : 'ok'}, pair=${pair.map((paired) => `${paired.repo}!${paired.prId}[${paired.reasons}]`).join(',') || '-'}, us=${workItemIds.join(',') || '-'})`);
    return false;
  }
  try {
    const saved = await upsertReviewTask(task);
    if (!saved) throw new Error(`task ${task.id} is still active`);
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
       status = 'pending', result = NULL, retry_count = 0, completed_at = NULL, last_notified_at = NULL
     WHERE id = ? AND status IN ('done', 'failed', 'archived', 'acknowledged')`,
    [task.summary, task.detail, task.execute_at, task.prompt, task.project, task.allowed_tools, task.disallowed_tools,
      task.model, task.permission_mode, task.notify_type, task.notify_channel, task.notify_target, task.people, task.priority, task.id],
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
  if (data.usCoverage) lines.push(`US: ${data.usCoverage.covered ?? 0}/${data.usCoverage.total ?? 0} cenários com teste`);
  if (waiting) {
    lines.push('', '✉️ <b>Mensagem sugerida para o autor:</b>', `<code>${escapeHtml(messageDraftFor('blocker', entry))}</code>`);
  }
  return lines.join('\n');
}

async function publishCompletedReviews(repos, state, { taskId = null } = {}) {
  const tasks = await db.all(
    `SELECT id, summary, detail, result, retry_count FROM tasks
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
    const parsed = parseReviewResult(task.result);

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
      await finishReview({ ...claim, status: 'failed', error: parsed.error });
      await sendTelegram(`⚠️ Review sem resultado utilizável · ${escapeHtml(repo.name)} !${prId} (${escapeHtml(parsed.error)})`);
      continue;
    }

    const { data } = parsed;
    data.findings = applyUsScenarioFinding(data.findings, data.usCoverage, { repo: repo.name, prUrl: meta.prUrl, testSkills: meta.testSkills || [] });
    if (meta.targetGate && !data.findings.some((finding) => (finding.sources || []).includes('target-gate'))) {
      data.findings.unshift(meta.targetGate);
    }
    data.verdict = deriveVerdict(data.findings);
    threadsCache.delete(`${repo.id}:${prId}`);
    const before = await getThreads(repo, prId);
    const priorOpen = before.ok ? countOpenBotThreads(before.threads, MY_EMAIL, { excludeThreadIds: [meta.lockThreadId].filter(Boolean) }) : 0;
    data.verdict = verdictFor(data.findings.length, priorOpen);
    let failures = 0;
    const alreadyPosted = before.ok ? postedFindingTitles(before.threads, MY_EMAIL) : new Set();
    for (const finding of data.findings) {
      if (alreadyPosted.has(finding.title)) continue;
      try {
        await writeToAzure(`post finding on !${prId}: ${finding.title}`, () => postFinding(repo, prId, finding));
      } catch (err) {
        failures++;
        console.warn(`[pr-review] finding post failed on !${prId}: ${err.message.slice(0, 200)}`);
      }
    }
    try {
      await writeToAzure(`post summary last on !${prId}`, () => postSummaryLast(repo, prId, meta, formatSummaryComment({ data, headSha: meta.headSha, priorOpen })));
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

    await sendTelegram(reviewTelegramText(entry, data, meta));
    await db.run(`UPDATE tasks SET result = result || ? WHERE id = ?`, [`\n\n${PUBLISHED_MARKER} ${data.verdict} findings=${data.findings.length} failures=${failures}`, task.id]);
    await finishReview({ ...claim, status: 'published', verdict: data.verdict, findings: data.findings.length });
    published++;
    console.log(`[pr-review] Published !${prId} (${repo.name}): ${data.verdict}, ${data.findings.length} finding(s)`);
  }
  return published;
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

async function retryFailedReviews(repos) {
  const recoverable = ['sigterm', 'exit code 143', 'exit code -2', 'orphaned', 'enoent', 'no such file', 'worktree missing'];
  const failed = await db.all(
    `SELECT id, summary, detail, result, project, retry_count, last_notified_at FROM tasks WHERE summary LIKE ? AND status = 'failed'`,
    [`${SUMMARY_PREFIX}%`],
  );
  for (const task of failed) {
    const result = task.result || '';
    if (isLoginExpiredResult(result)) continue;
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
    const meta = parseDetail(task.detail);
    const repo = meta && repos.find((candidate) => candidate.name === meta.repo);
    if (repo && (retryCount >= MAX_RETRIES || !isRecoverable)) {
      await writeToAzure(`mark lock failed on !${meta.prId}`, () => updateLock(repo, meta.prId, meta, '⚠️ A revisão automática falhou. Vou tentar de novo no próximo commit.')).catch(() => {});
      await finishReview({ repo: repo.name, prId: meta.prId, headSha: meta.headSha, status: 'failed', error: result.slice(0, 500) });
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
  'pair-desync': 'PR par já fechada no outro repo',
};

const HEALTH_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

async function alertHealth(state, now, extraIssues = []) {
  const issues = [...(await healthIssues()), ...extraIssues];
  const notified = state.health?.notified || {};
  const fresh = issues.filter((issue) => !notified[issue.key] || now - new Date(notified[issue.key]).getTime() >= HEALTH_ALERT_COOLDOWN_MS);
  state.health = {
    checkedAt: new Date(now).toISOString(),
    issues: issues.map((issue) => issue.text),
    notified: Object.fromEntries(Object.entries(notified).filter(([key]) => issues.some((issue) => issue.key === key))),
  };
  if (fresh.length === 0) return;
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
  await sendTelegram([`📣 <b>PRs que pedem uma cobrança</b> (${byPr.size})`, ...blocks].join('\n\n'));
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
      const gate = decideReviewGate({
        pr,
        threads,
        myEmail: MY_EMAIL,
        eligibilityStart,
        testPrs: TEST_PRS,
        ledgerForHead: headSha ? await reviewForSha({ repo: repo.name, prId: pr.pullRequestId, headSha }) : null,
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
  if (!task || task.status !== 'done') {
    await finishReview({ repo: repo.name, prId, headSha: gate.headSha, status: 'failed', error: `task ${task?.status || 'timeout'}` });
    return { failed: task?.status || 'timeout', result: task?.result?.slice(0, 500) };
  }
  const state = readReviewState();
  const published = await publishCompletedReviews(repos, state, { taskId });
  writeReviewState(state);
  await cleanupWorktrees([repo]).catch((err) => console.warn(`[pr-review] cleanup: ${err.message}`));
  return { published, verdict: state.prs[String(prId)]?.verdict, counts: state.prs[String(prId)]?.counts };
}

export async function shouldTickNow() {
  const awaitingPublish = await db.get(
    `SELECT id FROM tasks WHERE summary LIKE ? AND detail LIKE ? AND status = 'done' AND result IS NOT NULL AND result NOT LIKE ? AND result NOT LIKE ?
       AND id NOT IN (SELECT task_id FROM pr_reviews WHERE status = 'publishing' AND task_id IS NOT NULL) LIMIT 1`,
    [`${SUMMARY_PREFIX}%`, `%${PIPELINE_TAG}%`, `%${PUBLISHED_MARKER}%`, `%${PUBLISH_FAILED_MARKER}%`],
  );
  if (awaitingPublish) return 'review-finished';
  if (lastBacklog === 0) return null;
  const inFlight = await db.get(`SELECT id FROM tasks WHERE summary LIKE ? AND status IN ('pending', 'running', 'firing') LIMIT 1`, [`${SUMMARY_PREFIX}%`]);
  return inFlight ? null : 'backlog-free-slot';
}
