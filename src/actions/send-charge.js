import { BaseAction } from './base.js';
import { getMessagingConnector } from '../messaging/index.js';
import { markChargeSent } from '../sensors/pr-review-charge.js';

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || name;

export class SendChargeAction extends BaseAction {
  constructor({ connectorFor = getMessagingConnector, markSent = markChargeSent } = {}) {
    super('cobranca', 'Envia ao autor da PR a cobrança da revisão automática pelo app de mensagens da empresa');
    this.connectorFor = connectorFor;
    this.markSent = markSent;
  }

  async preview(context) {
    const connector = this.connectorFor(context.connector);
    return {
      summary: `💬 Enviar no ${connector.label} para ${context.author?.name}?`,
      details: context.message,
      impact: null,
      options: [
        { label: '✅ Enviar', callbackData: 'approve' },
        { label: '❌ Não enviar', callbackData: 'deny' },
      ],
    };
  }

  async execute(context) {
    const connector = this.connectorFor(context.connector);
    if (!connector.supports('send_direct')) {
      return { success: false, message: `${connector.label} não envia mensagem direta` };
    }
    const result = await connector.sendDirect(context.author, context.message);
    if (context.sentKeys?.length) this.markSent(context.sentKeys, result.sentAt);
    return { success: true, message: `enviada para ${firstName(context.author?.name)} no ${connector.label}` };
  }
}
