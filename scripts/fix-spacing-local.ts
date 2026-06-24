import Database from "better-sqlite3";
import fs from "node:fs";

const db = new Database("data/nepal-law.db");
const PROGRESS_FILE = "data/fix-spacing-progress.json";

function isTariffTable(text: string): boolean {
  if (/प्र\.मे\.टन|रु\./.test(text)) return true;
  if ((text.match(/\d+\.\d+\.\d+/g) || []).length >= 3) return true;
  if (/[०-९]{4}\.[०-९]{2}\.[०-९]{2}/.test(text)) return true;
  if (/\|/.test(text) && /[a-zA-Z]/.test(text)) return true;  // OCR-garbled tariff line
  if (/-\s*अन्य/.test(text)) return true;  // tariff continuation marker
  if (/\.{5,}/.test(text)) return true;  // formatting dots (................)
  // OCR garbage lines — fewer than 3 real Devanagari words
  const devWords = text.split(/\s+/).filter(w => (w.match(/[\u0900-\u097F]{3,}/) || []).length > 0);
  if (devWords.length < 3) return true;
  return false;
}

function hasSpacingIssues(text: string): boolean {
  // Check only Devanagari-only words (filter out mixed script / punctuation)
  const devWords = text.split(/\s+/).filter((w) => /^[\u0900-\u097F]+$/.test(w) && w.length > 0);
  if (devWords.length === 0) return false;
  // Any pure-Devanagari word >= 12 chars is suspicious (likely concatenated postpositions)
  if (devWords.some((w) => w.length >= 12)) return true;
  return false;
}

// Devanagari character class (consonants, vowels, signs, digits)
const D = "\\u0900-\\u097F";
// Word boundary for Devanagari: start-of-string, whitespace, or punctuation
const B = `(?:^|[\\s।,;:\\(\\)\\-–—\\[\\]{}""''])`;

