import { MessagingConnector } from './base.js';

const SEND_TIMEOUT_MS = 180_000;
const QUICK_TIMEOUT_MS = 10_000;

export class TeamsConnector extends MessagingConnector {
  constructor({ url = 'http://127.0.0.1:4317', fetchImpl = globalThis.fetch } = {}) {
    super('teams', 'Microsoft Teams');
    this.url = url.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.capabilities = ['send_direct', 'list_conversations'];
  }

  async request(pathname, { method = 'GET', body, timeoutMs = QUICK_TIMEOUT_MS } = {}) {
    const res = await this.fetch(`${this.url}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Teams respondeu ${res.status}`);
    }
    return data;
  }

  async health() {
    try {
      const data = await this.request('/api/health');
      return { ok: Boolean(data.sessionDirectoryExists), detail: data.browserMode || 'ok' };
    } catch (err) {
      return { ok: false, detail: `teamsbot fora do ar: ${err.message}` };
    }
  }

  async sendDirect(person, text) {
    const to = person?.name;
    if (!to) throw new Error('destinatário sem nome');
    const data = await this.request('/api/send', {
      method: 'POST',
      body: { to, message: text, headless: true },
      timeoutMs: SEND_TIMEOUT_MS,
    });
    return { ok: true, to: data.to || to, sentAt: data.sentAt || new Date().toISOString() };
  }

  async listConversations() {
    const data = await this.request('/api/scrape-targets');
    return (data.targets || []).map((target) => ({
      id: target.url,
      name: target.name,
      type: target.type,
      url: target.url,
    }));
  }
}
