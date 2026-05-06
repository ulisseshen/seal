/**
 * SEAL Brain — repo onboarding analyzer (v0.11.0 "SEAL learns your repo")
 *
 * When SEAL first encounters a repo (or the user runs `seal onboard`), this
 * module deep-scans the git history and uses the configured LLM to produce
 * a structured repo profile:
 *
 *   - Working hours distribution (when does the team actually commit?)
 *   - Commit message conventions (conventional commits? ticket refs?)
 *   - Branch naming strategy (feature/, fix/, release/?)
 *   - Release cadence (tags, versioning scheme, frequency)
 *   - Team structure (who contributes what, active vs occasional)
 *   - Code velocity (commits/week, PR merge frequency)
 *   - Recommendations for how SEAL should behave for this repo
 *
 * The analysis is stored in repo_profiles and used by the detector/proposer
 * to calibrate their behavior per repo instead of using global defaults.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

import { upsertRepoProfile, getRepoProfile } from '../db.js';
import { getProvider } from '../providers/index.js';
import { getBreaker } from '../circuit-breaker.js';

const SEAL_DIR = process.env.SEAL_DIR || join(process.env.HOME, '.config', 'seal');
const CHAT_CONFIG = join(SEAL_DIR, 'chat-config.json');

// ─── Public API ──────────────────────────────────────

/**
 * Run a full onboarding analysis for a repo.
 * @param {string} repoPath - absolute path to the git repo
 * @param {object} [opts]
 * @param {boolean} [opts.force] - re-analyze even if a profile exists
 * @param {boolean} [opts.skipLlm] - only gather stats, skip LLM synthesis
 * @param {function} [opts.onProgress] - callback for progress updates
 * @returns {object} the repo profile
 */
export async function onboardRepo(repoPath, opts = {}) {
  const { force = false, skipLlm = false, onProgress } = opts;
  const log = onProgress || (() => {});

  // Check if already profiled (unless forced)
  if (!force) {
    const existing = await getRepoProfile(repoPath);
    if (existing) {
      log('profile_exists', { analyzed_at: existing.analyzed_at, version: existing.version });
      return existing;
    }
  }

  log('scanning', { repoPath });

  // ─── Step 1: Gather raw git statistics ─────────
  const stats = gatherGitStats(repoPath);
  if (!stats) {
    throw new Error(`Not a git repository or no commits: ${repoPath}`);
  }

  log('stats_done', {
    commits: stats.totalCommits,
    contributors: stats.contributors.length,
    branches: stats.activeBranches,
  });

  // ─── Step 2: LLM synthesis ─────────────────────
  let llmAnalysis = {};
  let provider = null;
  let model = null;

  if (!skipLlm) {
    log('llm_start', {});
    const cfg = readChatConfig();
    provider = cfg.provider || 'claude';
    model = cfg.model || undefined;

    const providerInstance = getProvider(provider, { model });
    if (!providerInstance.available()) {
      log('llm_unavailable', { provider });
      // Fall back to stats-only profile
    } else {
      // Circuit-breaker gate (v0.4.0): skip the LLM call if the provider
      // CLI has been failing in a loop. Onboarding still produces a stats
      // profile, just without the synthesized analysis.
      const breaker = getBreaker(provider, { threshold: 3, cooldownMs: 30 * 60 * 1000 });
      if (!breaker.canExecute()) {
        console.log(`[brain] ${provider} circuit open, skipping LLM synthesis for ${repoPath}`);
        log('llm_unavailable', { provider, reason: 'circuit-open' });
      } else {
        try {
          llmAnalysis = await synthesizeWithLlm(providerInstance, stats, repoPath);
          breaker.recordSuccess();
          log('llm_done', {});
        } catch (err) {
          breaker.recordFailure();
          console.warn(`[brain] LLM synthesis failed for ${repoPath}:`, err.message);
          log('llm_unavailable', { provider, reason: 'error', error: err.message });
        }
      }
    }
  }

  // ─── Step 3: Persist ───────────────────────────
  const repoName = stats.repoName || basename(repoPath);
  await upsertRepoProfile({
    repoPath,
    repoName,
    commitCount: stats.totalCommits,
    contributorCount: stats.contributors.length,
    activeBranches: stats.activeBranches,
    stats,
    llmAnalysis,
    provider,
    model,
  });

  const profile = await getRepoProfile(repoPath);
  log('done', { version: profile.version });
  return profile;
}

