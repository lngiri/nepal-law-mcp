import Database from "better-sqlite3";
const db = new Database("data/nepal-law.db");

const rows = db.prepare(`
  SELECT p.text, p.section_number, s.title_np, s.quality
  FROM provisions p
  JOIN statutes s ON p.statute_id = s.id
  LIMIT 3
`).all() as any[];

console.log(JSON.stringify(rows, null, 2));
db.close();
