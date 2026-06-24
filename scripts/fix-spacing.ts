import Database from "better-sqlite3";
import fs from "node:fs";

const db = new Database("data/nepal-law.db");
const PROGRESS_FILE = "data/fix-spacing-progress.json";
const API_KEY = process.env.GEMINI_API_KEY;

const API_URL = process.env.API_URL ?? "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const skipFilters = process.argv.includes("--all");

const updateStmt = db.prepare("UPDATE provisions SET text = ? WHERE id = ?");
const DELAY_MS = 5000;
const PROGRESS_INTERVAL = 50;

// Heuristics to detect tariff/schedule tables (skip these — AI would corrupt numbers)
function isTariffTable(text: string, sectionNumber: string): boolean {
  if (/अनुसूची|तालिका/.test(sectionNumber)) return true;
  if (/\b(?:प्र\.मे\.टन|रु\.)\b/.test(text)) return true;
  const digitDotSequences = text.match(/\d+\.\d+\.\d+/g);
  if (digitDotSequences && digitDotSequences.length >= 3) return true;
  const nepaliDigitDots = text.match(/[०-९]{4}\.[०-९]{2}\.[०-९]{2}/);
  if (nepaliDigitDots) return true;
  return false;
}

// Heuristic: if average word length is < 7, text is already reasonably spaced
function hasSpacingIssues(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return false;
  const avgLen = words.reduce((s, w) => s + w.length, 0) / words.length;
  if (avgLen < 7) return false;
  const longWords = words.filter((w) => w.length > 15).length;
  if (longWords === 0) return false;
  return true;
}

async function fixText(text: string, retryCount = 0): Promise<string> {
  const url = `${API_URL}?key=${API_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `Fix ONLY the missing word spaces in this Nepali legal text.
Do not change words, punctuation, or meaning.
Return ONLY the fixed text, no explanation.

Text: ${text}`,
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 403 || response.status === 401) {
      console.error("\n❌ API key invalid or quota exhausted (HTTP", response.status, ")");
      process.exit(1);
    }
    if (response.status === 429) {
      if (retryCount >= 1) {
        console.error("\n❌ Rate limited twice consecutively. Aborting.");
        process.exit(1);
      }
      console.error("\n⚠️  Rate limited. Waiting 60s before retry...");
      await new Promise((r) => setTimeout(r, 60000));
      return fixText(text, retryCount + 1);
    }
    if (response.status === 503) {
      if (retryCount >= 3) {
        throw new Error("API 503: Server busy after 3 retries. Skipping.");
      }
      console.error(`\n⚠️  Server busy (503). Waiting 30s before retry (${retryCount + 1}/3)...`);
      await new Promise((r) => setTimeout(r, 30000));
      return fixText(text, retryCount + 1);
    }
    throw new Error(`API ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = (await response.json()) as any;
  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts?.[0]?.text) {
    const blockReason = candidate?.finishReason;
    if (blockReason) {
      console.error("API blocked:", blockReason, JSON.stringify(data).slice(0, 500));
      throw new Error(`Blocked: ${blockReason}`);
    }
    console.error("API response:", JSON.stringify(data).slice(0, 500));
    throw new Error("Unexpected API response");
  }
  return (candidate.content.parts[0].text as string).trim();
}

function saveProgress(done: number[]): void {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(done));
}

async function main() {
  const isTest = process.argv.includes("--test");
  const isDryRun = process.argv.includes("--dry-run");

  if (!isDryRun && !API_KEY) {
    console.error("GEMINI_API_KEY environment variable required");
    process.exit(1);
  }

  const isResume = process.argv.includes("--resume");

  let done: number[] = [];
  if (isResume && fs.existsSync(PROGRESS_FILE)) {
    done = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  }

  const allProvisions = db
    .prepare("SELECT id, section_number, text FROM provisions ORDER BY id")
    .all() as any[];

  let todo = allProvisions.filter((p: any) => !done.includes(p.id));

  // Apply filters unless --all flag is set
  let skippedTariff = 0;
  let skippedClean = 0;
  if (!skipFilters) {
    const filtered: any[] = [];
    for (const p of todo) {
      if (isTariffTable(p.text as string, p.section_number as string)) {
        skippedTariff++;
        continue;
      }
      if (!hasSpacingIssues(p.text as string)) {
        skippedClean++;
        continue;
      }
      filtered.push(p);
    }
    todo = filtered;
  }

  if (isTest) {
    todo = todo.slice(0, 5);
  }

  const alreadyDone = done.length;
  const totalRemaining = todo.length + skippedTariff + skippedClean;
  const totalAll = allProvisions.length;

  console.log(`\nProvisions: ${totalAll}`);
  console.log(`  - Already fixed (from progress): ${alreadyDone}`);
  console.log(`  - Skipped (tariff/schedule tables): ${skippedTariff}`);
  console.log(`  - Skipped (already clean spacing): ${skippedClean}`);
  console.log(`  - To process: ${totalRemaining - skippedTariff - skippedClean}`);
  console.log();

  if (todo.length === 0) {
    console.log("No provisions need fixing.");
    return;
  }

  if (isDryRun) {
    console.log("Dry run complete — no API calls made.\n");
    return;
  }

  console.log(`Processing ${todo.length} provisions with 5s delay between each...\n`);

  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    try {
      const fixed = await fixText(p.text as string);
      updateStmt.run(fixed, p.id);
      done.push(p.id);
      saveProgress(done);

      const current = done.length - alreadyDone;
      if (current % PROGRESS_INTERVAL === 0 || current === todo.length) {
        console.log(`Fixed ${current}/${todo.length}...`);
      }
    } catch (err) {
      console.error(`Error at index ${i} (ID ${p.id}):`, err);
    }

    if (i + 1 < todo.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nAll ${todo.length} provisions fixed.`);

  console.log("Rebuilding FTS5 index...");
  db.exec("INSERT INTO provisions_fts(provisions_fts) VALUES('rebuild')");
  console.log("FTS5 index rebuilt.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
