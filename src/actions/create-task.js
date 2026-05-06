/**
 * Action: create a SEAL task.
 *
 * Wraps the existing insertTask() from db.js behind the confirmation flow.
 */

import { BaseAction } from './base.js';
import crypto from 'crypto';

export class CreateTaskAction extends BaseAction {
  /**
   * @param {object} db - The SEAL database wrapper (import from db.js)
   * @param {Function} insertTaskFn - The insertTask function from db.js
   */
  constructor(db, insertTaskFn) {
    super('create-task', 'Create a new SEAL task');
    this.db = db;
    this.insertTask = insertTaskFn;
  }

  async preview(context) {
    const p = context.params || {};
    const summary = p.summary || '(no summary)';
    const priority = p.priority || 'medium';
    const assignee = p.assignee || '(unassigned)';

    return {
      summary: `Will create task: ${summary} (priority: ${priority})`,
      details: [
        `Summary: ${summary}`,
        `Priority: ${priority}`,
        `Assignee: ${assignee}`,
        p.detail ? `Detail: ${p.detail}` : null,
        p.project ? `Project: ${p.project}` : null,
      ].filter(Boolean).join('\n'),
      impact: 'A new task will be added to the SEAL task queue.',
    };
  }

  async execute(context) {
    const p = context.params || {};
    const taskId = `seal_${crypto.randomUUID().split('-')[0]}`;
    const now = new Date().toISOString();

    const task = {
      id: taskId,
      type: p.type || 'task',
      summary: p.summary || 'Untitled task',
      detail: p.detail || null,
      execute_at: p.execute_at || null,
      recurrence: p.recurrence || null,
      next_run: p.next_run || null,
      prompt: p.prompt || null,
      project: p.project || null,
      allowed_tools: p.allowed_tools || '[]',
      permission_mode: p.permission_mode || 'auto',
      notify_type: p.notify_type || 'sound',
      notify_channel: p.notify_channel || 'system',
      notify_target: p.notify_target || null,
      people: p.people ? JSON.stringify(p.people) : '[]',
      priority: p.priority || 'medium',
      status: 'pending',
      created: now,
      max_runs: p.max_runs || null,
    };

    try {
      await this.insertTask(task);
      console.log(`[seal:actions] Task created: ${taskId}`);
      return { success: true, message: `Task created: ${taskId}`, data: { taskId } };
    } catch (err) {
      console.error(`[seal:actions] Failed to create task: ${err.message}`);
      return { success: false, message: `Failed to create task: ${err.message}` };
    }
  }
}
