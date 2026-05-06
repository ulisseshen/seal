/**
 * Action: send a follow-up message/reminder about a knowledge item.
 *
 * Uses the gateway to send a message with context about the knowledge item.
 */

import { BaseAction } from './base.js';

export class SendFollowupAction extends BaseAction {
  /**
   * @param {import('../gateway/router.js').GatewayRouter} gateway
   */
  constructor(gateway) {
    super('send-followup', 'Send a follow-up about a knowledge item');
    this.gateway = gateway;
  }

  async preview(context) {
    const item = context.knowledgeItems?.[0];
    const title = item?.title || '(unknown item)';
    const target = context.params?.target || 'default channel';

    return {
      summary: `Will send follow-up about: ${title}`,
      details: [
        `Item: ${title}`,
        `Type: ${item?.type || 'unknown'}`,
        `Target: ${target}`,
        context.params?.message ? `Custom message: ${context.params.message}` : null,
      ].filter(Boolean).join('\n'),
      impact: 'A follow-up message will be sent via the gateway.',
    };
  }

  async execute(context) {
    const item = context.knowledgeItems?.[0];
    const title = item?.title || '(unknown item)';
    const customMessage = context.params?.message || '';

    const body = [
      `Follow-up: ${title}`,
      item?.content ? `\n${item.content.slice(0, 500)}` : '',
      customMessage ? `\n${customMessage}` : '',
    ].join('');

    try {
      const result = await this.gateway.send(
        {
          level: 'info',
          category: 'follow-up',
          text: body,
        },
        context.params?.target || null,
      );

      if (result.delivered) {
        console.log(`[seal:actions] Follow-up sent about: ${title}`);
        return { success: true, message: `Follow-up sent about: ${title}` };
      } else {
        return { success: false, message: `Follow-up delivery failed for: ${title}` };
      }
    } catch (err) {
      console.error(`[seal:actions] Follow-up send error: ${err.message}`);
      return { success: false, message: `Follow-up failed: ${err.message}` };
    }
  }
}
