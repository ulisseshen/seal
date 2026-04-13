// Codex provider — wraps `codex exec` (non-interactive).
// Credentials managed by the Codex CLI itself (`codex login`).
//
// The Codex CLI prints diagnostic headers + session UI to stdout.
// We use `--output-last-message <tmpfile>` to capture ONLY the model's
// final response in a clean file, ignoring all the chrome.

import { spawn, spawnSync } from 'child_process';
import { readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

    // Codex exec expects a plain user prompt, not a transcript with [system]/[user] tags.
    // Prepend the system prompt as context, then append all user/assistant turns.
    const parts = [];
    if (systemPrompt) parts.push(systemPrompt + '\n');
    for (const m of messages) {
      parts.push(m.content);
    }
    const prompt = parts.join('\n\n');

    // Write the model response to a temp file to bypass stdout chrome.
    const outDir = join(tmpdir(), 'seal-codex');
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `response-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);

    const args = ['exec', '-', '-o', outFile];
    if (this.model) { args.push('-m', this.model); }

    const child = spawn('codex', args, {
      stdio: ['pipe', 'ignore', 'pipe'], // ignore stdout (it's all chrome)
    });
    child.stdin.write(prompt);
    child.stdin.end();

    let stderr = '';
    child.stderr.on('data', (buf) => { stderr += buf.toString('utf-8'); });

    const exitCode = await new Promise((resolve) => {
      child.on('close', (code) => resolve(code ?? -1));
      child.on('error', () => resolve(-1));
    });

    // Read the response from the temp file.
    let response = '';
    try {
      response = readFileSync(outFile, 'utf-8');
    } catch {
      // File might not exist if codex crashed before writing it.
    }
    try { unlinkSync(outFile); } catch {}

    if (!response && exitCode !== 0) {
      throw new Error(`codex exited ${exitCode}: ${stderr.slice(0, 300)}`);
    }
    if (!response) {
      throw new Error('codex produced no output');
    }

    // Yield the response as a single chunk (codex exec is batch, not streaming).
    yield response;
  }
}
