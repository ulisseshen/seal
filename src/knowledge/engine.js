/**
 * Knowledge Engine — Main API.
 * Provides structured knowledge storage with hybrid search,
 * batch ingestion with embeddings, and sync state tracking.
 */

import { EmbeddingProvider } from './embeddings.js';
import { KnowledgeSearch } from './search.js';

export class KnowledgeEngine {
  constructor(db, config = {}) {
    this.db = db;
    this.embedder = new EmbeddingProvider(config.embedding || {});
    this.search_ = new KnowledgeSearch(db, this.embedder);
  }

  /**
   * Batch ingest items (upsert by source+external_id).
   * Each item should have: { source, external_id, type, title, content, embedding_text?, date?, people?, project?, tags?, meta? }
   * Returns { inserted, updated, errors }
   */
  async ingest(items) {
    const stats = { inserted: 0, updated: 0, errors: 0 };
    const now = new Date().toISOString();

    for (const item of items) {
      try {
        // Check if item already exists
        const existing = await this.db.get(
          `SELECT id FROM knowledge_items WHERE source = ? AND external_id = ?`,
          [item.source, item.external_id]
        );

        const people = JSON.stringify(item.people || []);
        const tags = JSON.stringify(item.tags || []);
        const meta = JSON.stringify(item.meta || {});

        if (existing) {
          // Update
          await this.db.run(
            `UPDATE knowledge_items SET
              type = ?, title = ?, content = ?, embedding_text = ?,
              date = ?, people = ?, project = ?, tags = ?, meta = ?, updated_at = ?
             WHERE id = ?`,
            [item.type, item.title, item.content, item.embedding_text || null,
             item.date || null, people, item.project || null, tags, meta, now,
             existing.id]
          );

          // Re-generate embedding if embedding_text provided
          if (item.embedding_text) {
            await this._upsertEmbedding(existing.id, item.embedding_text);
          }

          stats.updated++;
        } else {
          // Insert
          await this.db.run(
            `INSERT INTO knowledge_items
              (source, external_id, type, title, content, embedding_text, date, people, project, tags, meta, ingested_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [item.source, item.external_id, item.type, item.title, item.content,
             item.embedding_text || null, item.date || null, people, item.project || null,
             tags, meta, now, now]
          );

          // Get the inserted id for embedding
          const inserted = await this.db.get(
            `SELECT id FROM knowledge_items WHERE source = ? AND external_id = ?`,
            [item.source, item.external_id]
          );

          if (inserted && item.embedding_text) {
            await this._upsertEmbedding(inserted.id, item.embedding_text);
          }

          stats.inserted++;
        }
      } catch (err) {
        console.log(`[seal:knowledge] Ingest error for ${item.source}/${item.external_id}: ${err.message}`);
        stats.errors++;
      }
    }

    console.log(`[seal:knowledge] Ingested: ${stats.inserted} new, ${stats.updated} updated, ${stats.errors} errors`);
    return stats;
  }

  /**
   * Generate and store embedding for a knowledge item.
   */
  async _upsertEmbedding(rowid, text) {
    const embedding = await this.embedder.embed(text);
    if (!embedding) return;

    const buf = this.embedder.toBuffer(embedding);
    const id = BigInt(rowid);
    try {
      // Delete existing embedding if any, then insert new
      await this.db.run(`DELETE FROM knowledge_vec WHERE rowid = ?`, [id]);
      await this.db.run(`INSERT INTO knowledge_vec(rowid, embedding) VALUES (?, ?)`, [id, buf]);
    } catch (err) {
      console.log(`[seal:knowledge] Embedding storage error for rowid ${id}: ${err.message}`);
    }
  }

  // ─── Search delegates ──────────────────────────────────────

  async search(query, filters) {
    return this.search_.search(query, filters);
  }

  async listByType(type, limit) {
    return this.search_.listByType(type, limit);
  }

  async findExperts(topic, limit) {
    return this.search_.findExperts(topic, limit);
  }

  // ─── Item access ───────────────────────────────────────────

  async getItem(id) {
    return this.db.get(`SELECT * FROM knowledge_items WHERE id = ?`, [id]);
  }

  async getItemsBySource(source) {
    return this.db.all(`SELECT * FROM knowledge_items WHERE source = ? ORDER BY date DESC`, [source]);
  }

  // ─── Sync state ────────────────────────────────────────────

  async updateSyncState(source, cursor, itemCount) {
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO source_sync_state (source, last_sync_at, last_sync_cursor, items_synced, status)
       VALUES (?, ?, ?, ?, 'ok')
       ON CONFLICT(source) DO UPDATE SET
         last_sync_at = excluded.last_sync_at,
         last_sync_cursor = excluded.last_sync_cursor,
         items_synced = items_synced + excluded.items_synced,
         status = 'ok'`,
      [source, now, cursor || null, itemCount || 0]
    );
  }

  async getSyncState(source) {
    return this.db.get(`SELECT * FROM source_sync_state WHERE source = ?`, [source]);
  }

  // ─── Health ────────────────────────────────────────────────

  async healthy() {
    const embeddingsOk = await this.embedder.healthy();
    const dbOk = !!(await this.db.get(`SELECT 1`));
    return { db: dbOk, embeddings: embeddingsOk };
  }
}