// ─── Git statistics gathering ────────────────────────

function gatherGitStats(repoPath) {
  if (!existsSync(join(repoPath, '.git'))) return null;

  const git = (cmd) => {
    try {
      return execSync(`git -C "${repoPath}" ${cmd}`, {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
    } catch {
      return '';
    }
  };

  // Repo name from remote or directory
  const remote = git('remote get-url origin 2>/dev/null');
  const repoName = remote
    ? basename(remote.replace(/\.git$/, ''))
    : basename(repoPath);

  // ─── Commit log (last 500 commits for speed) ───
  // Format: SHA|author_name|author_email|date_iso|hour|weekday|subject
  const logRaw = git(
    `log --all --max-count=500 --pretty=format:"%H|%an|%ae|%aI|%aH|%ad|%s" --date=format:"%u"`,
  );
  if (!logRaw) return null;

  const commits = [];
  for (const line of logRaw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 7) continue;
    const [sha, authorName, authorEmail, dateIso, hour, weekday, ...msgParts] = parts;
    commits.push({
      sha,
      authorName,
      authorEmail,
      dateIso,
      hour: parseInt(hour, 10),
      weekday: parseInt(weekday, 10), // 1=Monday ... 7=Sunday
      message: msgParts.join('|'),
    });
  }

  if (commits.length === 0) return null;
  const totalCommits = parseInt(git('rev-list --all --count') || '0', 10);

  // ─── Working hours distribution ────────────────
  const hourBuckets = new Array(24).fill(0);
  const dayBuckets = new Array(7).fill(0); // 0=Mon ... 6=Sun
  for (const c of commits) {
    if (c.hour >= 0 && c.hour < 24) hourBuckets[c.hour]++;
    if (c.weekday >= 1 && c.weekday <= 7) dayBuckets[c.weekday - 1]++;
  }

  const peakHours = hourBuckets
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((h) => h.hour);

  const peakDays = dayBuckets
    .map((count, day) => ({ day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day], count }))
    .sort((a, b) => b.count - a.count);

  const weekendRatio =
    (dayBuckets[5] + dayBuckets[6]) / Math.max(commits.length, 1);

  // ─── Contributors ──────────────────────────────
  const contributorMap = new Map();
  for (const c of commits) {
    const key = c.authorEmail;
    if (!contributorMap.has(key)) {
      contributorMap.set(key, {
        name: c.authorName,
        email: c.authorEmail,
        count: 0,
        firstSeen: c.dateIso,
        lastSeen: c.dateIso,
        types: {},
      });
    }
    const entry = contributorMap.get(key);
    entry.count++;
    entry.lastSeen = c.dateIso; // log is oldest-last in our scan
    // Track commit type distribution
    const typeMatch = c.message.match(/^(\w+)(?:\(.*?\))?:/);
    if (typeMatch) {
      const type = typeMatch[1].toLowerCase();
      entry.types[type] = (entry.types[type] || 0) + 1;
    }
  }
  const contributors = [...contributorMap.values()]
    .sort((a, b) => b.count - a.count);

  // ─── Commit message conventions ────────────────
  const conventions = analyzeCommitConventions(commits);

  // ─── Branch strategy ───────────────────────────
  const branchRaw = git('branch -a --no-merged 2>/dev/null') +
    '\n' + git('branch --merged 2>/dev/null');
  const allBranches = branchRaw
    .split('\n')
    .map((b) => b.replace(/^\*?\s+/, '').replace(/^remotes\/origin\//, '').trim())
    .filter((b) => b && !b.includes('->') && !b.includes('HEAD'));
  const uniqueBranches = [...new Set(allBranches)];
  const activeBranches = uniqueBranches.length;

  const branchPrefixes = {};
  for (const b of uniqueBranches) {
    const prefix = b.split('/')[0];
    branchPrefixes[prefix] = (branchPrefixes[prefix] || 0) + 1;
  }

  // ─── Tags / release cadence ────────────────────
  const tagRaw = git(
    'for-each-ref --sort=-creatordate --format="%(refname:short)|%(creatordate:iso8601)" refs/tags --count=50',
  );
  const tags = tagRaw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [name, date] = l.split('|');
      return { name, date };
    });

  const tagPattern = detectTagPattern(tags.map((t) => t.name));
  const releaseCadence = computeReleaseCadence(tags);

  // ─── Velocity ──────────────────────────────────
  const velocity = computeVelocity(commits);

  // ─── First and last commit dates ───────────────
  const firstCommitDate = git('log --all --reverse --format="%aI" --max-count=1');
  const lastCommitDate = commits.length > 0 ? commits[0].dateIso : null;

  return {
    repoName,
    totalCommits,
    sampleSize: commits.length,
    firstCommitDate,
    lastCommitDate,
    activeBranches,
    workingHours: {
      hourBuckets,
      dayBuckets,
      peakHours,
      peakDays,
      weekendRatio,
    },
    contributors,
    conventions,
    branches: {
      count: activeBranches,
      prefixes: branchPrefixes,
      examples: uniqueBranches.slice(0, 20),
    },
    tags: {
      count: tags.length,
      pattern: tagPattern,
      releaseCadence,
      recent: tags.slice(0, 10),
    },
    velocity,
  };
}

