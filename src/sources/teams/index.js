/**
 * Teams Source Plugin — reads structured knowledge from the teamsbot data directory.
 *
 * Expects config:
 *   { dataDir: '/path/to/teamsbot/playwright_sender/data' }
 *
 * Reads extracted.json files from dataDir/knowledge/{convId}/extracted.json,
 * transforms each artifact into a KnowledgeItem, and returns them for
 * the Knowledge Engine to ingest (upsert by source+external_id).
 */

import fs from 'fs';
import path from 'path';
import { BaseSourcePlugin } from '../base.js';
import { transformArtifact, TYPE_TO_FIELD } from './transformer.js';

export class TeamsSourcePlugin extends BaseSourcePlugin {
  constructor() {
    super('teams', 'Microsoft Teams messages and knowledge artifacts');
    this.artifactTypes = ['bug', 'flag', 'decision', 'rule', 'glossary', 'qa', 'timeline'];
    this.dataDir = null;
    this.engine = null;
  }

  async init(config, engine) {
    if (!config.dataDir) {
      throw new Error('teams plugin requires config.dataDir');
    }
    this.dataDir = config.dataDir;
    this.engine = engine;

    const knowledgeDir = path.join(this.dataDir, 'knowledge');
    if (!fs.existsSync(knowledgeDir)) {
      console.log(`[seal:sources:teams] Warning: knowledge dir not found at ${knowledgeDir}`);
    }
    console.log(`[seal:sources:teams] Initialized — dataDir=${this.dataDir}`);
  }

  async sync(since) {
    const knowledgeDir = path.join(this.dataDir, 'knowledge');
    if (!fs.existsSync(knowledgeDir)) {
      console.log(`[seal:sources:teams] Knowledge directory not found: ${knowledgeDir}`);
      return [];
    }

    const items = [];
    let dirsProcessed = 0;
    let dirsSkipped = 0;
    let dirsErrored = 0;

    const dirs = fs.readdirSync(knowledgeDir);

    for (const dirName of dirs) {
      const extractedPath = path.join(knowledgeDir, dirName, 'extracted.json');
      if (!fs.existsSync(extractedPath)) {
        dirsSkipped++;
        continue;
      }

      try {
        const raw = fs.readFileSync(extractedPath, 'utf8');
        const data = JSON.parse(raw);

        const convId = data.conversationId || dirName;
        const convName = data.conversationName || dirName;

        // Process each artifact type
        for (const [type, field] of Object.entries(TYPE_TO_FIELD)) {
          const arr = data[field];
          if (!Array.isArray(arr)) continue;

          for (const artifact of arr) {
            try {
              const item = transformArtifact(type, artifact, convId, convName);
              items.push(item);
            } catch (err) {
              console.log(`[seal:sources:teams] Transform error (${type} in ${dirName}): ${err.message}`);
            }
          }
        }

        dirsProcessed++;
      } catch (err) {
        console.log(`[seal:sources:teams] Error reading ${extractedPath}: ${err.message}`);
        dirsErrored++;
      }
    }

    console.log(`[seal:sources:teams] Sync complete: ${dirsProcessed} conversations, ${items.length} items (${dirsSkipped} skipped, ${dirsErrored} errors)`);
    return items;
  }

  async healthy() {
    const knowledgeDir = path.join(this.dataDir, 'knowledge');
    const exists = fs.existsSync(knowledgeDir);
    return {
      ok: exists,
      detail: exists
        ? `knowledge dir exists at ${knowledgeDir}`
        : `knowledge dir not found at ${knowledgeDir}`,
    };
  }
}
