import fs from 'node:fs';
import path from 'node:path';

const sqlite = typeof process.getBuiltinModule === 'function'
  ? process.getBuiltinModule('node:sqlite')
  : undefined;

const HALF_LIFE_DAYS = { 1: 7, 2: 14, 3: 30, 4: 120, 5: Number.POSITIVE_INFINITY };

export function effectiveStrength(card, now = Date.now()) {
  if (!card) return 0;
  if (card.pinned || Number(card.importance) >= 5) return 100;
  const halfLife = HALF_LIFE_DAYS[Number(card.importance)] || 30;
  if (!Number.isFinite(halfLife)) return 100;
  const anchor = Date.parse(card.lastActivated || card.last_activated || card.updated || card.created);
  if (!Number.isFinite(anchor)) return 100;
  const days = Math.max(0, (now - anchor) / 86400000);
  return Math.max(0, 100 * Math.pow(0.5, days / halfLife));
}

export function levelForStrength(strength) {
  if (strength >= 75) return 0;
  if (strength >= 50) return 1;
  if (strength >= 25) return 2;
  if (strength >= 10) return 3;
  return 4;
}

function jsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Chinese has no spaces: build bigrams/trigrams so a cue like "部署又失败了" can match "部署". */
function queryTerms(value) {
  const chunks = String(value || '').toLowerCase().split(/\s+/).map((chunk) => chunk.trim()).filter(Boolean);
  const terms = new Set();
  for (const chunk of chunks) {
    if (/[\u3400-\u9fff]/.test(chunk)) {
      const chars = [...chunk];
      if (chars.length === 1) terms.add(chars[0]);
      for (let index = 0; index < chars.length - 1; index += 1) {
        terms.add(chars[index] + chars[index + 1]);
      }
      for (let index = 0; index < chars.length - 2; index += 1) {
        terms.add(chars[index] + chars[index + 1] + chars[index + 2]);
      }
    } else {
      terms.add(chunk);
    }
  }
  return [...terms].filter((term) => term.length >= 2).slice(0, 16);
}

/**
 * Hidden card catalog. Markdown cards remain the source of truth; this SQLite
 * file is a rebuildable directory used for fast lookup and activation state.
 */