// ─── Convention analysis ─────────────────────────────

function analyzeCommitConventions(commits) {
  const messages = commits.map((c) => c.message);
  const total = messages.length;

  // Conventional commits
  const conventionalRegex = /^(feat|fix|chore|refactor|docs|test|style|perf|ci|build|revert)(\(.+?\))?!?:\s/i;
  const conventional = messages.filter((m) => conventionalRegex.test(m));
  const conventionalRatio = conventional.length / Math.max(total, 1);

  // Scoped conventional commits
  const scopedRegex = /^(feat|fix|chore|refactor|docs|test|style|perf|ci|build|revert)\(.+?\):\s/i;
  const scoped = messages.filter((m) => scopedRegex.test(m));

  // Ticket references
  const ticketRegex = /[A-Z]{2,}-\d+/;
  const tickets = messages.filter((m) => ticketRegex.test(m));
  const ticketRatio = tickets.length / Math.max(total, 1);

  // GitHub issue references
  const issueRegex = /#\d+/;
  const issues = messages.filter((m) => issueRegex.test(m));

  // Type distribution
  const types = {};
  for (const m of messages) {
    const match = m.match(/^(\w+)(?:\(.*?\))?:/);
    if (match) {
      const type = match[1].toLowerCase();
      types[type] = (types[type] || 0) + 1;
    }
  }

  // Merge commits
  const merges = messages.filter((m) => /^Merge (branch|pull request|remote-tracking)/i.test(m));

  return {
    conventionalCommits: {
      ratio: conventionalRatio,
      count: conventional.length,
      usesScopes: scoped.length > conventional.length * 0.3,
      typeDistribution: types,
    },
    ticketReferences: {
      ratio: ticketRatio,
      count: tickets.length,
      examples: [...new Set(tickets.map((m) => m.match(ticketRegex)?.[0]).filter(Boolean))].slice(0, 5),
    },
    issueReferences: {
      count: issues.length,
    },
    mergeCommits: {
      count: merges.length,
      ratio: merges.length / Math.max(total, 1),
    },
    sampleSize: total,
  };
}

function detectTagPattern(tagNames) {
  if (tagNames.length === 0) return { pattern: 'none', examples: [] };

  const patterns = [
    { label: 'semver (vX.Y.Z)', regex: /^v\d+\.\d+\.\d+$/ },
    { label: 'semver-pre (vX.Y.Z-alpha)', regex: /^v\d+\.\d+\.\d+-[a-z0-9.]+$/i },
    { label: 'calver (release-YYYY-MM-DD)', regex: /^release-\d{4}-\d{2}-\d{2}$/ },
    { label: 'prefixed (uX.Y)', regex: /^[a-z]\d+\.\d+$/i },
    { label: 'bare semver (X.Y.Z)', regex: /^\d+\.\d+\.\d+$/ },
  ];

  for (const p of patterns) {
    const matches = tagNames.filter((t) => p.regex.test(t));
    if (matches.length >= tagNames.length * 0.5) {
      return { pattern: p.label, regex: p.regex.source, ratio: matches.length / tagNames.length, examples: matches.slice(0, 5) };
    }
  }

  return { pattern: 'mixed', examples: tagNames.slice(0, 5) };
}

