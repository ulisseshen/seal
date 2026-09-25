import fs from 'fs';
import os from 'os';
import path from 'path';
import { TeamsConnector } from './teams.js';

export { MessagingConnector } from './base.js';
export { TeamsConnector } from './teams.js';

const CONFIG_PATH = process.env.SEAL_MESSAGING_CONFIG || path.join(os.homedir(), '.config', 'seal', 'messaging.json');
const FACTORIES = { teams: (config) => new TeamsConnector(config) };
const DEFAULT_CONFIG = { default: 'teams', connectors: { teams: {} } };

export function readMessagingConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...parsed, connectors: { ...DEFAULT_CONFIG.connectors, ...(parsed.connectors || {}) } };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getMessagingConnector(id, config = readMessagingConfig()) {
  const name = id || config.default;
  const factory = FACTORIES[name];
  if (!factory) throw new Error(`conector de mensagens desconhecido: ${name}`);
  return factory(config.connectors?.[name] || {});
}
