/**
 * Knowledge Engine — SQLite schema setup.
 * Creates knowledge_items, FTS5 index, sqlite-vec embeddings,
 * source_sync_state, and pending_actions tables.
 */

export async function setupKnowledgeSchema(db) {
  // Core knowledge items table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source          TEXT NOT NULL,
      external_id     TEXT NOT NULL,
      type            TEXT NOT NULL,
      title           TEXT NOT NULL,
      content         TEXT NOT NULL,
      embedding_text  TEXT,
      date            TEXT,
      people          TEXT DEFAULT '[]',
      project         TEXT,
      tags            TEXT DEFAULT '[]',
      meta            TEXT DEFAULT '{}',
      ingested_at     TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE(source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ki_source ON knowledge_items(source);
    CREATE INDEX IF NOT EXISTS idx_ki_type ON knowledge_items(type);
    CREATE INDEX IF NOT EXISTS idx_ki_date ON knowledge_items(date);
    CREATE INDEX IF NOT EXISTS idx_ki_project ON knowledge_items(project);
  `);

  // FTS5 for keyword search
  await db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      title, content, type, source, project,
      content='knowledge_items', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);

  // FTS sync triggers
  await db.exec(`
    CREATE TRIGGER IF NOT EXISTS ki_fts_ai AFTER INSERT ON knowledge_items BEGIN
      INSERT INTO knowledge_fts(rowid, title, content, type, source, project)
      VALUES (new.id, new.title, new.content, new.type, new.source, new.project);
    END;

    CREATE TRIGGER IF NOT EXISTS ki_fts_ad AFTER DELETE ON knowledge_items BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, type, source, project)
      VALUES ('delete', old.id, old.title, old.content, old.type, old.source, old.project);
    END;

    CREATE TRIGGER IF NOT EXISTS ki_fts_au AFTER UPDATE ON knowledge_items BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, type, source, project)
      VALUES ('delete', old.id, old.title, old.content, old.type, old.source, old.project);
      INSERT INTO knowledge_fts(rowid, title, content, type, source, project)
      VALUES (new.id, new.title, new.content, new.type, new.source, new.project);
    END;
  `);

  // Vector embeddings via sqlite-vec
  await db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec USING vec0(
      embedding float[1024]
    );
  `);

  // Source sync state
  await db.exec(`
    CREATE TABLE IF NOT EXISTS source_sync_state (
      source          TEXT PRIMARY KEY,
      last_sync_at    TEXT NOT NULL,
      last_sync_cursor TEXT,
      items_synced    INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'ok'
    );
  `);

  // Pending action confirmations
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pending_actions (
      id              TEXT PRIMARY KEY,
      action_name     TEXT NOT NULL,
      context         TEXT NOT NULL,
      preview         TEXT NOT NULL,
      gateway_channel TEXT NOT NULL,
      gateway_msg_id  TEXT,
      created_at      TEXT NOT NULL,
      expires_at      TEXT,
      confirmed_at    TEXT,
      confirmed_by    TEXT,
      result          TEXT,
      status          TEXT DEFAULT 'pending'
                      CHECK(status IN ('pending', 'confirmed', 'denied', 'expired', 'executed'))
    );
    CREATE INDEX IF NOT EXISTS idx_pa_status ON pending_actions(status);
  `);

  console.log('[seal:knowledge] Schema initialized');
}