function computeReleaseCadence(tags) {
  if (tags.length < 2) return { frequency: 'unknown', avgDaysBetween: null };

  const dates = tags
    .map((t) => t.date ? Date.parse(t.date) : NaN)
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => b - a); // newest first

  if (dates.length < 2) return { frequency: 'unknown', avgDaysBetween: null };

  const gaps = [];
  for (let i = 0; i < dates.length - 1; i++) {
    gaps.push((dates[i] - dates[i + 1]) / (1000 * 60 * 60 * 24));
  }

  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  let frequency;
  if (avg <= 2) frequency = 'daily';
  else if (avg <= 8) frequency = 'weekly';
  else if (avg <= 16) frequency = 'biweekly';
  else if (avg <= 35) frequency = 'monthly';
  else if (avg <= 100) frequency = 'quarterly';
  else frequency = 'infrequent';

  return { frequency, avgDaysBetween: Math.round(avg) };
}

function computeVelocity(commits) {
  if (commits.length < 2) return { commitsPerWeek: 0, trend: 'unknown' };

  const dates = commits
    .map((c) => Date.parse(c.dateIso))
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => a - b);

  const spanDays = (dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24);
  if (spanDays < 1) return { commitsPerWeek: commits.length, trend: 'unknown' };

  const commitsPerWeek = Math.round((commits.length / spanDays) * 7 * 10) / 10;

  // Trend: compare first half vs second half of the sample
  const mid = Math.floor(commits.length / 2);
  const firstHalfDays = (dates[mid] - dates[0]) / (1000 * 60 * 60 * 24) || 1;
  const secondHalfDays = (dates[dates.length - 1] - dates[mid]) / (1000 * 60 * 60 * 24) || 1;
  const firstRate = mid / firstHalfDays;
  const secondRate = (commits.length - mid) / secondHalfDays;
  const ratio = secondRate / Math.max(firstRate, 0.001);

  let trend;
  if (ratio > 1.3) trend = 'accelerating';
  else if (ratio < 0.7) trend = 'decelerating';
  else trend = 'stable';

  return { commitsPerWeek, trend };
}

// ─── LLM synthesis ───────────────────────────────────

async function synthesizeWithLlm(provider, stats, repoPath) {
  const systemPrompt = ONBOARD_SYSTEM_PROMPT;
  const userPrompt = buildOnboardPrompt(stats, repoPath);

  let raw = '';
  for await (const chunk of provider.stream(
    [{ role: 'user', content: userPrompt }],
    systemPrompt,
  )) {
    raw += chunk;
  }

  return extractJson(raw) || { raw, error: 'failed to parse LLM output' };
}

