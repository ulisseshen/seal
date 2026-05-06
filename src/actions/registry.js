/**
 * ActionRegistry — orchestrates the action confirmation flow.
 *
 * Flow: trigger → preview → send to gateway → user clicks button → execute
 *
 * Manages pending_actions in the database and wires up gateway callbacks.
 */

import crypto from 'crypto';

export class ActionRegistry {
  /**
   * @param {object} db - SEAL database wrapper
   * @param {import('../gateway/router.js').GatewayRouter} gateway
   * @param {import('../knowledge/engine.js').KnowledgeEngine} engine
   */
  constructor(db, gateway, engine) {
    this.db = db;
    this.gateway = gateway;
    this.engine = engine;
    /** @type {Map<string, import('./base.js').BaseAction>} */
    this.actions = new Map();
  }

  /**
   * Register an action.
   * @param {import('./base.js').BaseAction} action
   */
  register(action) {
    this.actions.set(action.name, action);
    console.log(`[seal:actions] Registered action: ${action.name}`);
  }

  /**
   * Trigger an action — creates pending confirmation and sends to gateway.
   * @param {string} actionName
   * @param {import('./base.js').ActionContext} context
   * @returns {Promise<string>} pendingActionId
   */
  async trigger(actionName, context) {
    const action = this.actions.get(actionName);
    if (!action) {
      throw new Error(`[seal:actions] Unknown action: ${actionName}`);
    }

    // 1. Generate preview
    const preview = await action.preview(context);

    // 2. Create pending action record
    const actionId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db.run(`
      INSERT INTO pending_actions (id, action_name, context, preview_summary, preview_details, preview_impact, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `, [actionId, actionName, JSON.stringify(context), preview.summary, preview.details, preview.impact, now]);

    console.log(`[seal:actions] Triggered ${actionName} → pending ${actionId}`);

    // 3. Build confirmation message and send via gateway
    const confirmAction = {
      actionId,
      description: [
        preview.summary,
        '',
        preview.details,
        '',
        `Impact: ${preview.impact}`,
      ].join('\n'),
      options: [
        { label: '✅ Approve', callbackData: 'approve' },
        { label: '❌ Deny', callbackData: 'deny' },
      ],
    };

    try {
      // gateway.confirm() returns a promise that resolves when user clicks
      // We don't await it here — the callback handler will process it
      this.gateway.confirm(confirmAction).then(
        (result) => this.handleConfirmation(actionId, result.choice, result.confirmedBy),
        (err) => {
          console.error(`[seal:actions] Confirmation failed for ${actionId}: ${err.message}`);
          this._updateStatus(actionId, 'expired');
        },
      );
    } catch (err) {
      console.error(`[seal:actions] Failed to send confirmation for ${actionId}: ${err.message}`);
      await this._updateStatus(actionId, 'error');
    }

    return actionId;
  }