function fixSpacing(text: string): string {
  let t = text;

  // ---- Pass 0: OCR dictionary — fix common broken-word patterns ----
  // Note: No \b because JavaScript \b only matches ASCII word boundaries, not Devanagari
  const ocrFixes: [RegExp, string][] = [
    // Broken conjunctions / postpositions (OCR split a single word into separate tokens)
    [/अनि वा र्य/g, "अनिवार्य"],
    [/अनि वार्य/g, "अनिवार्य"],
    [/द् वा रा/g, "द्वारा"],
    [/हरू लाई/g, "हरूलाई"],
    [/सक् वा/g, "सक्वा"],
    [/अधिका र/g, "अधिकार"],
    [/अधिकार्थ/g, "अधिकार्थ"],
    [/का र्य/g, "कार्य"],
    [/का रण/g, "कारण"],
    [/का रोबार/g, "कारोबार"],
    // Concatenated words (no spaces between distinct words)
    [/देहायकाकुनैकार्य/g, "देहायका कुनै कार्य"],
    [/कुनैकार्य/g, "कुनै कार्य"],
    [/कुनैकारण/g, "कुनै कारण"],
    [/त्यस्तोकार्य/g, "त्यस्तो कार्य"],
    [/सोकार्य/g, "सो कार्य"],
  ];
  for (const [pattern, replacement] of ocrFixes) {
    t = t.replace(pattern, replacement);
  }

  // ---- Pass 1: Conjunctions — always split both sides ----
  // तथा (and) — never part of a word in Nepali
  t = t.replace(new RegExp(`([${D}])तथा([${D}])`, "g"), "$1 तथा $2");
  t = t.replace(new RegExp(`([${D}])तथा(?=\\s|[।,;:\\(\\)])`, "g"), "$1 तथा");
  t = t.replace(new RegExp(`(${B})तथा([${D}])`, "g"), "$1तथा $2");

  // वा (or) — rarely part of a word
  t = t.replace(new RegExp(`([${D}])वा([${D}])`, "g"), "$1 वा $2");
  t = t.replace(new RegExp(`([${D}])वा(?=\\s|[।,;:\\(\\)])`, "g"), "$1 वा");
  t = t.replace(new RegExp(`(${B})वा([${D}])`, "g"), "$1वा $2");

  // ---- Pass 2: Multi-character postpositions — split after ----
  const multiPost = [
    "द्वारा", "मार्फत", "अनुसार", "भित्र", "बाट",
    "लाई", "सम्म", "देखि", "सँग", "संग",
    "सहित", "बिना", "विना", "तर्फ", "माथि",
    "मुनि", "अगाडि", "पछाडि", "पछि", "अघि",
    "साथ", "बारे", "निमित्त", "निम्ति", "कारण",
    "बाहेक",
  ];
  for (const p of multiPost) {
    t = t.replace(new RegExp(`([${D}])${p}([${D}])`, "g"), `$1${p} $2`);
  }

  // ---- Pass 3: Two-character postpositions — split after ----
  // को (of) — almost always a postposition when followed by another word
  t = t.replace(new RegExp(`([${D}])को([${D}])`, "g"), "$1को $2");
  // ले (by/with) — almost always a postposition
  t = t.replace(new RegExp(`([${D}])ले([${D}])`, "g"), "$1ले $2");
  // मा (in/on/at) — usually a postposition
  t = t.replace(new RegExp(`([${D}])मा([${D}])`, "g"), "$1मा $2");
  // का/की (of, plural) — split before most consonants, except र (avoid कार्य/कारण)
  // also exclude म (avoid काम) and न (avoid कानुन)
  const consNoRa = "([कखगघङचछजझञटठडढणतथदधपफबभयलवशषसह])";
  t = t.replace(new RegExp(`([${D}])का${consNoRa}`, "g"), "$1का $2");
  t = t.replace(new RegExp(`([${D}])की${consNoRa}`, "g"), "$1की $2");

  // ---- Pass 4: हरू (plural suffix) — often gets glued ----
  t = t.replace(new RegExp(`([${D}])हरू([${D}])`, "g"), "$1हरू $2");

  // ---- Pass 5: Common verb participles that should split ----
  // Don't split before छ (forms future tense: हुनेछ = will be)
  const verbPart = "हुने|गर्ने|पर्ने|सक्ने|दिने|लिने";
  t = t.replace(new RegExp(`([${D}])(${verbPart})(?!छ)([${D}])`, "g"), "$1$2 $3");
  t = t.replace(new RegExp(`(${B})(${verbPart})(?!छ)([${D}])`, "g"), "$1$2 $3");

  // ---- Pass 6: Specific word-boundary fixes ----
  // यो (this/demonstrative) — only at word start (avoids splitting internal यो e.g. प्रयोग)
  // Exclude valid यो- words: योग्य, योजना, योद्धा, योज्य, योग (when at word end)
  const yoAll = "([कखगघङचछजझञटठडढणतथदधनपफबभमयलवशषसहअआइईउऊएऐओऔ])";
  const yoExcl = "(?!ग्य|जन|द्ध|ज्य|क्त|ग(?![\u0900-\u097F]))";
  t = t.replace(new RegExp(`(${B})यो${yoExcl}${yoAll}`, "g"), "$1यो $2");

  // पूरा (complete) — split when followed by common verb starters
  t = t.replace(new RegExp(`पूरा([कगघचजटठडणतदधनपफबमयलवशषसह])`, "g"), "पूरा $1");

  // व्यक्ति (person) — only split before clear word-starters (not त which forms व्यक्तित्व)
  t = t.replace(new RegExp(`व्यक्ति([सपबमयलवह])`, "g"), "व्यक्ति $1");

  // सो (that demonstrative) — split before शब्द, सम्बन्ध, समय, सन्दर्भ etc.
  t = t.replace(new RegExp(`सो([शस])`, "g"), "सो $1");

  // ---- Pass 7: Remove doubled spaces ----
  t = t.replace(/  +/g, " ");

  return t.trim();
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  const isResume = process.argv.includes("--resume");

  let done: number[] = [];
  if (isResume && fs.existsSync(PROGRESS_FILE)) {
    done = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  }

  const allProvisions = db
    .prepare("SELECT id, text FROM provisions ORDER BY id")
    .all() as any[];

  let todo = allProvisions.filter((p: any) => !done.includes(p.id));
  let skippedTariff = 0;
  let skippedClean = 0;

  const filtered: any[] = [];
  for (const p of todo) {
    if (isTariffTable(p.text as string)) {
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

  console.log(`Provisions: ${allProvisions.length}`);
  console.log(`  - Already done: ${done.length}`);
  console.log(`  - Skipped (tariff): ${skippedTariff}`);
  console.log(`  - Skipped (clean): ${skippedClean}`);
  console.log(`  - To process: ${todo.length}`);
  console.log();

  if (todo.length === 0) {
    console.log("No provisions need fixing.");
    return;
  }

  let fixed = 0;
  let unchanged = 0;
  const updateStmt = db.prepare("UPDATE provisions SET text = ? WHERE id = ?");

  for (const p of todo) {
    const original = p.text as string;
    const fixedText = fixSpacing(original);

    if (fixedText !== original) {
      if (!isDryRun) {
        updateStmt.run(fixedText, p.id);
      }
      done.push(p.id);
      fixed++;
    } else {
      unchanged++;
    }

    if ((fixed + unchanged) % 50 === 0) {
      console.log(`Processed ${fixed + unchanged}/${todo.length} (fixed: ${fixed})...`);
    }
  }

  console.log(`\nDone. Fixed: ${fixed}, Unchanged: ${unchanged}`);

  if (!isDryRun) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(done));
    console.log("Rebuilding FTS5 index...");
    db.exec("INSERT INTO provisions_fts(provisions_fts) VALUES('rebuild')");
    console.log("FTS5 index rebuilt.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
