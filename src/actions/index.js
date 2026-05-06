/**
 * SEAL Action System — entry point.
 *
 * Re-exports all action classes and provides a factory to set up
 * a fully wired ActionRegistry.
 */

import { ActionRegistry } from './registry.js';
import { CreateTaskAction } from './create-task.js';
import { SendFollowupAction } from './send-followup.js';
import { AssignWorkItemAction } from './assign-work-item.js';

export { BaseAction } from './base.js';
export { ActionRegistry, CreateTaskAction, SendFollowupAction, AssignWorkItemAction };

/**
 * Create and configure an ActionRegistry with all built-in actions.
 *
 * @param {object} opts
 * @param {object} opts.db - SEAL database wrapper
 * @param {import('../gateway/router.js').GatewayRouter} opts.gateway
 * @param {import('../knowledge/engine.js').KnowledgeEngine} opts.engine
 * @param {Function} opts.insertTask - insertTask function from db.js
 * @returns {ActionRegistry}
 */
export function createActionRegistry({ db, gateway, engine, insertTask }) {
  const registry = new ActionRegistry(db, gateway, engine);

  // Register built-in actions
  registry.register(new CreateTaskAction(db, insertTask));
  registry.register(new SendFollowupAction(gateway));
  registry.register(new AssignWorkItemAction());

  // Wire up gateway callbacks
  registry.setupGatewayCallbacks();

  console.log(`[seal:actions] Action system ready (${registry.listActions().length} actions registered)`);
  return registry;
}
