// Provider registry
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { GeminiProvider } from './gemini.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';

const REGISTRY = {
  claude: ClaudeProvider,
  codex: CodexProvider,
  gemini: GeminiProvider,
  openai: OpenAIProvider,
  ollama: OllamaProvider,
};

export function getProvider(name, opts = {}) {
  const Cls = REGISTRY[name];
  if (!Cls) throw new Error(`Unknown provider: ${name}. Options: ${Object.keys(REGISTRY).join(', ')}`);
  return new Cls(opts);
}

export function listProviders() {
  return Object.keys(REGISTRY);
}