function buildOnboardPrompt(stats, repoPath) {
  const wh = stats.workingHours;
  const conv = stats.conventions;

  const sections = [
    '# REPO ONBOARDING ANALYSIS',
    '',
    `Repository: ${stats.repoName} (${repoPath})`,
    `Total commits: ${stats.totalCommits} (sampled: ${stats.sampleSize})`,
    `Active branches: ${stats.activeBranches}`,
    `Contributors: ${stats.contributors.length}`,
    `First commit: ${stats.firstCommitDate}`,
    `Last commit: ${stats.lastCommitDate}`,
    '',
    '## Working Hours',
    `Peak hours (UTC/local): ${wh.peakHours.join(', ')}h`,
    `Weekend commit ratio: ${(wh.weekendRatio * 100).toFixed(1)}%`,
    `Day distribution: ${wh.peakDays.map(d => `${d.day}=${d.count}`).join(', ')}`,
    '',
    '## Commit Conventions',
    `Conventional commits: ${(conv.conventionalCommits.ratio * 100).toFixed(1)}% (${conv.conventionalCommits.count}/${conv.sampleSize})`,
    `Uses scopes: ${conv.conventionalCommits.usesScopes ? 'yes' : 'no'}`,
    `Type distribution: ${JSON.stringify(conv.conventionalCommits.typeDistribution)}`,
    `Ticket references: ${(conv.ticketReferences.ratio * 100).toFixed(1)}%${conv.ticketReferences.examples.length ? ' (e.g. ' + conv.ticketReferences.examples.join(', ') + ')' : ''}`,
    `Merge commits: ${(conv.mergeCommits.ratio * 100).toFixed(1)}%`,
    '',
    '## Branch Strategy',
    `Total branches: ${stats.branches.count}`,
    `Prefix distribution: ${JSON.stringify(stats.branches.prefixes)}`,
    `Examples: ${stats.branches.examples.slice(0, 10).join(', ')}`,
    '',
    '## Release / Tags',
    `Tags found: ${stats.tags.count}`,
    `Version pattern: ${stats.tags.pattern.pattern}`,
    `Release cadence: ${stats.tags.releaseCadence.frequency}${stats.tags.releaseCadence.avgDaysBetween ? ` (~${stats.tags.releaseCadence.avgDaysBetween} days)` : ''}`,
    `Recent tags: ${stats.tags.recent.map(t => t.name).join(', ')}`,
    '',
    '## Team',
    ...stats.contributors.slice(0, 10).map((c, i) =>
      `${i + 1}. ${c.name} <${c.email}> — ${c.count} commits${Object.keys(c.types).length ? ' (' + Object.entries(c.types).sort((a,b) => b[1]-a[1]).slice(0,3).map(([t,n]) => `${t}:${n}`).join(', ') + ')' : ''}`
    ),
    '',
    '## Velocity',
    `Commits/week: ${stats.velocity.commitsPerWeek}`,
    `Trend: ${stats.velocity.trend}`,
    '',
    '---',
    '',
    'TASK: Analyze this repository and produce a JSON response with:',
    '',
    '1. **summary**: 2-3 sentence description of this repo (what it is, maturity, team size)',
    '2. **working_hours**: { start_hour, end_hour, timezone_guess, works_weekends }',
    '3. **commit_style**: { convention, should_enforce, scope_pattern, ticket_pattern }',
    '4. **branch_strategy**: { model (gitflow/trunk/github-flow/custom), main_branch, convention }',
    '5. **release_strategy**: { versioning, cadence, tag_format }',
    '6. **team_assessment**: { size_category (solo/small/medium/large), key_contributors, specializations }',
    '7. **seal_recommendations**: Array of specific recommendations for how SEAL should behave:',
    '   - When to send notifications (respect working hours)',
    '   - What patterns to watch for',
    '   - What automations would help this specific team',
    '   - Commit convention enforcement suggestions',
    '   - Branch naming enforcement suggestions',
    '   - Risk areas to monitor',
    '',
    'OUTPUT: Respond with ONLY a JSON object, no prose before or after.',
  ];

  return sections.join('\n');
}

const ONBOARD_SYSTEM_PROMPT = [
  'You are SEAL\'s Repo Onboarding Analyst.',
  'You analyze git repository statistics and produce structured profiles that help SEAL',
  '(an autonomous tech lead assistant) calibrate its behavior for each specific repo.',
  'Your analysis must be practical and actionable — not generic advice.',
  'Base every recommendation on the actual data provided.',
  'If the data is insufficient for a conclusion, say so explicitly rather than guessing.',
  'Respect the team\'s working hours: never recommend notifications outside their active hours.',
  'Respond with a single JSON object, nothing else.',
].join(' ');

// ─── Helpers ─────────────────────────────────────────

function readChatConfig() {
  if (!existsSync(CHAT_CONFIG)) return { provider: 'claude' };
  try { return JSON.parse(readFileSync(CHAT_CONFIG, 'utf-8')); }
  catch { return { provider: 'claude' }; }
}

function extractJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw.trim()); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    try { return JSON.parse(raw.slice(braceStart, braceEnd + 1)); } catch {}
  }
  return null;
}