export class Catalog {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'catalog.db');
    this.available = Boolean(sqlite);
    this.db = null;
    this.fts = false;
    this.error = null;
  }

  open() {
    if (!this.available) return null;
    if (this.db) return this.db;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.db = new sqlite.DatabaseSync(this.file);
      try {
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA synchronous = NORMAL;');
      } catch {
        /* filesystem may not support WAL; keep default */
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS cards (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          importance INTEGER NOT NULL DEFAULT 3,
          confidence TEXT NOT NULL DEFAULT 'summary',
          level INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0,
          strength REAL NOT NULL DEFAULT 100,
          created TEXT,
          updated TEXT,
          last_activated TEXT,
          activation_count INTEGER NOT NULL DEFAULT 0,
          path TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          links TEXT NOT NULL DEFAULT '[]',
          files TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          card_id TEXT,
          name TEXT NOT NULL,
          mime TEXT,
          bytes INTEGER NOT NULL DEFAULT 0,
          sha256 TEXT,
          path TEXT NOT NULL,
          created TEXT,
          last_used TEXT,
          source_session TEXT
        );
        CREATE TABLE IF NOT EXISTS links (
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          kind TEXT,
          PRIMARY KEY (from_id, to_id)
        );
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      `);
      try {
        this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS card_fts USING fts5(id UNINDEXED, title, summary, tags, tokenize='trigram');");
        this.fts = true;
      } catch {
        try {
          this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS card_fts USING fts5(id UNINDEXED, title, summary, tags);");
          this.fts = true;
        } catch {
          this.fts = false;
        }
      }
      return this.db;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.available = false;
      this.db = null;
      return null;
    }
  }

  close() {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }

  get schemaVersion() {
    const db = this.open();
    if (!db) return 0;
    try {
      return Number(db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.value || 0);
    } catch {
      return 0;
    }
  }

  needsRebuild() {
    const db = this.open();
    if (!db) return false;
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM cards').get();
      return this.schemaVersion !== 2 || Number(row?.n || 0) === 0;
    } catch {
      return true;
    }
  }

  rebuild(cards) {
    const db = this.open();
    if (!db) return false;
    db.exec('BEGIN;');
    try {
      db.exec('DELETE FROM cards; DELETE FROM links;');
      if (this.fts) db.exec('DELETE FROM card_fts;');
      for (const card of cards) this.upsert(card, { transaction: true });
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', '2')").run();
      db.exec('COMMIT;');
      return true;
    } catch (error) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        /* ignore */
      }
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  upsert(card, options = {}) {
    const db = this.open();
    if (!db) return false;
    const values = [
      String(card.id),
      card.title || '',
      card.summary || '',
      Number(card.importance) || 3,
      card.confidence || 'summary',
      Number(card.level) || 0,
      card.pinned ? 1 : 0,
      Number(card.strength ?? 100),
      card.created || '',
      card.updated || '',
      card.lastActivated || card.last_activated || '',
      Number(card.activationCount ?? card.activation_count ?? 0),
      card.file || card.path || '',
      JSON.stringify(jsonArray(card.tags)),
      JSON.stringify(jsonArray(card.links)),
      JSON.stringify(jsonArray(card.files)),
    ];
    try {
      if (!options.transaction) db.exec('BEGIN;');
      db.prepare(`
        INSERT INTO cards (id, title, summary, importance, confidence, level, pinned, strength,
          created, updated, last_activated, activation_count, path, tags, links, files)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          summary = excluded.summary,
          importance = excluded.importance,
          confidence = excluded.confidence,
          level = excluded.level,
          pinned = excluded.pinned,
          created = excluded.created,
          updated = excluded.updated,
          path = excluded.path,
          tags = excluded.tags,
          links = excluded.links,
          files = excluded.files
      `).run(...values);
      if (this.fts) {
        db.prepare('DELETE FROM card_fts WHERE id = ?').run(String(card.id));
        db.prepare('INSERT INTO card_fts (id, title, summary, tags) VALUES (?, ?, ?, ?)')
          .run(String(card.id), card.title || '', card.summary || '', jsonArray(card.tags).join(' '));
      }
      db.prepare('DELETE FROM links WHERE from_id = ?').run(String(card.id));
      for (const to of jsonArray(card.links)) {
        if (!to || to === card.id) continue;
        db.prepare('INSERT OR IGNORE INTO links (from_id, to_id, kind) VALUES (?, ?, ?)').run(String(card.id), String(to), 'related');
      }
      if (!options.transaction) db.exec('COMMIT;');
      return true;
    } catch (error) {
      if (!options.transaction) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          /* ignore */
        }
      }
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  remove(id) {
    const db = this.open();
    if (!db) return;
    try {
      db.prepare('DELETE FROM cards WHERE id = ?').run(String(id));
      if (this.fts) db.prepare('DELETE FROM card_fts WHERE id = ?').run(String(id));
      db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(String(id), String(id));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  markActivated(id) {
    const db = this.open();
    if (!db) return;
    const now = new Date().toISOString();
    try {
      db.prepare('UPDATE cards SET last_activated = ?, activation_count = activation_count + 1, strength = 100 WHERE id = ?')
        .run(now, String(id));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  rowToCard(row) {
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      importance: Number(row.importance),
      confidence: row.confidence,
      level: Number(row.level),
      pinned: Boolean(row.pinned),
      tags: jsonArray(row.tags),
      links: jsonArray(row.links),
      files: jsonArray(row.files),
      created: row.created,
      updated: row.updated,
      lastActivated: row.last_activated,
      activationCount: Number(row.activation_count),
      file: row.path,
      strength: effectiveStrength({
        importance: row.importance,
        pinned: row.pinned,
        lastActivated: row.last_activated,
        updated: row.updated,
        created: row.created,
      }),
    };
  }

  likeSearch(terms, options) {
    const db = this.open();
    if (!db) return [];
    const clauses = [];
    const params = [];
    for (const term of terms) {
      clauses.push('(title LIKE ? OR summary LIKE ? OR tags LIKE ?)');
      const like = `%${term}%`;
      params.push(like, like, like);
    }
    let sql = `SELECT * FROM cards ${clauses.length ? `WHERE (${clauses.join(' OR ')})` : ''}`;
    sql += ' ORDER BY pinned DESC, importance DESC, updated DESC LIMIT ?';
    params.push(Math.max(1, Math.min(100, options.limit || 20)));
    try {
      return db.prepare(sql).all(...params).map((row) => this.rowToCard(row));
    } catch {
      return [];
    }
  }

  ftsSearch(terms, options) {
    const db = this.open();
    if (!db || !this.fts) return [];
    const usable = terms.filter((term) => term.length >= 3);
    if (!usable.length) return [];
    const match = usable.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
    try {
      const rows = db.prepare(`
        SELECT c.*, bm25(card_fts) AS rank
        FROM card_fts JOIN cards c ON c.id = card_fts.id
        WHERE card_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(match, Math.max(1, Math.min(100, options.limit || 20)));
      return rows.map((row) => this.rowToCard(row));
    } catch {
      return [];
    }
  }

  search(query, options = {}) {
    const terms = queryTerms(query);
    const limit = Math.max(1, Math.min(100, options.limit || 20));
    if (!terms.length) return this.top(limit);
    const merged = new Map();
    for (const card of this.ftsSearch(terms, { limit })) merged.set(card.id, card);
    for (const card of this.likeSearch(terms, { limit })) {
      if (!merged.has(card.id)) merged.set(card.id, card);
    }
    let cards = [...merged.values()];
    if (options.minImportance) cards = cards.filter((card) => card.importance >= options.minImportance);
    if (options.pinnedOnly) cards = cards.filter((card) => card.pinned);
    if (options.tag) cards = cards.filter((card) => card.tags.includes(options.tag));
    if (options.confidence) cards = cards.filter((card) => card.confidence === options.confidence);
    cards.sort((a, b) => (b.importance - a.importance) || (b.strength - a.strength) || String(b.updated).localeCompare(String(a.updated)));
    const offset = Math.max(0, options.offset || 0);
    return cards.slice(offset, offset + limit);
  }

  top(limit = 20) {
    const db = this.open();
    if (!db) return [];
    try {
      return db.prepare('SELECT * FROM cards WHERE level < 4 ORDER BY pinned DESC, importance DESC, last_activated DESC, updated DESC LIMIT ?')
        .all(Math.max(1, Math.min(100, limit))).map((row) => this.rowToCard(row));
    } catch {
      return [];
    }
  }

  active(cue, limit = 8) {
    const seed = cue ? this.search(cue, { limit: 24 }) : this.top(24);
    if (!seed.length) return [];
    const byId = new Map(seed.filter((card) => card.level < 4).map((card) => [card.id, card]));
    const linkedIds = new Set();
    for (const card of seed) {
      for (const id of card.links) linkedIds.add(id);
    }
    const missing = [...linkedIds].filter((id) => !byId.has(id)).slice(0, 20);
    if (missing.length) {
      const db = this.open();
      if (db) {
        for (const id of missing) {
          try {
            const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
            if (row) {
              const card = this.rowToCard(row);
              card.linkedBonus = true;
              byId.set(card.id, card);
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
    const cards = [...byId.values()];
    cards.sort((a, b) => {
      const score = (card) => card.strength * (0.6 + card.importance / 10) + (card.pinned ? 30 : 0) + (card.linkedBonus ? 8 : 0);
      return score(b) - score(a);
    });
    return cards.filter((card) => card.level < 4).slice(0, Math.max(1, Math.min(20, limit)));
  }

  get(id) {
    const db = this.open();
    if (!db) return undefined;
    try {
      const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(String(id));
      return row ? this.rowToCard(row) : undefined;
    } catch {
      return undefined;
    }
  }

  count() {
    const db = this.open();
    if (!db) return 0;
    try {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM cards').get()?.n || 0);
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------- files

  upsertFile(file) {
    const db = this.open();
    if (!db) return false;
    try {
      db.prepare(`
        INSERT INTO files (id, card_id, name, mime, bytes, sha256, path, created, last_used, source_session)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          card_id = excluded.card_id,
          name = excluded.name,
          mime = excluded.mime,
          bytes = excluded.bytes,
          path = excluded.path,
          last_used = excluded.last_used,
          source_session = excluded.source_session
      `).run(
        file.id,
        file.cardId ?? file.card_id ?? null,
        file.name,
        file.mime || '',
        file.bytes || 0,
        file.sha256 || '',
        file.path,
        file.created || '',
        file.lastUsed ?? file.last_used ?? '',
        file.sourceSession ?? file.source_session ?? '',
      );
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  getFile(id) {
    const db = this.open();
    if (!db) return undefined;
    try {
      return db.prepare('SELECT * FROM files WHERE id = ?').get(String(id));
    } catch {
      return undefined;
    }
  }

  listFiles(cardId) {
    const db = this.open();
    if (!db) return [];
    try {
      return cardId
        ? db.prepare('SELECT * FROM files WHERE card_id = ? ORDER BY created DESC').all(String(cardId))
        : db.prepare('SELECT * FROM files ORDER BY created DESC').all();
    } catch {
      return [];
    }
  }

  removeFile(id) {
    const db = this.open();
    if (!db) return;
    try {
      db.prepare('DELETE FROM files WHERE id = ?').run(String(id));
    } catch {
      /* ignore */
    }
  }

  fileStats() {
    const db = this.open();
    if (!db) return { count: 0, bytes: 0 };
    try {
      const row = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM files').get();
      return { count: Number(row?.n || 0), bytes: Number(row?.bytes || 0) };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }
}
