/**
 * Base adapter interface.
 * Every SCM adapter must implement these methods.
 * Adapters abstract away the specific API (Azure DevOps, GitHub, GitLab, etc.)
 * so that flows remain platform-agnostic.
 */

export class BaseAdapter {
  constructor(config = {}) {
    this.config = config;
  }

  /** @returns {string} adapter name */
  get name() { throw new Error('Not implemented'); }

  // ─── PR Discovery ────────────────────────────────────
  /** @returns {Promise<Array<{id, url, title, author, sourceBranch, targetBranch, isDraft}>>} */
  async listOpenPRs(filter = {}) { throw new Error('Not implemented'); }

  /** @returns {Promise<Object>} full PR details */
  async getPR(prId) { throw new Error('Not implemented'); }

  // ─── Voting ──────────────────────────────────────────
  /** @param {string} prId  @param {'approve'|'wait_for_author'|'reject'|'reset'} value */
  async vote(prId, value) { throw new Error('Not implemented'); }

  // ─── Comments & Threads ──────────────────────────────
  /** @param {string} prId  @param {Array<{file, line, severity, message}>} findings */
  async commentThreads(prId, findings) { throw new Error('Not implemented'); }

  /** @param {string} prId  @param {string} message */
  async comment(prId, message) { throw new Error('Not implemented'); }

  /** Resolve all threads created by this adapter on a PR */
  async resolveThreads(prId) { throw new Error('Not implemented'); }

  // ─── Watch ───────────────────────────────────────────
  /** @returns {Promise<string|null>} latest commit SHA */
  async getLatestCommit(prId) { throw new Error('Not implemented'); }

  // ─── Notifications ───────────────────────────────────
  /** @param {string} prId  @param {string} channel  @param {string} message */
  async notify(prId, channel, message) { throw new Error('Not implemented'); }
}
