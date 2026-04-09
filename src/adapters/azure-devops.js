/**
 * Azure DevOps adapter for SEAL flow engine.
 *
 * Uses claude -p with MCP tools to interact with Azure DevOps.
 * This adapter is designed to be called by the flow engine,
 * which spawns claude sessions for each action.
 */

import { BaseAdapter } from './base.js';
import { spawn } from 'child_process';

const REPO_ID = 'f25aac20-9d94-441e-8f13-e09b0d56554d';
const PROJECT_ID = '8b5ed5d7-78ce-4bf7-977b-2633e0b22ea4';

// Vote values mapped to Azure DevOps API values
const VOTE_MAP = {
  'approve': 10,
  'approve_with_suggestions': 5,
  'wait_for_author': -5,
  'reject': -10,
  'reset': 0,
};

export class AzureDevOpsAdapter extends BaseAdapter {
  get name() { return 'azure-devops'; }

  async listOpenPRs(filter = {}) {
    const prompt = `
      Use mcp__azure-devops__repo_list_pull_requests_by_repo_or_project with:
      - repositoryId: "${REPO_ID}"
      - status: "Active"
      ${filter.not_mine ? '- created_by_me: false' : ''}

      Return ONLY a JSON array with objects: {id, url, title, author, sourceBranch, targetBranch, isDraft}
      No explanation, just JSON.
    `;
    return this._runClaude(prompt);
  }

  async getPR(prId) {
    const prompt = `
      Use mcp__azure-devops__repo_get_pull_request_by_id with:
      - repositoryId: "${REPO_ID}"
      - pullRequestId: ${prId}
      - includeWorkItemRefs: true
      Return the full JSON response. No explanation.
    `;
    return this._runClaude(prompt);
  }

  async vote(prId, value) {
    const voteValue = VOTE_MAP[value] ?? 0;
    const prompt = `
      Use mcp__azure-devops__repo_vote_pull_request with:
      - repositoryId: "${REPO_ID}"
      - pullRequestId: ${prId}
      - vote: ${voteValue}
      Confirm with the vote result. Return JSON.
    `;
    return this._runClaude(prompt);
  }

  async commentThreads(prId, findings) {
    const findingsJson = JSON.stringify(findings);
    const prompt = `
      For each finding in this array, create a PR thread comment using
      mcp__azure-devops__repo_create_pull_request_thread:
      - repositoryId: "${REPO_ID}"
      - pullRequestId: ${prId}

      Findings: ${findingsJson}

      For each finding, set:
      - content: severity emoji + message
      - filePath: the file from the finding
      - lineNumber: the line from the finding
      - status: "Active"

      Return summary of created threads as JSON array.
    `;
    return this._runClaude(prompt);
  }

  async comment(prId, message) {
    const prompt = `
      Use mcp__azure-devops__repo_create_pull_request_thread with:
      - repositoryId: "${REPO_ID}"
      - pullRequestId: ${prId}
      - content: "${message.replace(/"/g, '\\"')}"
      - status: "Closed"
      Return the thread ID.
    `;
    return this._runClaude(prompt);
  }

  async resolveThreads(prId) {
    const prompt = `
      Use mcp__azure-devops__repo_list_pull_request_threads with:
      - repositoryId: "${REPO_ID}"
      - pullRequestId: ${prId}
      - status: "Active"

      For each active thread that was authored by me (SEAL/Ulisses),
      update it to status "Fixed" using mcp__azure-devops__repo_update_pull_request_thread.

      Return count of resolved threads.
    `;
    return this._runClaude(prompt);
  }

  async getLatestCommit(prId) {
    const prompt = `
      Use mcp__azure-devops__repo_get_pull_request_by_id with:
      - repositoryId: "${REPO_ID}"
      - pullRequestId: ${prId}

      Return ONLY the lastMergeSourceCommit.commitId as a plain string. Nothing else.
    `;
    return this._runClaude(prompt);
  }

  async notify(prId, channel, message) {
    // Default: comment on PR itself
    if (channel === 'pr-comment') {
      return this.comment(prId, message);
    }
    // Future: telegram, teams, etc.
    console.log(`[azure-adapter] notify(${channel}): ${message}`);
  }

  // ─── Internal ────────────────────────────────────────
  async _runClaude(prompt) {
    return new Promise((resolve, reject) => {
      const args = [
        '-p', prompt.trim(),
        '--output-format', 'json',
        '--permission-mode', 'auto',
      ];

      const child = spawn('claude', args, {
        cwd: process.env.SEAL_PROJECT_DIR || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`claude exited ${code}: ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(stdout.trim());
        }
      });
    });
  }
}