  /**
   * Handle confirmation callback from gateway.
   * @param {string} actionId
   * @param {string} choice - 'approve' | 'deny' | 'edit'
   * @param {string} confirmedBy - Username/ID of who confirmed
   */
  async handleConfirmation(actionId, choice, confirmedBy) {
    // 1. Load pending action from DB
    const pending = await this.db.get(
      `SELECT * FROM pending_actions WHERE id = ?`,
      [actionId],
    );

    if (!pending) {
      console.error(`[seal:actions] No pending action found: ${actionId}`);
      return;
    }

    if (pending.status !== 'pending') {
      console.log(`[seal:actions] Action ${actionId} already ${pending.status}, skipping`);
      return;
    }

    const now = new Date().toISOString();

    if (choice === 'approve') {
      // Update status to confirmed
      await this.db.run(
        `UPDATE pending_actions SET status = 'confirmed', confirmed_at = ?, confirmed_by = ? WHERE id = ?`,
        [now, confirmedBy, actionId],
      );

      console.log(`[seal:actions] Action ${actionId} approved by ${confirmedBy}`);

      // Execute the action
      const action = this.actions.get(pending.action_name);
      if (!action) {
        await this._updateStatus(actionId, 'error');
        console.error(`[seal:actions] Action "${pending.action_name}" not registered, cannot execute`);
        return;
      }

      let context;
      try {
        context = JSON.parse(pending.context);
      } catch {
        context = {};
      }
      context.confirmedBy = confirmedBy;

      try {
        const result = await action.execute(context);

        // Update status to executed
        await this.db.run(
          `UPDATE pending_actions SET status = 'executed', result = ?, executed_at = ? WHERE id = ?`,
          [JSON.stringify(result), now, actionId],
        );

        // Notify via gateway
        const emoji = result.success ? '✅' : '⚠️';
        await this.gateway.send({
          level: result.success ? 'info' : 'warning',
          category: 'action-result',
          text: `${emoji} ${pending.action_name}: ${result.message}`,
        });

        console.log(`[seal:actions] Action ${actionId} executed: ${result.message}`);
      } catch (err) {
        await this.db.run(
          `UPDATE pending_actions SET status = 'error', result = ? WHERE id = ?`,
          [JSON.stringify({ success: false, message: err.message }), actionId],
        );

        await this.gateway.send({
          level: 'warning',
          category: 'action-result',
          text: `❌ ${pending.action_name} failed: ${err.message}`,
        });

        console.error(`[seal:actions] Action ${actionId} execution failed: ${err.message}`);
      }
    } else if (choice === 'deny') {
      await this.db.run(
        `UPDATE pending_actions SET status = 'denied', confirmed_at = ?, confirmed_by = ? WHERE id = ?`,
        [now, confirmedBy, actionId],
      );

      await this.gateway.send({
        level: 'info',
        category: 'action-result',
        text: `🚫 ${pending.action_name} denied by ${confirmedBy}`,
      });

      console.log(`[seal:actions] Action ${actionId} denied by ${confirmedBy}`);
    } else if (choice === 'edit') {
      // Future — for now just log
      console.log(`[seal:actions] Action ${actionId} edit requested by ${confirmedBy} (not yet supported)`);
    } else {
      console.log(`[seal:actions] Unknown choice "${choice}" for action ${actionId}`);
    }
  }

  /**
   * Wire up gateway callbacks to handle confirmations.
   * The Telegram handler already parses "action:<id>:<choice>" and resolves
   * via gateway._resolveConfirmation(), which resolves the promise from
   * gateway.confirm(). That promise is handled in trigger() above.
   *
   * This method adds an additional onActionCallback hook to the gateway
   * for any plugins that emit action callbacks differently.
   */
  setupGatewayCallbacks() {
    // The confirm() flow already handles the callback via promises.
    // Register an onMessage handler in case we need to handle text-based confirmations.
    this.gateway.onMessage((msg) => {
      // Check if the message matches an action confirmation pattern
      const match = msg.text?.match(/^\/action\s+(\S+)\s+(approve|deny)$/i);
      if (match) {
        const [, actionId, choice] = match;
        this.handleConfirmation(actionId, choice.toLowerCase(), msg.from);
      }
    });

    console.log('[seal:actions] Gateway callbacks wired up');
  }

  /**
   * Expire old pending actions that haven't been confirmed.
   * @param {number} maxAgeHours - Maximum age in hours (default: 24)
   * @returns {Promise<number>} Number of expired actions
   */
  async expirePending(maxAgeHours = 24) {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

    const result = await this.db.run(
      `UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND created_at < ?`,
      [cutoff],
    );

    const count = result?.changes ?? result?.rowsAffected ?? 0;
    if (count > 0) {
      console.log(`[seal:actions] Expired ${count} pending action(s) older than ${maxAgeHours}h`);
    }
    return count;
  }

  /**
   * List pending actions.
   * @returns {Promise<Array>}
   */
  async listPending() {
    return this.db.all(
      `SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC`,
    );
  }

  /**
   * List all registered action names.
   * @returns {string[]}
   */
  listActions() {
    return [...this.actions.keys()];
  }

  /**
   * Update a pending action's status.
   * @param {string} actionId
   * @param {string} status
   */
  async _updateStatus(actionId, status) {
    await this.db.run(
      `UPDATE pending_actions SET status = ? WHERE id = ?`,
      [status, actionId],
    );
  }
}
