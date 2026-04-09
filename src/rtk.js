/**
 * SEAL RTK Integration — Token compression for executor
 *
 * RTK (Rust Token Killer) compresses CLI output by 60-90% before
 * it reaches the LLM context. This module wraps commands through RTK
 * when available, falling back to direct execution when not installed.
 *
 * RTK is used in two ways:
 * 1. Wrapping commands in task meta-prompts (e.g., "rtk git diff" instead of "git diff")
 * 2. Pre-compressing task output before storing in SQLite/MemPalace
 */

import { execSync } from 'child_process';

let _rtkAvailable = null;
let _rtkStats = { commands: 0, tokensSaved: 0 };

// ─── Check availability ──────────────────────────────
export function isRtkAvailable() {
  if (_rtkAvailable !== null) return _rtkAvailable;
  try {
    execSync('rtk --version', { stdio: 'pipe', timeout: 5000 });
    _rtkAvailable = true;
    console.log('[rtk] RTK detected — token compression enabled');
  } catch {
    _rtkAvailable = false;
    console.log('[rtk] RTK not found — running without token compression');
  }
  return _rtkAvailable;
}

// ─── Wrap a command through RTK ──────────────────────
/**
 * If RTK is available, prefix the command with "rtk".
 * e.g., "git diff" → "rtk git diff"
 *
 * Commands that benefit most from RTK:
 * - git (status, diff, log, show)
 * - ls, tree, find
 * - cat, head, tail
 * - grep, rg
 * - test runners (npm test, cargo test, pytest, flutter test)
 * - docker, kubectl
 */
export function wrapCommand(command) {
  if (!isRtkAvailable()) return command;

  // Commands that RTK handles well
  const rtkFriendly = [
    'git', 'ls', 'tree', 'find', 'cat', 'head', 'tail',
    'grep', 'rg', 'npm', 'cargo', 'pytest', 'flutter',
    'docker', 'kubectl', 'go', 'dart', 'ruff',
  ];

  const firstWord = command.trim().split(/\s+/)[0];
  if (rtkFriendly.includes(firstWord)) {
    _rtkStats.commands++;
    return `rtk ${command}`;
  }
  return command;
}

// ─── Compress output string ──────────────────────────
/**
 * Use RTK to compress arbitrary text output.
 * Useful for compressing task results before storing in memory.
 *
 * Falls back to simple truncation if RTK is not available.
 */
export function compressOutput(output, maxTokens = 2000) {
  if (!output || typeof output !== 'string') return output || '';

  if (isRtkAvailable()) {
    try {
      // RTK can compress piped input
      const compressed = execSync('rtk cat', {
        input: output,
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
      });
      _rtkStats.tokensSaved += estimateTokens(output) - estimateTokens(compressed);
      return compressed;
    } catch {
      // Fall through to manual compression
    }
  }

  // Fallback: simple truncation with context preservation
  return smartTruncate(output, maxTokens);
}

// ─── Enhance meta-prompt with RTK awareness ──────────
/**
 * Modify a task's meta-prompt to use RTK-wrapped commands.
 * This is injected before the prompt reaches claude -p.
 */
export function enhancePrompt(prompt) {
  if (!isRtkAvailable() || !prompt) return prompt;

  // Don't prepend anything when the prompt starts with "/" — it's a skill
  // invocation and the slash must be the first thing Claude sees.
  if (prompt.trimStart().startsWith('/')) return prompt;

  // Prepend RTK instruction so the spawned claude session uses RTK
  return (
    '[RTK is installed. When running shell commands, prefer RTK-wrapped versions ' +
    'for compressed output: "rtk git diff", "rtk git log", "rtk cat file.dart". ' +
    'This saves tokens and extends your session.]\n\n' +
    prompt
  );
}

// ─── Stats ───────────────────────────────────────────
export function getStats() {
  return { ..._rtkStats };
}

export function resetStats() {
  _rtkStats = { commands: 0, tokensSaved: 0 };
}

// ─── Helpers ─────────────────────────────────────────
function estimateTokens(text) {
  // Rough estimate: 1 token ≈ 4 chars for English/code
  return Math.ceil((text || '').length / 4);
}

function smartTruncate(text, maxTokens) {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  // Keep first 60% and last 20%, with a truncation notice in between
  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = Math.floor(maxChars * 0.2);
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const omitted = text.length - headSize - tailSize;

  return `${head}\n\n... [${omitted} chars truncated by SEAL] ...\n\n${tail}`;
}
