export class MessagingConnector {
  constructor(id, label) {
    this.id = id;
    this.label = label;
    this.capabilities = [];
  }

  supports(capability) {
    return this.capabilities.includes(capability);
  }

  async health() {
    return { ok: false, detail: 'not implemented' };
  }

  async sendDirect(_person, _text) {
    throw new Error(`${this.id}: sendDirect not implemented`);
  }

  async listConversations() {
    throw new Error(`${this.id}: listConversations not implemented`);
  }
}
