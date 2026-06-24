import Database from "better-sqlite3";
const db = new Database("data/nepal-law.db");
const rows = db.prepare("SELECT id, text FROM provisions WHERE text IS NOT NULL AND text != '' ORDER BY RANDOM() LIMIT 20").all();
for (const r of rows) {
  console.log("--- ID " + r.id + " ---");
  console.log(r.text);
  console.log();
}
