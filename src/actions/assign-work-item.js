/**
 * Action: assign an Azure DevOps work item.
 *
 * Stub for now — Phase 6 will flesh out the Azure DevOps integration.
 */

import { BaseAction } from './base.js';

export class AssignWorkItemAction extends BaseAction {
  constructor() {
    super('assign-work-item', 'Assign an Azure DevOps work item');
  }

  async preview(context) {
    const p = context.params || {};
    const workItemId = p.workItemId || '(not specified)';
    const assignee = p.assignee || '(not specified)';

    return {
      summary: `Will assign work item #${workItemId} to ${assignee}`,
      details: [
        `Work Item: #${workItemId}`,
        `Assignee: ${assignee}`,
        p.project ? `Project: ${p.project}` : null,
        p.reason ? `Reason: ${p.reason}` : null,
      ].filter(Boolean).join('\n'),
      impact: 'The Azure DevOps work item will be reassigned.',
    };
  }

  async execute(_context) {
    // TODO: integrate with Azure DevOps adapter in Phase 6
    console.log('[seal:actions] assign-work-item: Azure DevOps integration pending (Phase 6)');
    return { success: false, message: 'Azure DevOps integration pending (Phase 6)' };
  }
}
