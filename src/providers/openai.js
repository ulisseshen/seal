// OpenAI provider — HTTP SSE stream against /v1/chat/completions.
// API key stored in SEAL secret store (Keychain on macOS).

import { BaseProvider } from './base.js';
import { getSecret } from '../secrets.js';

const API_BASE = 'https://api.openai.com/v1';

export class OpenAIProvider extends BaseProvider {
  get name() { return 'openai'; }

  get apiKey() {
    return process.env.OPENAI_API_KEY || getSecret('openai', 'api_key');
  }

  available() {
    return Boolean(this.apiKey);
  }

  async *stream(messages, systemPrompt) {
    const key = this.apiKey;
    if (!key) {
      throw new Error('OpenAI API key not configured. Run: seal setup provider openai --token <key>');
    }
    const model = this.model || 'gpt-4.1-mini';

    const payload = {
      model,
      stream: true,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };

    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`openai HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.body) throw new Error('openai: empty response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const dataLines = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join('');
        if (dataStr === '[DONE]') return;

        try {
          const json = JSON.parse(dataStr);
          const delta = json?.choices?.[0]?.delta?.content || '';
          if (delta) yield delta;
        } catch {
          // ignore malformed chunk
        }
      }
    }
  }
}
