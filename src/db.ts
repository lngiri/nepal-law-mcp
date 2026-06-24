import Database from "better-sqlite3";
import path from "node:path";
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Statute, Provision, SearchResult, NewStatute } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const possiblePaths = [
  path.join(__dirname, "..", "..", "data", "nepal-law.db"),
  path.join(__dirname, "..", "data", "nepal-law.db"),
  path.join(process.cwd(), "data", "nepal-law.db"),
  "/var/task/data/nepal-law.db",
];

export const DB_PATH_SRC = possiblePaths.find((p) => existsSync(p));

const isVercel = !!process.env.VERCEL;

// On Vercel, copy DB to /tmp so SQLite can write its lock/WAL files
export function getDbPath(): string {
  if (!DB_PATH_SRC) throw new Error("Database file not found at any path: " + possiblePaths.join(", "));
  if (isVercel) {
    const tmpPath = path.join("/tmp", "nepal-law.db");
    if (!existsSync(tmpPath)) {
      copyFileSync(DB_PATH_SRC, tmpPath);
    }
    return tmpPath;
  }
  return DB_PATH_SRC;
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = getDbPath();
    db = new Database(dbPath, isVercel ? { readonly: true, fileMustExist: true } : {});
    if (!isVercel) {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      initializeSchema(db);
    }
  }
  return db;
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS statutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title_np TEXT NOT NULL,
      title_en TEXT NOT NULL,
      year TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      source_url TEXT,
      quality TEXT NOT NULL DEFAULT 'unprocessed',
      quality_detail TEXT
    );

    CREATE TABLE IF NOT EXISTS provisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      statute_id INTEGER NOT NULL,
      section_number TEXT,
      section_title TEXT,
      text TEXT NOT NULL,
      FOREIGN KEY (statute_id) REFERENCES statutes(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS statutes_fts USING fts5(
      title_np, title_en, content='statutes', content_rowid='id'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS provisions_fts USING fts5(
      section_number, section_title, text, content='provisions', content_rowid='id'
    );
  `);

  createFtsTriggers(db);

  // Add quality column for existing databases (safe migration)
  try {
    db.exec("ALTER TABLE statutes ADD COLUMN quality TEXT NOT NULL DEFAULT 'unprocessed'");
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec("ALTER TABLE statutes ADD COLUMN quality_detail TEXT");
  } catch {
    // Column already exists — ignore
  }

  // Fill in missing years from title_np
  const updated = migrateYears();
  if (updated > 0) {
    console.error(`[db] Migrated ${updated} missing years from titles`);
  }
}

function createFtsTriggers(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS statutes_ai AFTER INSERT ON statutes BEGIN
      INSERT INTO statutes_fts(rowid, title_np, title_en) VALUES (new.id, new.title_np, new.title_en);
    END;

    CREATE TRIGGER IF NOT EXISTS statutes_ad AFTER DELETE ON statutes BEGIN
      INSERT INTO statutes_fts(statutes_fts, rowid, title_np, title_en) VALUES('delete', old.id, old.title_np, old.title_en);
    END;

    CREATE TRIGGER IF NOT EXISTS statutes_au AFTER UPDATE ON statutes BEGIN
      INSERT INTO statutes_fts(statutes_fts, rowid, title_np, title_en) VALUES('delete', old.id, old.title_np, old.title_en);
      INSERT INTO statutes_fts(rowid, title_np, title_en) VALUES (new.id, new.title_np, new.title_en);
    END;

    CREATE TRIGGER IF NOT EXISTS provisions_ai AFTER INSERT ON provisions BEGIN
      INSERT INTO provisions_fts(rowid, section_number, section_title, text) VALUES (new.id, new.section_number, new.section_title, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS provisions_ad AFTER DELETE ON provisions BEGIN
      INSERT INTO provisions_fts(provisions_fts, rowid, section_number, section_title, text) VALUES('delete', old.id, old.section_number, old.section_title, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS provisions_au AFTER UPDATE ON provisions BEGIN
      INSERT INTO provisions_fts(provisions_fts, rowid, section_number, section_title, text) VALUES('delete', old.id, old.section_number, old.section_title, old.text);
      INSERT INTO provisions_fts(rowid, section_number, section_title, text) VALUES (new.id, new.section_number, new.section_title, new.text);
    END;
  `);
}

