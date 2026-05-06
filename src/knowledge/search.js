/**
 * Knowledge Engine — Hybrid search (FTS5 + vector embeddings via sqlite-vec).
 * Merges BM25 keyword relevance with semantic similarity for best-of-both results.
 */

/**
 * Sanitize user input for FTS5 MATCH: strip quotes, wrap tokens in "..." joined with OR.
 */
function sanitizeFts(q) {
  return q.replace(/["']/g, '').split(/\s+/).filter(Boolean).map(w => `"${w}"`).join(' OR ');
}

export class KnowledgeSearch {
  constructor(db, embeddingProvider) {
    this.db = db;
    this.embedder = embeddingProvider;
  }

  /**
   * Hybrid search: vector similarity + FTS5 BM25, merged by weighted score.
   * Semantic weight: 1.0, FTS weight: 0.5.
   */
  async search(query, { type, source, project, limit = 10 } = {}) {
    const limitSafe = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const byId = new Map();

    // 1. Vector search (if embeddings are available)
    const embedding = await this.embedder.embed(query);
    if (embedding) {
      const vec = this.embedder.toBuffer(embedding);
      try {
        const semRows = await this.db.all(
          `SELECT rowid, distance FROM knowledge_vec WHERE embedding MATCH ? AND k = ?
           ORDER BY distance ASC`,
          [vec, limitSafe * 3]
        );
        for (const r of semRows) {
          const rowid = typeof r.rowid === 'bigint' ? Number(r.rowid) : r.rowid;
          byId.set(rowid, { rowid, semScore: 1 / (1 + r.distance), ftsScore: 0 });
        }
      } catch (err) {
        console.log(`[seal:knowledge] Vector search error: ${err.message}`);
      }
    }

    // 2. FTS keyword search
    try {
      const ftsQuery = sanitizeFts(query);
      if (ftsQuery) {
        const ftsRows = await this.db.all(
          `SELECT rowid, -bm25(knowledge_fts) AS score FROM knowledge_fts
           WHERE knowledge_fts MATCH ?
           ORDER BY score DESC LIMIT ?`,
          [ftsQuery, limitSafe * 2]
        );
        for (const r of ftsRows) {
          const rowid = typeof r.rowid === 'bigint' ? Number(r.rowid) : r.rowid;
          const existing = byId.get(rowid);
          if (existing) {
            existing.ftsScore = 0.5;
          } else {
            byId.set(rowid, { rowid, semScore: 0, ftsScore: 1 });
          }
        }
      }
    } catch (err) {
      console.log(`[seal:knowledge] FTS search error: ${err.message}`);
    }

    if (byId.size === 0) return [];

    // 3. Merge results by final score
    const ranked = [...byId.values()]
      .map(r => ({ ...r, finalScore: r.semScore + r.ftsScore }))
      .sort((a, b) => b.finalScore - a.finalScore);

    // 4. Fetch full items and apply filters
    const ids = ranked.map(r => r.rowid);
    const scoreMap = new Map(ranked.map(r => [r.rowid, r.finalScore]));

    const placeholders = ids.map(() => '?').join(',');
    let sql = `SELECT * FROM knowledge_items WHERE id IN (${placeholders})`;
    const params = [...ids];

    if (type) { sql += ` AND type = ?`; params.push(type); }
    if (source) { sql += ` AND source = ?`; params.push(source); }
    if (project) { sql += ` AND project = ?`; params.push(project); }

    const rows = await this.db.all(sql, params);

    return rows
      .map(r => ({ ...r, score: scoreMap.get(r.id) || 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limitSafe);
  }

  /**
   * List all items of a given type.
   */
  async listByType(type, limit = 30) {
    const limitSafe = Math.min(Math.max(Number(limit) || 30, 1), 200);
    return this.db.all(
      `SELECT * FROM knowledge_items WHERE type = ? ORDER BY date DESC NULLS LAST LIMIT ?`,
      [type, limitSafe]
    );
  }

  /**
   * Find experts by topic: aggregate people from items matching the topic via FTS.
   */
  async findExperts(topic, limit = 10) {
    try {
      const ftsQuery = sanitizeFts(topic);
      if (!ftsQuery) return [];

      const rows = await this.db.all(
        `SELECT ki.people FROM knowledge_fts
         JOIN knowledge_items ki ON ki.id = knowledge_fts.rowid
         WHERE knowledge_fts MATCH ?
         LIMIT 50`,
        [ftsQuery]
      );

      const scores = {};
      for (const r of rows) {
        let people;
        try { people = JSON.parse(r.people || '[]'); } catch { people = []; }
        for (const p of people) {
          if (p) scores[p] = (scores[p] || 0) + 1;
        }
      }

      return Object.entries(scores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, mentions]) => ({ name, mentions }));
    } catch (err) {
      console.log(`[seal:knowledge] findExperts error: ${err.message}`);
      return [];
    }
  }
}
