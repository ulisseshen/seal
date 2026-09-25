import { BaseAction } from './base.js';
import { getMessagingConnector } from '../messaging/index.js';
import { markChargeSent } from '../sensors/pr-review-charge.js';

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || name;

export function friendlyError(message) {
  const text = String(message || '');
  if (/header does not match|could not open the people-picker|possibly-wrong conversation/i.test(text)) {
    return 'o Teams abriu uma conversa que não era dessa pessoa, então parei para não mandar para a errada.';
  }
  if (/not authenticated|login browser/i.test(text)) return 'a sessão do Teams web caiu; abra o login do teamsbot.';
  if (/fora do ar|ECONNREFUSED|fetch failed|timeout|aborted/i.test(text)) return 'o teamsbot não respondeu.';
  return `${text}.`;
}

export class SendChargeAction extends BaseAction {
  constructor({
    connectorFor = getMessagingConnector,
    markSent = markChargeSent,
    name = 'cobranca',
    description = 'Envia ao autor da PR a cobrança da revisão automática pelo app de mensagens da empresa',
  } = {}) {
    super(name, description);
    this.connectorFor = connectorFor;
    this.markSent = markSent;
  }

  async preview(context) {
    const connector = this.connectorFor(context.connector);
    return {
      summary: `💬 Enviar no ${connector.label} para ${context.author?.name}${context.author?.email ? ` <${context.author.email}>` : ''}?${context.origin ? `\nPedido por: ${context.origin}` : ''}`,
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
    let result;
    try {
      result = await connector.sendDirect(context.author, context.message);
    } catch (err) {
      return { success: false, message: `não enviei para ${firstName(context.author?.name)}: ${friendlyError(err.message)} Nada foi enviado; a cobrança continua pendente no painel.` };
    }
    if (context.sentKeys?.length) this.markSent(context.sentKeys, result.sentAt);
    return { success: true, message: `enviada para ${firstName(context.author?.name)} no ${connector.label}` };
  }
}
