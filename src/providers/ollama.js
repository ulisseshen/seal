// Ollama provider — local HTTP chat against /api/chat (NDJSON stream).
// No credentials required. Host is configurable via OLLAMA_HOST env var
// or `seal setup provider ollama --host http://...`.

import { BaseProvider } from './base.js';
import { getSecret } from '../secrets.js';

function resolveHost() {
  return (
    process.env.OLLAMA_HOST ||
    getSecret('ollama', 'host') ||
    'http://localhost:11434'
  );
}

export class OllamaProvider extends BaseProvider {
  get name() { return 'ollama'; }

  get host() { return resolveHost().replace(/\/$/, ''); }

  available() {
    // Ollama has no auth; we consider it available if a host is set.
    // The actual reachability check happens on first stream() attempt.
    return Boolean(this.host);
  }

  async *stream(messages, systemPrompt) {
    const host = this.host;
    const model = this.model || 'llama3.1';

    const payload = {
      model,
      stream: true,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };

    let res;
    try {
      res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new Error(`ollama: cannot reach ${host} (${err.message}). Is \`ollama serve\` running?`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ollama HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.body) throw new Error('ollama: empty response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Ollama emits newline-delimited JSON, not SSE
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        try {
          const json = JSON.parse(line);
          const chunk = json?.message?.content || '';
          if (chunk) yield chunk;
          if (json?.done) return;
        } catch {
          // ignore malformed line
        }
      }
    }
  }
}