export function upsertStatute(statute: NewStatute): number {
  const d = getDb();
  const existing = d.prepare("SELECT id FROM statutes WHERE title_en = ?").get(statute.title_en) as { id: number } | undefined;
  if (existing) {
    d.prepare(`
      UPDATE statutes SET title_np = ?, year = ?, status = ?, source_url = ? WHERE id = ?
    `).run(statute.title_np, statute.year, statute.status, statute.source_url, existing.id);
    return existing.id;
  }
  const result = d.prepare(`
    INSERT INTO statutes (title_np, title_en, year, status, source_url) VALUES (?, ?, ?, ?, ?)
  `).run(statute.title_np, statute.title_en, statute.year, statute.status, statute.source_url);
  return Number(result.lastInsertRowid);
}

export function insertProvision(prov: Omit<Provision, "id">): number {
  const d = getDb();
  const result = d.prepare(`
    INSERT INTO provisions (statute_id, section_number, section_title, text) VALUES (?, ?, ?, ?)
  `).run(prov.statute_id, prov.section_number, prov.section_title, prov.text);
  return Number(result.lastInsertRowid);
}

export function updateStatuteQuality(id: number, quality: string, detail: string | null): void {
  const d = getDb();
  d.prepare("UPDATE statutes SET quality = ?, quality_detail = ? WHERE id = ?").run(quality, detail, id);
}

export function searchStatutes(query: string, limit = 20): SearchResult[] {
  const d = getDb();
  const rows = d.prepare(`
    SELECT
      s.id AS statute_id,
      s.title_np,
      s.title_en,
      COALESCE(pt.snippet, st.snippet) AS snippet,
      rank,
      s.quality
    FROM (
      SELECT rowid, rank, snippet(statutes_fts, 0, '<mark>', '</mark>', '...', 40) AS snippet FROM statutes_fts WHERE statutes_fts MATCH ?
    ) AS st
    JOIN statutes s ON s.id = st.rowid
    LEFT JOIN (
      SELECT p.statute_id, snippet(provisions_fts, 2, '<mark>', '</mark>', '...', 40) AS snippet
      FROM provisions_fts
      JOIN provisions p ON p.id = provisions_fts.rowid
      WHERE provisions_fts MATCH ?
    ) pt ON pt.statute_id = s.id
    ORDER BY rank
    LIMIT ?
  `).all(query, query, limit) as SearchResult[];
  return rows;
}

export function getProvision(actName: string, sectionNumber: string): Provision | null {
  const d = getDb();
  const row = d.prepare(`
    SELECT p.* FROM provisions p
    JOIN statutes s ON s.id = p.statute_id
    WHERE (s.title_en LIKE ? OR s.title_np LIKE ?)
      AND p.section_number = ?
    LIMIT 1
  `).get(`%${actName}%`, `%${actName}%`, sectionNumber) as Provision | undefined;
  return row ?? null;
}

export function listActs(): Statute[] {
  const d = getDb();
  return d.prepare("SELECT * FROM statutes ORDER BY title_en").all() as Statute[];
}

export function getActStatus(actName: string): Statute | null {
  const d = getDb();
  const row = d.prepare(`
    SELECT * FROM statutes WHERE title_en LIKE ? OR title_np LIKE ? LIMIT 1
  `).get(`%${actName}%`, `%${actName}%`) as Statute | undefined;
  return row ?? null;
}

export function getStatuteProvisionsCount(statuteId: number): number {
  const d = getDb();
  const row = d.prepare("SELECT COUNT(*) AS c FROM provisions WHERE statute_id = ?").get(statuteId) as { c: number };
  return row.c;
}

export function migrateYears(): number {
  const d = getDb();
  const NEPALI_DIGITS: Record<string, string> = {
    "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
    "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
  };
  const rows = d.prepare("SELECT id, title_np FROM statutes WHERE year IS NULL").all() as { id: number; title_np: string }[];
  let updated = 0;
  const stmt = d.prepare("UPDATE statutes SET year = ? WHERE id = ?");
  for (const r of rows) {
    const eng = r.title_np.replace(/[०-९]/g, (d) => NEPALI_DIGITS[d] ?? d);
    const m = eng.match(/(?:20\d{2}|19\d{2})/);
    if (m) {
      stmt.run(m[0], r.id);
      updated++;
    }
  }
  return updated;
}

export function getStatuteCount(): number {
  const d = getDb();
  const row = d.prepare("SELECT COUNT(*) AS count FROM statutes").get() as { count: number };
  return row.count;
}

export function rebuildFtsIndex(): void {
  const d = getDb();
  d.exec(`
    INSERT INTO statutes_fts(statutes_fts) VALUES('rebuild');
    INSERT INTO provisions_fts(provisions_fts) VALUES('rebuild');
  `);
}
