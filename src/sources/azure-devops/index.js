/**
 * Azure DevOps Source Plugin — syncs work items, sprints, and board data
 * from Azure DevOps REST API into the SEAL Knowledge Engine.
 *
 * Expects config:
 *   { org: 'myorg', project: 'myproject', pat?: 'xxx', team?: 'myteam', syncInterval?: 3600000 }
 *
 * PAT is read from config.pat or env AZURE_DEVOPS_PAT.
 *
 * This is a *source plugin* (reads board/planning data for knowledge),
 * NOT the adapter at src/adapters/azure-devops.js (which does PR operations).
 */

import { BaseSourcePlugin } from '../base.js';
import { transformWorkItem, transformSprint } from './transformer.js';

const ADO_API_VERSION = '7.1';
const BATCH_SIZE = 200; // Azure DevOps work items batch limit
const DEFAULT_LOOKBACK_DAYS = 30;

export class AzureDevOpsSourcePlugin extends BaseSourcePlugin {
  constructor() {
    super('azure-devops', 'Azure DevOps work items, sprints, and board data');
    this.artifactTypes = ['work-item', 'sprint'];
    this.org = null;
    this.project = null;
    this.team = null;
    this.pat = null;
    this.engine = null;
    this.baseUrl = null;
  }

  async init(config, engine) {
    if (!config.org) throw new Error('azure-devops plugin requires config.org');
    if (!config.project) throw new Error('azure-devops plugin requires config.project');

    this.org = config.org;
    this.project = config.project;
    this.team = config.team || this.project;
    this.pat = config.pat || process.env.AZURE_DEVOPS_PAT;
    this.engine = engine;
    this.baseUrl = `https://dev.azure.com/${this.org}/${this.project}`;

    if (!this.pat) {
      throw new Error('azure-devops plugin requires PAT (config.pat or AZURE_DEVOPS_PAT env)');
    }

    console.log(`[seal:sources:azure-devops] Initialized — org=${this.org} project=${this.project}`);
  }

  async sync(since) {
    const items = [];

    // 1. Sync work items
    try {
      const workItems = await this._fetchWorkItems(since);
      console.log(`[seal:sources:azure-devops] Fetched ${workItems.length} work items`);
      for (const wi of workItems) {
        items.push(transformWorkItem(wi, this.org, this.project));
      }
    } catch (err) {
      console.error(`[seal:sources:azure-devops] Work items fetch failed: ${err.message}`);
    }

    // 2. Sync sprints/iterations
    try {
      const iterations = await this._fetchIterations();
      console.log(`[seal:sources:azure-devops] Fetched ${iterations.length} iterations`);
      for (const iter of iterations) {
        items.push(transformSprint(iter, this.org, this.project));
      }
    } catch (err) {
      console.error(`[seal:sources:azure-devops] Iterations fetch failed: ${err.message}`);
    }

    console.log(`[seal:sources:azure-devops] Sync complete: ${items.length} total items`);
    return items;
  }

  async healthy() {
    try {
      // Simple API call to verify credentials and project access
      const url = `${this.baseUrl}/_apis/projects?api-version=${ADO_API_VERSION}`;
      await adoFetch(url, this.pat);
      return { ok: true, detail: `Connected to ${this.org}/${this.project}` };
    } catch (err) {
      return { ok: false, detail: `Health check failed: ${err.message}` };
    }
  }

  // ─── Internal: Work Items ───────────────────────────────

  /**
   * Fetch work items changed since a given date (or last N days).
   * Uses WIQL to query IDs, then batch-fetches details.
   */
  async _fetchWorkItems(since) {
    const sinceDate = since
      ? new Date(since).toISOString().split('T')[0]
      : this._daysAgo(DEFAULT_LOOKBACK_DAYS);

    // Step 1: WIQL query to get work item IDs
    const wiqlUrl = `${this.baseUrl}/_apis/wit/wiql?api-version=${ADO_API_VERSION}`;
    const wiqlBody = {
      query: `SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = '${this.project}' AND [System.ChangedDate] >= '${sinceDate}' ORDER BY [System.ChangedDate] DESC`,
    };

    const wiqlResult = await adoFetch(wiqlUrl, this.pat, 'POST', wiqlBody);
    const workItemRefs = wiqlResult.workItems || [];

    if (workItemRefs.length === 0) return [];

    // Step 2: Batch-fetch work item details (max 200 per request)
    const ids = workItemRefs.map(ref => ref.id);
    const allWorkItems = [];

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const detailUrl = `${this.baseUrl}/_apis/wit/workitems?ids=${batch.join(',')}&$expand=relations&api-version=${ADO_API_VERSION}`;

      try {
        const result = await adoFetch(detailUrl, this.pat);
        if (result.value) {
          allWorkItems.push(...result.value);
        }
      } catch (err) {
        console.error(`[seal:sources:azure-devops] Batch fetch failed (ids ${batch[0]}-${batch[batch.length - 1]}): ${err.message}`);
      }
    }

    return allWorkItems;
  }

  // ─── Internal: Iterations ──────────────────────────────

  /**
   * Fetch iterations (sprints) for the team.
   */
  async _fetchIterations() {
    const url = `${this.baseUrl}/${encodeURIComponent(this.team)}/_apis/work/teamsettings/iterations?api-version=${ADO_API_VERSION}`;
    const result = await adoFetch(url, this.pat);
    return result.value || [];
  }

  // ─── Helpers ───────────────────────────────────────────

  _daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
  }
}

// ─── Azure DevOps REST helper ─────────────────────────────

/**
 * Make an authenticated request to the Azure DevOps REST API.
 * @param {string} url - Full API URL
 * @param {string} pat - Personal Access Token
 * @param {string} method - HTTP method (default: GET)
 * @param {object|null} body - Request body for POST/PATCH
 * @returns {Promise<object>} Parsed JSON response
 */
async function adoFetch(url, pat, method = 'GET', body = null) {
  const auth = Buffer.from(`:${pat}`).toString('base64');
  const options = {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ADO API ${res.status}: ${res.statusText} — ${text.slice(0, 200)}`);
  }

  return res.json();
}
