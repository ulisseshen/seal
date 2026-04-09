/**
 * GitHub adapter for SEAL flow engine.
 *
 * Uses `gh` CLI directly — no need to spawn claude sessions.
 * Much faster than the Azure adapter since gh is native.
 */

import { BaseAdapter } from './base.js';
import { execSync } from 'child_process';

const VOTE_MAP = {
  'approve': '--approve',
  'wait_for_author': '--request-changes',
  'reject': '--request-changes',
  'reset': '--comment',
};

export class GitHubAdapter extends BaseAdapter {
  get name() { return 'github'; }

  async listOpenPRs(filter = {}) {
    const args = ['pr', 'list', '--json', 'number,url,title,author,headRefName,baseRefName,isDraft', '--state', 'open'];
    if (filter.not_draft) args.push('--draft=false');
    const result = this._gh(args);
    let prs = JSON.parse(result);

    if (filter.not_mine) {
      const me = this._gh(['api', 'user', '-q', '.login']).trim();
      prs = prs.filter(pr => pr.author.login !== me);
    }

    return prs.map(pr => ({
      id: pr.number,
      url: pr.url,
      title: pr.title,
      author: pr.author.login,
      sourceBranch: pr.headRefName,
      targetBranch: pr.baseRefName,
      isDraft: pr.isDraft,
    }));
  }

  async getPR(prId) {
    const result = this._gh(['pr', 'view', String(prId), '--json', 'number,url,title,author,headRefName,baseRefName,isDraft,commits,reviewRequests,reviews']);
    return JSON.parse(result);
  }

  async vote(prId, value) {
    const flag = VOTE_MAP[value] || '--comment';
    const body = value === 'reset' ? 'SEAL: Resetting review.' : '';
    const args = ['pr', 'review', String(prId), flag];
    if (body) args.push('--body', body);
    return this._gh(args);
  }

  async commentThreads(prId, findings) {
    const results = [];
    for (const f of findings) {
      const emoji = f.severity === 'BLOCKER' ? '🔴' : f.severity === 'WARNING' ? '🟡' : '🔵';
      const body = `${emoji} **${f.severity}**: ${f.message}\n\n\`${f.file}:${f.line}\``;
      this._gh(['pr', 'comment', String(prId), '--body', body]);
      results.push({ file: f.file, line: f.line, status: 'created' });
    }
    return results;
  }

  async comment(prId, message) {
    return this._gh(['pr', 'comment', String(prId), '--body', message]);
  }

  async resolveThreads(prId) {
    // GitHub doesn't have resolvable threads via CLI the same way Azure does.
    // We can edit/delete comments, but resolution is done in the UI.
    console.log(`[github-adapter] Thread resolution not supported via CLI. Use web UI.`);
    return 0;
  }

  async getLatestCommit(prId) {
    const result = this._gh(['pr', 'view', String(prId), '--json', 'commits', '-q', '.commits[-1].oid']);
    return result.trim();
  }

  async notify(prId, channel, message) {
    if (channel === 'pr-comment') {
      return this.comment(prId, message);
    }
    console.log(`[github-adapter] notify(${channel}): ${message}`);
  }

  // ─── Internal ────────────────────────────────────────
  _gh(args) {
    try {
      return execSync(['gh', ...args].join(' '), {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: this.config.cwd || process.cwd(),
      });
    } catch (err) {
      throw new Error(`gh ${args[0]} failed: ${err.stderr || err.message}`);
    }
  }
}
