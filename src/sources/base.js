/**
 * Base class for source plugins.
 * Each source plugin reads data from an external system (Teams, Azure DevOps, etc.)
 * and transforms it into KnowledgeItem objects for the Knowledge Engine.
 */
export class BaseSourcePlugin {
  constructor(name, description) {
    this.name = name;
    this.description = description;
    this.artifactTypes = [];
  }

  /**
   * Initialize the plugin with source-specific config and the shared engine.
   * @param {object} config - Source-specific config (e.g., { dataDir: '/path/to/data' })
   * @param {import('../knowledge/engine.js').KnowledgeEngine} engine - Knowledge engine instance
   */
  async init(config, engine) {
    throw new Error('not implemented');
  }

  /**
   * Sync data from the source. Returns an array of KnowledgeItem objects.
   * The engine handles upsert, so sync is idempotent.
   * @param {string|null} since - ISO date string to sync from (null = full sync)
   * @returns {Promise<Array>} Array of KnowledgeItem objects
   */
  async sync(since) {
    throw new Error('not implemented');
  }

  /**
   * Health check for the source.
   * @returns {Promise<{ok: boolean, detail?: string}>}
   */
  async healthy() {
    return { ok: false };
  }

  /**
   * Clean up resources.
   */
  async destroy() {}
}
