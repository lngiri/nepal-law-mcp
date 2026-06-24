import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getDb } from "../src/db.js";
import type { Statute, Provision, SearchResult } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

app.use(cors());
app.use(express.json());
app.use("/api", (_req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

function getDbSafe() {
  try {
    const d = getDb();
    // Quick test query to verify DB is actually functional
    d.prepare("SELECT 1").get();
    return d;
  } catch (e: any) {
    console.error("Database error:", e?.message || e);
    return null;
  }
}

app.get("/api/search", (req, res) => {
  const q = (req.query.q as string || "").trim();
  const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 20), 100);
  if (!q) return res.json({ results: [], query: "" });

  const db = getDbSafe();
  if (!db) return res.status(500).json({ error: "Database unavailable" });

  try {
    const results: SearchResult[] = [];
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length === 0) return res.json({ results: [], query: q });

    const likePatterns = words.map(w => `%${w}%`);

    // 1. FTS5 search (handles Latin/English queries; AND for multi-word)
    try {
      const ftsTerms = words.map(w => `"${w}"*`).join(" AND ");
      const ftsRows = db.prepare(`
        SELECT DISTINCT p.statute_id, s.title_np, s.title_en, s.quality,
               snippet(provisions_fts, 2, '<mark>', '</mark>', '...', 40) AS snippet
        FROM provisions_fts
        JOIN provisions p ON p.id = provisions_fts.rowid
        JOIN statutes s ON s.id = p.statute_id
        WHERE provisions_fts MATCH ?
        LIMIT ?
      `).all(ftsTerms, limit) as any[];
      for (const r of ftsRows) {
        if (!results.some(x => x.statute_id === r.statute_id)) {
          results.push({
            statute_id: r.statute_id, title_np: r.title_np, title_en: r.title_en,
            snippet: r.snippet, rank: 0, quality: r.quality,
          });
        }
      }
    } catch { /* FTS5 AND rejected — fall through to LIKE */ }

    // 2. Multi-word LIKE fallback (handles compound Devanagari like "सहकारीसंस्था")
    const titleAnd = words.map(() => `s.title_np LIKE ?`).join(" AND ");
    const provExists = words.map(
      () => `EXISTS (SELECT 1 FROM provisions WHERE statute_id = s.id AND (text LIKE ? OR section_title LIKE ?))`
    ).join(" AND ");

    const params = [
      ...likePatterns,
      ...likePatterns.flatMap(p => [p, p]),
      ...likePatterns,
      limit * 2,
    ];

    const sql = `
      SELECT s.id, s.title_np, s.title_en, s.year, s.quality
      FROM statutes s
      WHERE (${titleAnd})
         OR (${provExists})
      ORDER BY
        CASE WHEN (${titleAnd}) THEN 0 ELSE 1 END,
        s.id
      LIMIT ?
    `;

    const rows = db.prepare(sql).all(...params) as any[];

    const snippetOr = words.map(() => `(text LIKE ? OR section_title LIKE ?)`).join(" OR ");
    const snippetParams = likePatterns.flatMap(p => [p, p]);
    const snippetSql = `
      SELECT text, section_title FROM provisions
      WHERE statute_id = ?
        AND (${snippetOr})
      LIMIT 1
    `;

    for (const r of rows) {
      if (results.some(x => x.statute_id === r.id)) continue;

      let snippet = "";
      try {
        const prov = db.prepare(snippetSql).get(r.id, ...snippetParams) as { text: string; section_title: string } | undefined;
        if (prov) {
          snippet = prov.text || prov.section_title || "";
          if (snippet.length > 200) {
            const idx = snippet.indexOf(words[0]);
            if (idx !== -1) {
              const start = Math.max(0, idx - 40);
              snippet = (start > 0 ? "..." : "") + snippet.slice(start, idx + 80) + (idx + 80 < snippet.length ? "..." : "");
            } else {
              snippet = snippet.slice(0, 200) + "...";
            }
          }
        }
      } catch { /* no matching provision body — snippet stays empty */ }

      results.push({
        statute_id: r.id, title_np: r.title_np, title_en: r.title_en,
        snippet, rank: 999, quality: r.quality,
      });
    }

    res.json({ results: results.slice(0, limit), query: q });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

app.get("/api/acts", (_req, res) => {
  const db = getDbSafe();
  if (!db) return res.status(500).json({ error: "Database unavailable" });

  try {
    const acts = db.prepare(`
      SELECT s.id, s.title_np, s.title_en, s.year, s.status, s.quality,
             (SELECT COUNT(*) FROM provisions WHERE statute_id = s.id) AS provision_count
      FROM statutes s ORDER BY s.id
    `).all();
    res.json(acts);
  } catch (err) {
    console.error("List acts error:", err);
    res.status(500).json({ error: "Failed to list acts" });
  }
});

app.get("/api/acts/:id", (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  const db = getDbSafe();
  if (!db) return res.status(500).json({ error: "Database unavailable" });

  try {
    const act = db.prepare("SELECT * FROM statutes WHERE id = ?").get(id) as Statute | undefined;
    if (!act) return res.status(404).json({ error: "Act not found" });

    const provisions = db.prepare("SELECT * FROM provisions WHERE statute_id = ? ORDER BY id").all(id) as Provision[];
    res.json({ ...act, provisions });
  } catch (err) {
    console.error("Get act error:", err);
    res.status(500).json({ error: "Failed to get act" });
  }
});

app.get("/api/acts/:id/provisions/:section", (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  const db = getDbSafe();
  if (!db) return res.status(500).json({ error: "Database unavailable" });

  try {
    const provision = db.prepare(
      "SELECT p.*, s.title_np AS act_title FROM provisions p JOIN statutes s ON s.id = p.statute_id WHERE p.statute_id = ? AND p.section_number = ? LIMIT 1"
    ).get(id, req.params.section) as (Provision & { act_title: string }) | undefined;
    if (!provision) return res.status(404).json({ error: "Section not found" });
    res.json(provision);
  } catch (err) {
    console.error("Get provision error:", err);
    res.status(500).json({ error: "Failed to get provision" });
  }
});

app.get("/api/debug", (_req, res) => {
  const cwd = process.cwd();
  const check = (base: string) => {
    const f = path.join(base, "data", "nepal-law.db");
    try { return { base, db: fs.existsSync(f), dataDir: fs.existsSync(path.join(base, "data")), cwd }; } catch { return { base, error: true }; }
  };
  res.json({
    cwd,
    vercel: !!process.env.VERCEL,
    checks: [check(cwd), check("/var/task"), check(path.join(__dirname, "..", "..")), check(path.join(__dirname, ".."))],
  });
});

app.get("/api/stats", (_req, res) => {
  const db = getDbSafe();
  if (!db) return res.status(500).json({ error: "Database unavailable" });

  try {
    const totalActs = (db.prepare("SELECT COUNT(*) AS c FROM statutes").get() as { c: number }).c;
    const totalProvisions = (db.prepare("SELECT COUNT(*) AS c FROM provisions").get() as { c: number }).c;
    const verified = (db.prepare("SELECT COUNT(*) AS c FROM statutes WHERE quality = 'verified'").get() as { c: number }).c;
    const withProvisions = (db.prepare("SELECT COUNT(*) AS c FROM (SELECT DISTINCT statute_id FROM provisions)").get() as { c: number }).c;
    res.json({ totalActs, totalProvisions, verified, withProvisions });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

// Serve index.html for all other routes (SPA fallback)
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Error handling middleware
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("API Error:", err);
  res.status(500).json({ error: err?.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.error(`[nepal-law-web] Server running at http://localhost:${PORT}`);
  console.error(`[nepal-law-web] API: http://localhost:${PORT}/api/acts`);
  console.error(`[nepal-law-web] Search: http://localhost:${PORT}/api/search?q=श्रम`);
});
