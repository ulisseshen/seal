// Claude provider — wraps `claude -p`.
// Credentials managed by the Claude CLI itself (`claude /login`).

import { spawn, spawnSync } from 'child_process';
import { BaseProvider, renderTranscript } from './base.js';

export class ClaudeProvider extends BaseProvider {
  get name() { return 'claude'; }

  available() {
    const r = spawnSync('which', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0;
  }

  async *stream(messages, systemPrompt) {
    if (!this.available()) {
      throw new Error('claude CLI not found in PATH. Install Claude Code and run `claude /login`.');
    }

    const prompt = renderTranscript(messages, systemPrompt);
    const args = ['-p', '--output-format', 'text'];
    if (this.model) args.push('--model', this.model);

    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
      // Forward stderr as part of the error path, not the content stream.
      error = (error || '') + buf.toString('utf-8');
    });
    child.on('close', (code) => {
      done = true;
      if (code !== 0 && !queue.length) {
        error = error || `claude exited with code ${code}`;
      }
      if (resolveNext) { resolveNext(); resolveNext = null; }
    });

    while (true) {
      if (queue.length) { yield queue.shift(); continue; }
      if (done) {
        if (error && !queue.length) throw new Error(`claude: ${error.trim()}`);
        return;
      }
      await new Promise((resolve) => { resolveNext = resolve; });
    }
  }
}
