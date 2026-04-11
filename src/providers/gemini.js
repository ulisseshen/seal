// Gemini provider — HTTP streaming against the Google Generative Language API.
// API key stored in SEAL secret store (Keychain on macOS).

import { BaseProvider } from './base.js';
import { getSecret } from '../secrets.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiProvider extends BaseProvider {
  get name() { return 'gemini'; }

  get apiKey() {
    return process.env.GEMINI_API_KEY || getSecret('gemini', 'api_key');
  }

  available() {
    return Boolean(this.apiKey);
  }

  async *stream(messages, systemPrompt) {
    const key = this.apiKey;
    if (!key) {
      throw new Error('Gemini API key not configured. Run: seal setup provider gemini --token <key>');
    }
    const model = this.model || 'gemini-2.5-pro';

    const body = {
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    };
    if (systemPrompt) {
      body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    // Server-Sent Events streaming endpoint
    const url = `${API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.body) throw new Error('gemini: empty response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines; each event may have multiple `data:` lines
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
          const chunk = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
          if (chunk) yield chunk;
        } catch {
          // ignore malformed chunk
        }
      }
    }
  }
}
