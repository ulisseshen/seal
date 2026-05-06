/**
 * Base class for SEAL actions.
 *
 * Every action goes through the confirmation flow:
 *   trigger → preview → send to gateway → user clicks button → execute
 *
 * Stage 1: requiresConfirmation is always true (hardcoded).
 */
export class BaseAction {
  /**
   * @param {string} name - Unique action identifier (e.g. 'create-task')
   * @param {string} description - Human-readable description
   */
  constructor(name, description) {
    this.name = name;
    this.description = description;
    this.requiresConfirmation = true; // Stage 1: ALWAYS true
  }

  /**
   * Preview what this action would do (for the confirmation message).
   * @param {ActionContext} context
   * @returns {Promise<{summary: string, details: string, impact: string}>}
   */
  async preview(context) {
    throw new Error('not implemented');
  }

  /**
   * Execute the action after confirmation.
   * @param {ActionContext} context
   * @returns {Promise<{success: boolean, message: string, data?: any}>}
   */
  async execute(context) {
    throw new Error('not implemented');
  }
}

/**
 * @typedef {Object} ActionContext
 * @property {Array} [knowledgeItems] - Knowledge items relevant to this action
 * @property {Object} [task] - Associated SEAL task, if any
 * @property {string} [confirmedBy] - Username/ID of who confirmed
 * @property {Object} [params] - Action-specific parameters
 */
