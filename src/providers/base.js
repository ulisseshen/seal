// Provider contract for SEAL chat + (future) proactive layer.
//
// A provider exposes:
//   name         — short id (claude, codex, gemini)
//   available()  — boolean: configured + ready to use
//   async *stream(messages, systemPrompt)  — async iterator yielding text chunks
//   async complete(messages, systemPrompt) — convenience: joins stream()
//
// Messages are { role: 'user' | 'assistant', content: string }.

export class BaseProvider {
  constructor(opts = {}) {
    this.model = opts.model;
  }

  get name() { return 'base'; }

  available() { return false; }

  async *stream(_messages, _systemPrompt) {
    throw new Error(`${this.name} provider: stream() not implemented`);
  }

  async complete(messages, systemPrompt) {
    let out = '';
    for await (const chunk of this.stream(messages, systemPrompt)) {
      out += chunk;
    }
    return out;
  }
}

export function renderTranscript(messages, systemPrompt) {
  // Flatten messages into a single prompt string for CLI-driven providers that
  // take a one-shot input (claude -p, codex exec -).
  const parts = [];
  if (systemPrompt) parts.push(`[system]\n${systemPrompt}\n`);
  for (const m of messages) {
    const tag = m.role === 'assistant' ? '[assistant]' : '[user]';
    parts.push(`${tag}\n${m.content}\n`);
  }
  parts.push('[assistant]\n');
  return parts.join('\n');
}
