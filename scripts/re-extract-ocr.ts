import Database from "better-sqlite3";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const db = new Database("data/nepal-law.db");

function findTool(bin: string): string | null {
  const knownPaths: Record<string, string[]> = {
    "tesseract.exe": [
      join("C:", "Program Files", "Tesseract-OCR", "tesseract.exe"),
      join("C:", "Program Files (x86)", "Tesseract-OCR", "tesseract.exe"),
    ],
  };
  for (const p of knownPaths[bin] || []) {
    if (existsSync(p)) return p;
  }
  // Search PATH
  try {
    const found = execSync(`where ${bin}`, { encoding: "utf8", timeout: 5000 }).trim().split("\n")[0];
    if (found && existsSync(found)) return found;
  } catch { /* not in PATH */ }
  // Search WinGet packages
  const wingetDir = join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet");
  if (existsSync(wingetDir)) {
    try {
      const psCmd = `powershell -Command "Get-ChildItem -Path '${wingetDir}' -Recurse -Filter '${bin}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName"`;
      const result = execSync(psCmd, { encoding: "utf8", timeout: 15000 });
      const line = result.trim();
      if (line && existsSync(line)) return line;
    } catch { /* not found */ }
  }
  return null;
}

function cleanNepaliText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[''']/g, "'")
    .replace(/["""]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[•●]/g, "•")
    .replace(/([^\n])\n(?=[^\n])/g, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(\S) (?=[\u093F\u0940\u0941\u0942\u0943\u0944])/g, "$1")
    .replace(/([\u094D]\s)(?=\S)/g, (m) => m.replace(/\s/g, ""))
    .replace(/^(?:[\s\)\]\>\)\●\•]+)/gm, "")
    .replace(/([a-zA-Z])\s+(?=[\u0900-\u097F])/g, "$1")
    .trim();
}

function splitIntoSections(text: string): { section_number: string; section_title: string; text: string }[] {
  const sections: { section_number: string; section_title: string; text: string }[] = [];
  const lines = text.split("\n");
  let currentSection: string[] = [];
  let currentNum = "";
  let currentTitle = "";
  let inPreamble = true;
  let chapterHeader = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { currentSection.push(line); continue; }

    // Skip amendment preamble lines
    if (inPreamble) {
      const preamblePatterns = [
        /^\d+\.\s*परिच्छेद/i, /^परिच्छेद-\d+/i, /^परिच्छेद\s*\d+/i,
        /^प्रारम्भ/i, /^संशोधन/i, /^\d+\)\s*[०-९]{4}/, /^\d+[\/\.]\d+[\/\.]\d+/,
        /^\d+\)\s*$/, /^\([०-९]+\)\s*$/, /^\d{4}\.\d{1,2}\.\d{1,2}/,
        /^[०-९]{4}[\/\.][०-९]{1,2}[\/\.][०-९]{1,2}/,
      ];
      const isPreamble = preamblePatterns.some(p => p.test(trimmed));
      if (isPreamble) continue;
      inPreamble = false;
    }

    // Chapter/paragraph headers
    const chMatch = trimmed.match(/^(परिच्छेद|भाग|अध्याय)[\s-]*(\d+|[०-९]+)/);
    if (chMatch) {
      if (currentSection.length > 0) {
        const txt = currentSection.join("\n").trim();
        if (txt.length >= 30) {
          sections.push({ section_number: currentNum || chapterHeader, section_title: currentTitle, text: txt });
        }
      }
      chapterHeader = chMatch[0];
      currentNum = "";
      currentTitle = chMatch[0];
      currentSection = [trimmed];
      continue;
    }

    // Section header: "१." or "१)" or "१ ।" etc.
    const secMatch = trimmed.match(/^([०-९]+)[\.\)\s]\s*(.*)/);
    if (secMatch) {
      const secNum = secMatch[1];
      const secTitle = secMatch[2].trim();

      // Skip tariff codes (HS codes like 1404.90.80)
      if (/^\d{4}\.\d{2}\.\d{2}/.test(trimmed)) {
        currentSection.push(line); continue;
      }

      if (currentSection.length > 0) {
        const txt = currentSection.join("\n").trim();
        if (txt.length >= 30) {
          sections.push({ section_number: currentNum || chapterHeader, section_title: currentTitle, text: txt });
        }
      }
      currentNum = secNum;
      currentTitle = secTitle;
      currentSection = [trimmed];
      continue;
    }

    currentSection.push(line);
  }

  if (currentSection.length > 0) {
    const txt = currentSection.join("\n").trim();
    if (txt.length >= 30) {
      sections.push({ section_number: currentNum || chapterHeader, section_title: currentTitle, text: txt });
    }
  }

  return sections;
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [5000, 15000, 30000];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        console.error(`[download] HTTP ${resp.status}, attempt ${attempt + 1}/${MAX_RETRIES + 1}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
        return null;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      console.error(`[download] ${buf.length} bytes`);
      return buf;
    } catch (err: any) {
      console.error(`[download] ${err.cause?.code || err.message}, attempt ${attempt + 1}/${MAX_RETRIES + 1}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      } else {
        return null;
      }
    }
  }
  return null;
}

async function ocrPdf(pdfUrl: string, tmpId: number): Promise<string | null> {
  const popplerBin = findTool("pdftoppm");
  const tesseractBin = findTool("tesseract.exe");
  if (!popplerBin || !tesseractBin) {
    console.error("[ocr] Tools not found:", { poppler: !!popplerBin, tesseract: !!tesseractBin });
    return null;
  }

  const tmpDir = join(tmpdir(), `nepal-law-ocr-${tmpId}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Download PDF to temp file
    const pdfBuf = await downloadPdf(pdfUrl);
    if (!pdfBuf) return null;

    const pdfPath = join(tmpDir, "input.pdf");
    writeFileSync(pdfPath, pdfBuf);

    // Get page count
    let pageCnt = 0;
    const popplerDir = popplerBin.replace(/pdftoppm\.exe$/i, "");
    const pdfinfoBin = join(popplerDir, "pdfinfo.exe");
    if (existsSync(pdfinfoBin)) {
      try {
        const info = execSync(`"${pdfinfoBin}" "${pdfPath}"`, { encoding: "utf8", timeout: 15000 });
        const m = info.match(/Pages:\s*(\d+)/i);
        if (m) pageCnt = parseInt(m[1]);
      } catch { /* ignore */ }
    }
    if (!pageCnt) pageCnt = 0;

    // Convert PDF to images using spawn (non-blocking)
    console.error(`[ocr] Rendering ${pageCnt} pages with pdftoppm (150 DPI)...`);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(popplerBin, ["-r", "150", "-png", pdfPath, join(tmpDir, "page")], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600_000,
      });
      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pdftoppm exited ${code}: ${stderr.slice(0, 200)}`));
      });
      proc.on("error", reject);
    });

    // Find page images (pdftoppm may use 2 or 3 digit zero-padding)
    const pageFiles: string[] = [];
    for (let i = 0; ; i++) {
      const f2 = join(tmpDir, `page-${String(i + 1).padStart(2, "0")}.png`);
      const f3 = join(tmpDir, `page-${String(i + 1).padStart(3, "0")}.png`);
      const f0 = join(tmpDir, `page-${i + 1}.png`);
      if (existsSync(f2)) pageFiles.push(f2);
      else if (existsSync(f3)) pageFiles.push(f3);
      else if (existsSync(f0)) pageFiles.push(f0);
      else break;
    }

    if (pageFiles.length === 0) {
      console.error(`[ocr] No page images generated`);
      return null;
    }
    console.error(`[ocr] ${pageFiles.length} pages to OCR`);

    // Find TESSDATA
    const tessdataDir = (() => {
      const p = process.env.TESSDATA_PREFIX;
      if (p && existsSync(p)) return p;
      const tessDir = join(dirname(tesseractBin), "..", "share", "tessdata");
      if (existsSync(tessDir)) return tessDir;
      const altDir = join(dirname(tesseractBin), "tessdata");
      if (existsSync(altDir)) return altDir;
      return null;
    })();

    // OCR each page
    console.error(`[ocr] ${pageFiles.length} pages, OCR starting...`);
    let fullText = "";
    for (let p = 0; p < pageFiles.length; p++) {
      try {
        const pageText = execSync(`"${tesseractBin}" "${pageFiles[p]}" stdout -l nep`, {
          timeout: 60_000,
          encoding: "utf8",
          maxBuffer: 50 * 1024 * 1024,
          env: { ...process.env, ...(tessdataDir ? { TESSDATA_PREFIX: tessdataDir } : {}) },
        });
        fullText += pageText + "\n";
      } catch (e: any) {
        console.error(`[ocr] Page ${p + 1} failed: ${e.message}`);
      }
      if (p % 5 === 0) process.stderr.write(`  [ocr] page ${p + 1}/${pageFiles.length}...\n`);
    }

    return fullText;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function checkTextQuality(text: string): { quality: string; detail: string } {
  const devanagariChars = text.match(/[\u0900-\u097F]/g);
  const devRatio = devanagariChars ? devanagariChars.length / text.length : 0;
  const legalWords = ["ऐन", "नियम", "बमोजिम", "व्यवस्था", "प्रारम्भ", "संशोधन"];
  const foundWords = legalWords.filter(w => text.includes(w));
  const quality = foundWords.length >= 2 && devRatio >= 0.3 ? "verified" : "low_confidence";
  return { quality, detail: JSON.stringify({ words: `${foundWords.length}/6(${foundWords.join(",")})`, devRatio: devRatio.toFixed(2) }) };
}

function detectArtifacts(text: string): boolean {
  // pdfjs artifact: space before Devanagari vowel sign (matra) mid-word
  // e.g., "सम िनुपछि" instead of "सम्झनुपर्छ"
  // Match: Devanagari char + space + matra, or space + matra mid-word
  const matraAfterSpace = /\s[\u093F-\u0944\u0947-\u0950]/;
  // Also check: consonant + space + matra (more specific)
  const consonantSpaceMatra = /[\u0915-\u0954]\s[\u093F-\u0944\u0947-\u0950]/;
  return matraAfterSpace.test(text) && consonantSpaceMatra.test(text);
}

async function reExtractOne(statuteId: number): Promise<{ success: boolean; before: number; after: number; error?: string }> {
  const st = db.prepare("SELECT * FROM statutes WHERE id = ?").get(statuteId) as any;
  if (!st || !st.source_url) return { success: false, before: 0, after: 0, error: "No source_url" };

  // Count existing provisions
  const before = (db.prepare("SELECT COUNT(*) AS c FROM provisions WHERE statute_id = ?").get(statuteId) as any).c;

  // Delete existing provisions
  db.prepare("DELETE FROM provisions WHERE statute_id = ?").run(statuteId);

  // Run OCR
  const ocrRaw = await ocrPdf(st.source_url, statuteId);
  if (!ocrRaw) {
    console.error(`  OCR failed for ${st.title_en}`);
    return { success: false, before, after: 0, error: "OCR failed" };
  }

  const cleaned = cleanNepaliText(ocrRaw);
  const sections = splitIntoSections(cleaned);

  // Check quality
  const { quality } = checkTextQuality(cleaned);

  // Insert provisions
  let inserted = 0;
  const insertStmt = db.prepare(
    "INSERT INTO provisions (statute_id, section_number, section_title, text) VALUES (?, ?, ?, ?)"
  );
  const txn = db.transaction(() => {
    for (const sec of sections) {
      insertStmt.run(statuteId, sec.section_number, sec.section_title, sec.text);
      inserted++;
    }
  });
  txn();

  // Update quality
  const qualityDetail = JSON.stringify({ method: "ocr", quality, reason: "forced-ocr re-extraction" });
  db.prepare("UPDATE statutes SET quality = ?, quality_detail = ? WHERE id = ?").run(quality, qualityDetail, statuteId);

  return { success: true, before, after: inserted };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--all-pdfjs")) {
    // Find all pdfjs-extracted acts
    const allActs = db.prepare(`
      SELECT id, title_np, title_en, quality, (SELECT COUNT(*) FROM provisions WHERE statute_id = statutes.id) AS pcount
      FROM statutes
      WHERE json_extract(quality_detail, '$.method') = 'pdfjs'
      ORDER BY id
    `).all() as any[];

    console.log(`Found ${allActs.length} pdfjs-extracted acts`);
    console.log("");

    // Check each for artifacts (sample first 1000 chars of provisions)
    const affected: any[] = [];
    const clean: string[] = [];
    for (const act of allActs) {
      const sample = db.prepare("SELECT text FROM provisions WHERE statute_id = ? LIMIT 5").all(act.id) as any[];
      const sampleText = sample.map((s: any) => s.text).join(" ").slice(0, 3000);
      if (detectArtifacts(sampleText)) {
        affected.push(act);
      } else {
        clean.push(act.title_np);
      }
    }

    console.log(`Acts with artifacts: ${affected.length}`);
    console.log(`Clean pdfjs acts (skipping): ${clean.length}`);
    if (clean.length > 0) console.log(`  ${clean.join(", ")}`);
    console.log("");

    // Process affected acts
    let successCount = 0;
    let failCount = 0;
    let totalBefore = 0;
    let totalAfter = 0;
    const failures: string[] = [];

    for (let i = 0; i < affected.length; i++) {
      const act = affected[i];
      process.stderr.write(`[${i + 1}/${affected.length}] Processing: ${act.title_en}...\n`);

      const result = await reExtractOne(act.id);
      if (result.success) {
        successCount++;
        totalBefore += result.before;
        totalAfter += result.after;
        const diff = result.after - result.before;
        process.stderr.write(`[${i + 1}/${affected.length}] ${act.title_en}: ${result.before} → ${result.after} provisions (${diff >= 0 ? "+" : ""}${diff})\n`);
      } else {
        failCount++;
        totalBefore += result.before;
        failures.push(`${act.title_en} (id=${act.id}): ${result.error}`);
        process.stderr.write(`[${i + 1}/${affected.length}] FAILED: ${act.title_en} — ${result.error}\n`);
      }
    }

    console.log("\n=== Summary ===");
    console.log(`Acts processed: ${successCount}/${affected.length}`);
    console.log(`Skipped (clean pdfjs, no artifacts): ${clean.length}`);
    console.log(`Failed: ${failCount}`);
    console.log(`Provisions before: ${totalBefore}`);
    console.log(`Provisions after: ${totalAfter}`);
    console.log(`Net change: ${totalAfter - totalBefore >= 0 ? "+" : ""}${totalAfter - totalBefore}`);
    if (failures.length > 0) {
      console.log("\nFailures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
  } else {
    // Original behavior: process single hardcoded act
    const statuteId = 12;
    const st = db.prepare("SELECT * FROM statutes WHERE id = ?").get(statuteId) as any;
    if (!st || !st.source_url) {
      console.error("Statute not found or no source_url:", statuteId);
      process.exit(1);
    }
    const before = (db.prepare("SELECT COUNT(*) AS c FROM provisions WHERE statute_id = ?").get(statuteId) as any).c;
    console.log(`Re-extracting: ${st.title_np}`);
    console.log(`  Source: ${st.source_url}`);
    console.log(`  Existing provisions: ${before}`);

    const result = await reExtractOne(statuteId);
    if (!result.success) {
      console.error(`  ${result.error}`);
      process.exit(1);
    }
    console.log(`  Done: ${result.before} → ${result.after} provisions`);
  }
}

main().catch(console.error);
