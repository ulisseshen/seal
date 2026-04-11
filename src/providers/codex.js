// Codex provider — wraps `codex exec -` (stdin prompt, non-interactive).
// Credentials managed by the Codex CLI itself (`codex login`).

import { spawn, spawnSync } from 'child_process';
import { BaseProvider, renderTranscript } from './base.js';

export class CodexProvider extends BaseProvider {
  get name() { return 'codex'; }

  available() {
    const r = spawnSync('which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0;
  }

  async *stream(messages, systemPrompt) {
    if (!this.available()) {
      throw new Error('codex CLI not found in PATH. Install it and run `codex login`.');
    }

    const prompt = renderTranscript(messages, systemPrompt);
    const args = ['exec', '-'];
    if (this.model) { args.push('-m', this.model); }

    const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write(prompt);
    child.stdin.end();

    const queue = [];
    let done = false;
    let error = null;
    let resolveNext = null;

    child.stdout.on('data', (buf) => {
      queue.push(buf.toString('utf-8'));
      if (resolveNext) { resolveNext(); resolveNext = null; }
    });
    child.stderr.on('data', (buf) => {
      error = (error || '') + buf.toString('utf-8');
    });
    child.on('close', (code) => {
      done = true;
      if (code !== 0 && !queue.length) {
        error = error || `codex exited with code ${code}`;
      }
      if (resolveNext) { resolveNext(); resolveNext = null; }
    });

    while (true) {
      if (queue.length) { yield queue.shift(); continue; }
      if (done) {
        if (error && !queue.length) throw new Error(`codex: ${error.trim()}`);
        return;
      }
      await new Promise((resolve) => { resolveNext = resolve; });
    }
  }
}
