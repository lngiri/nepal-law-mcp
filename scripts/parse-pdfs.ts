#!/usr/bin/env node

import * as cheerio from "cheerio";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { getDb, insertProvision, rebuildFtsIndex, updateStatuteQuality } from "../src/db.js";
import type { Statute, TextQuality } from "../src/types.js";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PDF_DELAY_MS = 5_000;
const BATCH_SIZE = 25;
const BATCH_PAUSE_MS = 60_000;

const MAX_RETRIES = 3;
const RETRY_DELAYS = [5_000, 15_000, 30_000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CategoryEntry {
  titleNp: string;
  pdfUrl: string;
}

function normalize(str: string): string {
  return str.replace(/\s+/g, " ").replace(/[\u200C\u200D]/g, "").trim();
}

function titleSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const short = na.length <= nb.length ? na : nb;
  const long = na.length > nb.length ? na : nb;
  if (long.includes(short)) return 0.9;
  const aWords = new Set(na.replace(/[,\s]+/g, " ").split(" "));
  const bWords = nb.replace(/[,\s]+/g, " ").split(" ");
  const matches = bWords.filter((w) => aWords.has(w)).length;
  return matches / Math.max(aWords.size, bWords.length);
}

async function fetchCategoryPdfs(categoryUrl: string): Promise<CategoryEntry[]> {
  const url = categoryUrl.startsWith("http")
    ? categoryUrl
    : `https://lawcommission.gov.np${categoryUrl.startsWith("/") ? "" : "/"}${categoryUrl}`;

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    console.error(`  [category] HTTP ${resp.status} for ${url}`);
    return [];
  }

  const html = await resp.text();
  const $ = cheerio.load(html);
  const entries: CategoryEntry[] = [];

  $("table tbody tr, .table tbody tr, table tr, .category-list tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;

    let pdfUrl = "";
    cells.each((_, cell) => {
      const link = $(cell).find("a[href$='.pdf'], a[href*='.pdf']").first().attr("href");
      if (link) pdfUrl = link.startsWith("http") ? link : `https://lawcommission.gov.np${link}`;
    });

    if (!pdfUrl) return;

    const titleNp = normalize($(cells[1]).text());
    if (!titleNp || titleNp.length < 3) return;

    if (/^\d+$/.test(titleNp) || /^(क्रस|sn|s\.n)/i.test(titleNp)) return;

    entries.push({ titleNp, pdfUrl });
  });

  if (entries.length === 0) {
    $("a[href$='.pdf'], a[href*='.pdf']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const pdfUrl = href.startsWith("http") ? href : `https://lawcommission.gov.np${href}`;
      const parentText = normalize($(el).parent().text());
      const gpText = normalize($(el).parent().parent().text());
      const titleNp = gpText.length > parentText.length ? gpText : parentText;
      if (titleNp && titleNp.length > 3) {
        entries.push({ titleNp, pdfUrl });
      }
    });
  }

  return entries;
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        console.error(`  [pdf] HTTP ${resp.status}${attempt < MAX_RETRIES ? `, retry ${attempt}/${MAX_RETRIES}...` : ""}`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAYS[attempt - 1]);
          continue;
        }
        return null;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 100) {
        console.error(`  [pdf] Too small (${buf.length} bytes)${attempt < MAX_RETRIES ? `, retry ${attempt}/${MAX_RETRIES}...` : ""}`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAYS[attempt - 1]);
          continue;
        }
        return null;
      }
      return buf;
    } catch (err) {
      const msg = (err as Error).message;
      const isRetryable = msg.includes("ETIMEDOUT") || msg.includes("fetch failed") || msg.includes("network") || msg.includes("abort");
      if (isRetryable && attempt < MAX_RETRIES) {
        console.error(`  [pdf] ${msg} — retry ${attempt}/${MAX_RETRIES} in ${RETRY_DELAYS[attempt - 1] / 1000}s...`);
        await sleep(RETRY_DELAYS[attempt - 1]);
        continue;
      }
      console.error(`  [pdf] Download failed: ${msg}`);
      return null;
    }
  }
  return null;
}

function cleanNepaliText(text: string): string {
  let t = text;
  const halant = "\u094D";
  const vowelsigns = "\u093E\u093F\u0940\u0941\u0942\u0943\u0944\u0947\u0948\u094B\u094C";
  const consonants = "\u0915-\u0924\u0925-\u0930\u0932-\u0939\u0918";
  const fullRange = "\u0904-\u0939";

  // 1. Remove spaces before vowel signs (i-matra, e-matra, etc.) preceded by a consonant
  t = t.replace(new RegExp(`([${consonants}])[ \\t\\u200C\\u200D]+([${vowelsigns}])`, "g"), "$1$2");

  // 2. Remove space after halant (conjunct break): ् + space + consonant
  t = t.replace(new RegExp(`${halant}[ \\t\\u200C\\u200D]+([${fullRange}])`, "g"), `${halant}$1`);

  // 3. Remove space within conjunct: consonant + space + ्
  t = t.replace(new RegExp(`([${consonants}])[ \\t\\u200C\\u200D]+${halant}`, "g"), `$1${halant}`);

  // 4. Remove space before anusvara (ं) or visarga (ः)
  t = t.replace(new RegExp(`([${fullRange}])[ \\t\\u200C\\u200D]+([\u0902\u0903])`, "g"), "$1$2");

  // 5. Remove space within Nepali digits:
  t = t.replace(/([०-९])[ \t\u200C\u200D]+(?=[०-९])/g, "$1");
  t = t.replace(/(\d)[ \t\u200C\u200D]+(?=\d)/g, "$1");

  // 6. Remove solitary halant at word boundaries
  t = t.replace(new RegExp(`${halant}[ \\t,;:\\n\\r]+`, "g"), " ");

  // 7. Remove trailing halant before newline
  t = t.replace(new RegExp(`${halant}\\n`, "g"), "\n");

  // 8. Remove spaces between a matra and the next consonant (e.g., "ि त" → "ित")
  t = t.replace(new RegExp(`([${vowelsigns}])[ \\t\\u200C\\u200D]+([${fullRange}])`, "g"), "$1$2");

  // 9. Collapse multiple spaces
  t = t.replace(/[ \t\u200C\u200D]{2,}/g, " ");

  // 10. Clean up leading/trailing whitespace per line
  t = t.replace(/^[ \t]+/gm, "").replace(/[ \t]+$/gm, "");

  return t.trim();
}

function extractYearFromTitle(titleNp: string): string | null {
  const NEPALI_DIGITS: Record<string, string> = {
    "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
    "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
  };
  const eng = titleNp.replace(/[०-९]/g, (d) => NEPALI_DIGITS[d] ?? d);
  const m = eng.match(/(?:20\d{2}|19\d{2})/);
  return m ? m[0] : null;
}

async function validatePdfTitle(
  pdfUrl: string,
  expectedTitleNp: string,
  preferOcr = false,
): Promise<{ valid: boolean; extractedTitle: string; method: string }> {
  const resp = await fetch(pdfUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) return { valid: false, extractedTitle: "", method: "download_failed" };
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 100) return { valid: false, extractedTitle: "", method: "too_small" };

  function titleMatchRatio(text: string): { ratio: number; titleWords: string[] } {
    const norm = normalize(text);
    const titleWords = normalize(expectedTitleNp)
      .replace(/[,;]\s*[\u0966-\u096F\u0030-\u0039]+\s*$/, "")
      .replace(/\s*ऐन$/, "")
      .split(" ")
      .filter((w) => w.length > 2);
    const matches = titleWords.filter((w) => norm.includes(w)).length;
    const ratio = titleWords.length > 0 ? matches / titleWords.length : 0;
    return { ratio, titleWords };
  }

  async function tryOcr(): Promise<{ extractedTitle: string } | null> {
    const tessdataDir = join(__dirname, "..", "..", "tessdata");
    if (!existsSync(tessdataDir) || !existsSync(join(tessdataDir, "nep.traineddata"))) return null;
    const tesseractBin = findTool("tesseract.exe");
    const popplerBin = findTool("pdftoppm.exe");
    if (!tesseractBin || !popplerBin) return null;
    const tmpDir = join(tmpdir(), `nepal-validate-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const pdfPath = join(tmpDir, "input.pdf");
      writeFileSync(pdfPath, buf);
      execSync(`"${popplerBin}" -r 300 -png -f 1 -l 1 "${pdfPath}" "${join(tmpDir, "page")}"`, { timeout: 60_000, stdio: "pipe" });
      const png0 = join(tmpDir, "page-01.png");
      const png1 = join(tmpDir, "page-1.png");
      const pngFile = existsSync(png0) ? png0 : existsSync(png1) ? png1 : null;
      if (!pngFile) return null;
      const ocrText = execSync(`"${tesseractBin}" "${pngFile}" stdout -l nep`, {
        timeout: 60_000, encoding: "utf8",
        env: { ...process.env, TESSDATA_PREFIX: tessdataDir },
      });
      const trimmed = ocrText.trim();
      if (trimmed.length <= 20) return null;
      return { extractedTitle: trimmed.slice(0, 200) };
    } catch { return null; }
    finally { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ } }
  }

  // If OCR-prefer mode, try OCR first
  if (preferOcr) {
    const ocrResult = await tryOcr();
    if (ocrResult) {
      const { ratio } = titleMatchRatio(ocrResult.extractedTitle);
      if (ratio >= 0.4) return { valid: true, extractedTitle: ocrResult.extractedTitle, method: "ocr" };
    }
  }

  // Extract first-page text via pdfjs-dist
  try {
    const loadingTask = getDocument({ data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), verbosity: 0 });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const tc = await page.getTextContent();
    const firstPageItems: string[] = [];
    for (const rawItem of tc.items) {
      if ("str" in rawItem && "transform" in rawItem) {
        const item = rawItem as { str: string; transform: number[] };
        firstPageItems.push(item.str);
      }
    }
    const pageText = firstPageItems.join(" ");

    if (pageText.length > 20) {
      const { ratio } = titleMatchRatio(pageText);
      if (ratio >= 0.4) {
        return { valid: true, extractedTitle: pageText.slice(0, 200), method: "pdfjs" };
      }
      // pdfjs text found but garbled — fall through to OCR
    }
  } catch { /* pdfjs failed */ }

  // Try OCR fallback (if not already tried in preferOcr mode)
  if (!preferOcr) {
    const ocrResult = await tryOcr();
    if (ocrResult) {
      const { ratio } = titleMatchRatio(ocrResult.extractedTitle);
      if (ratio >= 0.4) return { valid: true, extractedTitle: ocrResult.extractedTitle, method: "ocr" };
    }
  }

  return { valid: false, extractedTitle: "", method: "all_failed" };
}

async function extractPdfText(buf: Buffer): Promise<string | null> {
  try {
    const loadingTask = getDocument({ data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), verbosity: 0 });
    const pdf = await loadingTask.promise;
    const allLines: string[] = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();

      // Group items by rounded Y position (same line)
      const lineMap = new Map<number, { str: string; x: number; width: number }[]>();
      for (const rawItem of tc.items) {
        if (!("transform" in rawItem) || !("str" in rawItem)) continue;
        const item = rawItem as { str: string; transform: number[]; width: number };
        const y = Math.round(item.transform[5]);
        const x = item.transform[4];
        if (!lineMap.has(y)) lineMap.set(y, []);
        lineMap.get(y)!.push({ str: item.str, x, width: item.width });
      }

      // Sort lines top-to-bottom (PDF Y is bottom-up, so descending)
      const sortedY = [...lineMap.keys()].sort((a, b) => b - a);
      for (const y of sortedY) {
        const items = lineMap.get(y)!;
        // Keep items in content-stream order (NOT X-sorted) for Devanagari correctness
        // Just join with smart spacing based on X gaps
        let line = "";
        let lastX = 0;
        let lastStr = "";
        for (const item of items) {
          const gap = item.x - lastX;
          const needsSpace = gap > 15 && lastX > 0;
          // Don't add space if current item is a vowel sign (matra)
          // and previous item ends with a consonant
          const isMatra = /^[\u093B-\u094C\u094E\u094F]/.test(item.str);
          const prevEndsConsonant = /[\u0900-\u0939\u0958-\u095F]$/.test(lastStr);
          if (needsSpace && !(isMatra && prevEndsConsonant)) {
            line += " ";
          }
          line += item.str;
          lastX = item.x + (item.width || 0);
          lastStr = item.str;
        }
        allLines.push(line);
      }
    }

    const result = allLines.join("\n");
    if (!result || result.length < 50) return null;

    // Apply Nepali text cleanup
    return cleanNepaliText(result);
  } catch (err) {
    console.error(`  [pdf] Parse failed: ${(err as Error).message}`);
    return null;
  }
}

interface ParsedSection {
  section_number: string | null;
  section_title: string | null;
  text: string;
}

function stripPageMarkers(text: string): string {
  return text
    .replace(/www\.lawcommission\.gov\.np\s*/g, "")
    .replace(/--\s*\d+\s+of\s+\d+\s*--/g, "")
    .replace(/^\s*\d+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isAmendmentListItem(title: string): boolean {
  if (!title) return false;
  // Check for Nepali date pattern (। separators) — strong indicator of amendment list items
  if (/[\u0966-\u096F]+\u0964[\u0966-\u096F]+/.test(title)) return true;
  const amendmentPatterns = [
    /लाई\s*संशोधन/,
    /संशोधन\s*गर्ने\s*ऐन/,
    /संशोधन\s*ग(र्)?ने\s*ऐन/,
    /शोषणविरुद्धको\s*ऐन/,
    /फौजदारी\s*कसुर\s*संहिता/,
    /देश\s*व्यापी/,
    /अधिकार\s*ऐन/,
    /प्रतिनिधि\s*सभा/,
    /गणतन्त्र\s*सुदृढीकरण/,
    /राष्ट्रिय\s*सभा/,
    /नेपाल\s*कानून/,
    /आम(थ|र्थ)िक\s*ऐन/,
    /केही\s*नेपाल\s*ऐन/,
    /विधायन\s*सम्बन्(ध|ि)/,
  ];
  return amendmentPatterns.some((p) => p.test(title));
}

function splitIntoSections(text: string): ParsedSection[] {
  const cleaned = stripPageMarkers(text);

  const chapterPattern = /^(?:पररच् छेि|परिच्छेद)\s*[–\-]\s*(\d+)\s*$/gm;
  const sectionPattern = /^([०-९]+|\d+)\s*\.\s*/gm;

  const splitPoints: { position: number; number: string; title: string }[] = [];

  let match: RegExpExecArray | null;
  while ((match = chapterPattern.exec(cleaned)) !== null) {
    splitPoints.push({
      position: match.index,
      number: `Chapter ${match[1]}`,
      title: cleaned.substring(match.index, match.index + match[0].length).replace(/\s+/g, " ").trim(),
    });
  }

  while ((match = sectionPattern.exec(cleaned)) !== null) {
    const lineStart = cleaned.lastIndexOf("\n", match.index) + 1;
    const lineEnd = cleaned.indexOf("\n", match.index);
    const line = cleaned.substring(lineStart, lineEnd >= 0 ? lineEnd : cleaned.length).trim();

    // Skip chapter headers (already captured above)
    if (/^(?:पररच् छेि|परिच्छेद)/.test(line)) continue;
    // Skip very short lines (likely page remnants)
    if (line.length < 5 && /^\d+\s*\.\s*$/.test(line)) continue;

    const sectionNum = match[1];
    const rest = line.replace(/^[०-९\d]+\s*\.\s*/, "").trim();

    // -----------------------------------------------------------------------
    // FILTER 1: Reject tariff codes (Harmonized System codes like 1404.90.80)
    // These have pattern: NNNN.NN.NN or NNNN.NN at line start
    // -----------------------------------------------------------------------
    const afterNumber = line.substring(match[0].length).trim();
    // Check full line: starts with digits + dot + more digits (tariff schedule)
    const d = "\\d०-९";
    const isTariffLine = new RegExp(`^[${d}]{2,4}\\.\\s*[${d}]{2}(\\.\\s*[${d}]{2})?(\\s|–|-|$)`).test(line);
    // Check after-number: starts with digit(s) + dot + digit(s) (tariff continuation)
    const isTariffContinuation = new RegExp(`^[${d}]+\\.\\s*[${d}]+`).test(afterNumber);
    if (isTariffLine || isTariffContinuation) {
      continue;
    }

    // -----------------------------------------------------------------------
    // FILTER 2: Reject date-like patterns (amendment dates)
    // Nepali dates look like २०७५।६।२ or 2075.6.2
    // -----------------------------------------------------------------------
    const isDatePattern = /^[\d०-९]+\.[\d०-९]+\.[\d०-९]+/.test(line);
    if (isDatePattern) continue;

    // -----------------------------------------------------------------------
    // FILTER 3: Reject amendment list items
    // (Check both the title line and the first body line, because garbled
    //  text often splits amendment titles across consecutive lines)
    // -----------------------------------------------------------------------
    const firstBodyLine = cleaned.substring(lineEnd + 1, cleaned.indexOf("\n", lineEnd + 1)).trim();
    const combinedTitle = (rest + " " + firstBodyLine).trim();
    if (isAmendmentListItem(rest) || isAmendmentListItem(combinedTitle)) continue;

    // -----------------------------------------------------------------------
    // FILTER 4: Reject very short sections (< 30 chars)
    // -----------------------------------------------------------------------
    const fullSectionText = line + "\n" + (cleaned.substring(lineEnd + 1).split("\n\n")[0] || "");
    if (fullSectionText.length < 30) continue;

    splitPoints.push({
      position: match.index,
      number: sectionNum,
      title: rest,
    });
  }

  splitPoints.sort((a, b) => a.position - b.position);

  const sections: ParsedSection[] = [];
  for (let i = 0; i < splitPoints.length; i++) {
    const start = splitPoints[i].position;
    const end = i + 1 < splitPoints.length ? splitPoints[i + 1].position : cleaned.length;
    const body = cleaned.substring(start, end).trim();
    if (body.length > 20) {
      sections.push({
        section_number: splitPoints[i].number,
        section_title: splitPoints[i].title || null,
        text: body,
      });
    }
  }

  // Fallback: try inline दफा/धारा references
  if (sections.length === 0) {
    const inlinePattern = /(?:^|[।\n])\s*(दफा|धारा)\s*(\d+(?:\.\d+)?)\s*[\.\-–—\)]\s*/g;
    let inlineMatch: RegExpExecArray | null;
    let lastSec: { num: string; start: number } | null = null;

    while ((inlineMatch = inlinePattern.exec(cleaned)) !== null) {
      if (lastSec) {
        const body = cleaned.substring(lastSec.start, inlineMatch.index + inlineMatch[0].length).trim();
        if (body.length > 20) {
          sections.push({ section_number: lastSec.num, section_title: null, text: body });
        }
      }
      lastSec = { num: inlineMatch[2], start: inlineMatch.index + inlineMatch[0].length };
    }
    if (lastSec) {
      const body = cleaned.substring(lastSec.start).trim();
      if (body.length > 20) {
        sections.push({ section_number: lastSec.num, section_title: null, text: body });
      }
    }
  }

  // If still nothing, insert whole text as one provision
  if (sections.length === 0) {
    const body = cleaned.trim();
    if (body.length > 20) {
      sections.push({ section_number: null, section_title: null, text: body });
    }
  }

  return sections;
}

function matchStatute(
  entry: CategoryEntry,
  statutes: Statute[]
): { statute: Statute; score: number } | undefined {
  const entryName = normalize(entry.titleNp);
  const cleanName = entryName.replace(/^[\d०-९]+\.\s*/, "");
  // Strip trailing year and "ऐन" for broader matching
  const strippedName = cleanName
    .replace(/[,;]\s*[\u0966-\u096F\u0030-\u0039]+\s*$/, "")
    .replace(/\s*ऐन$/, "")
    .trim();

  const candidates = statutes
    .map((s) => ({
      statute: s,
      score: Math.max(
        titleSimilarity(cleanName, normalize(s.title_np)),
        titleSimilarity(strippedName, normalize(s.title_np)),
        titleSimilarity(entryName, normalize(s.title_np))
      ),
    }))
    .filter((c) => c.score > 0.7)
    .sort((a, b) => b.score - a.score);

  return candidates[0];
}

async function loadAllCategoryMappings(statutes: Statute[]): Promise<Map<number, string>> {
  const catUrls = new Set<string>();
  const db = getDb();
  const rows = db.prepare("SELECT DISTINCT source_url FROM statutes WHERE source_url IS NOT NULL").all() as {
    source_url: string;
  }[];
  for (const r of rows) {
    if (r.source_url) catUrls.add(r.source_url);
  }

  const mapping = new Map<number, string>();
  const updateStmt = db.prepare("UPDATE statutes SET source_url = ? WHERE id = ? AND (source_url IS NULL OR source_url NOT LIKE '%.pdf')");
  let totalEntries = 0;
  let validated = 0;
  let rejected = 0;

  const persistBatch = db.transaction(() => {
    for (const [id, url] of mapping) {
      updateStmt.run(url, id);
    }
  });

  for (const catUrl of catUrls) {
    console.error(`[mapping] Fetching category: ${catUrl}`);
    const entries = await fetchCategoryPdfs(catUrl);
    console.error(`  Found ${entries.length} PDFs in category`);

    for (const entry of entries) {
      const match = matchStatute(entry, statutes);
      if (match && !mapping.has(match.statute.id)) {
        // Quick validation: check if entry title contains key statute words
        const entryNorm = normalize(entry.titleNp);
        const statuteNorm = normalize(match.statute.title_np);
        const sharedWords = statuteNorm.split(" ").filter(w => w.length > 2 && entryNorm.includes(w)).length;
        const statuteWords = statuteNorm.split(" ").filter(w => w.length > 2).length;
        const wordOverlap = statuteWords > 0 ? sharedWords / statuteWords : 0;
        
        if (wordOverlap >= 0.3 || match.score >= 0.85) {
          mapping.set(match.statute.id, entry.pdfUrl);
          totalEntries++;
          console.error(`  ✓ ${match.statute.title_np.slice(0, 50)} (score:${match.score.toFixed(2)}, words:${wordOverlap.toFixed(2)})`);
        } else {
          rejected++;
          console.error(`  ✗ REJECTED: ${entry.titleNp.slice(0, 50)} → ${match.statute.title_np.slice(0, 50)} (score:${match.score.toFixed(2)}, words:${wordOverlap.toFixed(2)})`);
        }
      }
    }

    await sleep(PDF_DELAY_MS);
  }

  // Persist all matched source_urls to DB
  persistBatch();
  console.error(`[mapping] Total matched: ${mapping.size} (rejected: ${rejected})`);
  return mapping;
}

const QUALITY_WORDS = ["ऐन", "नियम", "बमोजिम", "व्यवस्था", "प्रारम्भ", "संशोधन"];

function checkTextQuality(text: string, method = "pdfjs"): { quality: TextQuality; detail: string } {
  let found = 0;
  const foundWords: string[] = [];
  for (const w of QUALITY_WORDS) {
    if (text.includes(w)) {
      found++;
      foundWords.push(w);
    }
  }

  const sample = text.slice(0, 2000);
  const devChars = [...sample].filter((c) => c >= "\u0900" && c <= "\u097F").length;
  const totalChars = [...sample].filter((c) => !/\s/.test(c)).length;
  const devRatio = totalChars > 0 ? devChars / totalChars : 0;

  let quality: TextQuality;
  let reason: string;

  if (found >= 4 && devRatio > 0.5) {
    quality = "verified";
    reason = `words:${found}/${QUALITY_WORDS.length}(${foundWords.join(",")}), devRatio:${devRatio.toFixed(2)}`;
  } else if (found >= 2 && devRatio > 0.3) {
    quality = "low_confidence";
    reason = `words:${found}/${QUALITY_WORDS.length}(${foundWords.join(",")}), devRatio:${devRatio.toFixed(2)}`;
  } else {
    quality = "low_confidence";
    reason = `words:${found}/${QUALITY_WORDS.length}(${foundWords.join(",")}), devRatio:${devRatio.toFixed(2)} — likely garbled`;
  }

  return { quality, detail: JSON.stringify({ method, quality, reason }) };
}

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

  // Search winget packages using PowerShell's Get-ChildItem
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

async function ocrPdfWithPoppler(pdfUrl: string, statuteId: number): Promise<string | null> {
  const popplerBin = findTool("pdftoppm.exe");
  const tesseractBin = findTool("tesseract.exe");
  if (!popplerBin || !tesseractBin) {
    console.error(`  [ocr] Tools missing: poppler=${!!popplerBin}, tesseract=${!!tesseractBin}`);
    return null;
  }

  const tessdataDir = join(__dirname, "..", "..", "tessdata");
  if (!existsSync(tessdataDir) || !existsSync(join(tessdataDir, "nep.traineddata"))) {
    console.error(`  [ocr] tessdata/nep.traineddata not found`);
    return null;
  }

  const tmpDir = join(tmpdir(), `nepal-ocr-${statuteId}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    const pdfPath = join(tmpDir, "input.pdf");
    // Download PDF fresh to avoid any buffer-sharing issues
    const resp = await fetch(pdfUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) { console.error(`  [ocr] Download HTTP ${resp.status}`); return null; }
    const pdfBuf = Buffer.from(await resp.arrayBuffer());
    if (pdfBuf.length < 100) { console.error(`  [ocr] PDF too small (${pdfBuf.length} bytes)`); return null; }
    writeFileSync(pdfPath, pdfBuf);
    console.error(`  [ocr] PDF downloaded: ${pdfBuf.length} bytes`);
    execSync(`"${popplerBin}" -r 300 -png "${pdfPath}" "${join(tmpDir, "page")}"`, {
      timeout: 120_000, stdio: "pipe",
    });

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
      console.error(`  [ocr] No pages rendered`);
      return null;
    }

    console.error(`  [ocr] ${pageFiles.length} pages, OCR starting...`);
    let fullText = "";
    for (let p = 0; p < pageFiles.length; p++) {
      const pageText = execSync(`"${tesseractBin}" "${pageFiles[p]}" stdout -l nep`, {
        timeout: 60_000, encoding: "utf8",
        env: { ...process.env, TESSDATA_PREFIX: tessdataDir },
      });
      fullText += "\n" + pageText.trim();
      if (p % 5 === 0) process.stderr.write(`  [ocr] page ${p + 1}/${pageFiles.length}...\n`);
    }

    return fullText.trim() || null;
  } catch (err) {
    console.error(`  [ocr] Failed: ${(err as Error).message}`);
    return null;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
}

async function processStatutes(
  statutes: Statute[],
  limit: number,
  pdfMapping: Map<number, string>,
  ocrTitleValidate = false,
  forceOcr = false,
): Promise<{ statutesDone: number; provisionsAdded: number }> {
  const db = getDb();
  let statutesDone = 0;
  let provisionsAdded = 0;
  let successCount = 0;
  const total = Math.min(limit, statutes.length);

  // Pre-collect which acts already have provisions (resume support)
  const hasProvisions = new Set(
    (db.prepare("SELECT DISTINCT statute_id FROM provisions").all() as { statute_id: number }[]).map(r => r.statute_id)
  );

  for (let i = 0; i < total; i++) {
    const st = statutes[i];
    const label = st.title_np.slice(0, 60);

    // Skip if already processed (resume support)
    if (hasProvisions.has(st.id)) {
      console.error(`[${i + 1}/${total}] Skipping (already has provisions): ${label}`);
      continue;
    }

    console.error(`[${i + 1}/${total}] Processing: ${label}`);

    const pdfUrl = pdfMapping.get(st.id);
    if (!pdfUrl) {
      console.error(`  No PDF URL found`);
      updateStatuteQuality(st.id, "error", JSON.stringify({ method: "none", error: "no PDF URL" }));
      continue;
    }

    // Clear existing provisions for this statute (safety net)
    db.prepare("DELETE FROM provisions WHERE statute_id = ?").run(st.id);

    // Update the source_url
    db.prepare("UPDATE statutes SET source_url = ? WHERE id = ?").run(pdfUrl, st.id);

    const buf = await downloadPdf(pdfUrl);
    if (!buf) {
      console.error(`  Failed to download PDF`);
      updateStatuteQuality(st.id, "error", JSON.stringify({ method: "none", error: "download failed" }));
      continue;
    }

    // Successful download — check for batch pause
    successCount++;
    if (successCount > 0 && successCount % BATCH_SIZE === 0 && i < total - 1) {
      console.error(`  ⏸ Batch pause: ${successCount} downloaded, pausing ${BATCH_PAUSE_MS / 1000}s...`);
      await sleep(BATCH_PAUSE_MS);
    }

    // Cross-validate PDF title matches expected act title
    const validation = await validatePdfTitle(pdfUrl, st.title_np, ocrTitleValidate);
    if (!validation.valid && validation.method !== "download_failed") {
      console.error(`  ✗ PDF title mismatch: expected "${st.title_np.slice(0, 50)}"`);
      console.error(`    extracted: "${validation.extractedTitle.slice(0, 80)}" (${validation.method})`);
      // Save original URL in quality_detail before clearing
      const errDetail = JSON.stringify({ method: "none", error: "title_mismatch", original_source_url: pdfUrl, validation });
      updateStatuteQuality(st.id, "error", errDetail);
      // Reject: clear source_url so it won't be used again
      db.prepare("UPDATE statutes SET source_url = NULL WHERE id = ?").run(st.id);
      pdfMapping.delete(st.id);
      continue;
    }
    console.error(`  ✓ PDF title validated (${validation.method})`);

    const text = await extractPdfText(buf);
    if (!text) {
      console.error(`  Failed to extract text`);
      updateStatuteQuality(st.id, "error", JSON.stringify({ method: "pdfjs", error: "extraction returned null" }));
      continue;
    }

    const sections = splitIntoSections(text);
    console.error(`  Extracted ${sections.length} sections from ${text.length} chars`);

    // Check quality of extracted text
    let { quality, detail } = checkTextQuality(text, "pdfjs");
    if (forceOcr) {
      quality = "low_confidence";
      detail = JSON.stringify({ method: "pdfjs", quality: "low_confidence", reason: "forced OCR" });
    }
    let bestText = text;
    let bestSections = sections;
    let bestMethod = "pdfjs";

    if (quality === "low_confidence") {
      console.error(`  ⚠ pdfjs quality: low_confidence — trying OCR fallback...`);
      const ocrText = await ocrPdfWithPoppler(pdfUrl, st.id);
      if (ocrText) {
        const ocrClean = cleanNepaliText(ocrText);
        const ocrSections = splitIntoSections(ocrClean);
        const { quality: ocrQuality, detail: ocrDetail } = checkTextQuality(ocrClean, "ocr");
        console.error(`  [ocr] Quality: ${ocrQuality}, ${ocrSections.length} sections from ${ocrClean.length} chars`);

        if (ocrQuality === "verified") {
          quality = ocrQuality;
          detail = ocrDetail;
          bestMethod = "ocr";
          bestText = ocrClean;
          bestSections = ocrSections;
        } else if (ocrSections.length >= sections.length && ocrClean.length > text.length) {
          quality = ocrQuality;
          detail = ocrDetail;
          bestMethod = "ocr";
          bestText = ocrClean;
          bestSections = ocrSections;
        } else {
          console.error(`  [ocr] Not better than pdfjs — keeping pdfjs result`);
        }
      } else {
        console.error(`  [ocr] Failed — keeping pdfjs result`);
      }
    }

    // Update stored method in quality_detail
    const parsed = JSON.parse(detail);
    parsed.method = bestMethod;
    detail = JSON.stringify(parsed);
    updateStatuteQuality(st.id, quality, detail);

    if (quality === "verified") {
      console.error(`  ✓ Final quality: verified (method: ${bestMethod})`);
    } else {
      console.error(`  ⚠ Final quality: low_confidence (method: ${bestMethod})`);
    }

    for (const section of bestSections) {
      insertProvision({
        statute_id: st.id,
        section_number: section.section_number,
        section_title: section.section_title,
        text: section.text,
      });
      provisionsAdded++;
    }

    statutesDone++;

    if (i < total - 1) {
      console.error(`  Waiting ${PDF_DELAY_MS}ms...`);
      await sleep(PDF_DELAY_MS);
    }
  }

  return { statutesDone, provisionsAdded };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let limit = 5;
  const limitIndex = args.indexOf("--max");
  if (limitIndex !== -1) {
    limit = parseInt(args[limitIndex + 1], 10) || 5;
  } else if (process.env.MAX_ACTS) {
    limit = parseInt(process.env.MAX_ACTS, 10) || 5;
  }
  const skipMapping = args.includes("--skip-mapping") || process.env.SKIP_MAPPING === "1";
  const failedOnly = args.includes("--failed-only") || process.env.FAILED_ONLY === "1";
  const ocrTitleValidate = args.includes("--ocr-title-validate") || process.env.OCR_TITLE_VALIDATE === "1";
  const forceOcr = args.includes("--force-ocr") || process.env.FORCE_OCR === "1";

  console.error("[parse-pdfs] Starting PDF parsing...");
  console.error(`[parse-pdfs] Limit: ${limit} acts`);

  const db = getDb();
  const allStatutes = db.prepare("SELECT * FROM statutes ORDER BY id").all() as Statute[];
  console.error(`[parse-pdfs] ${allStatutes.length} statutes in DB`);

  if (allStatutes.length === 0) {
    console.error("[parse-pdfs] No statutes in DB. Run `npm run ingest` first.");
    process.exit(1);
  }

  let pdfMapping = new Map<number, string>();

  for (const st of allStatutes) {
    if (st.source_url && st.source_url.includes(".pdf")) {
      pdfMapping.set(st.id, st.source_url);
    }
  }

  console.error(`[parse-pdfs] ${pdfMapping.size} statutes already have PDF URLs in DB`);

  if (pdfMapping.size < allStatutes.length && !skipMapping) {
    console.error("[parse-pdfs] Fetching category pages to find more PDF URLs...");
    const extraMapping = await loadAllCategoryMappings(allStatutes);
    for (const [id, url] of extraMapping) {
      if (!pdfMapping.has(id)) {
        pdfMapping.set(id, url);
      }
    }
    console.error(`[parse-pdfs] Total PDF URLs after category scan: ${pdfMapping.size}`);
  }

  let statutesWithPdf = allStatutes.filter((s) => pdfMapping.has(s.id));

  if (failedOnly) {
    const hasProv = new Set(
      (db.prepare("SELECT DISTINCT statute_id FROM provisions").all() as { statute_id: number }[]).map(r => r.statute_id)
    );
    // Acts with source_url that have no provisions
    statutesWithPdf = statutesWithPdf.filter((s) => !hasProv.has(s.id));
    // Also include title-rejected acts that have a recoverable source_url stored in quality_detail
    const titleRejected = db.prepare(
      "SELECT id, title_np, title_en, year, status, source_url, quality, quality_detail FROM statutes WHERE quality_detail LIKE ? AND quality = ?"
    ).all("%title_mismatch%", "error") as Statute[];
    for (const tr of titleRejected) {
      try {
        const detail = JSON.parse(tr.quality_detail || "{}");
        if (detail.original_source_url && !hasProv.has(tr.id)) {
          // Restore source_url from stored detail
          db.prepare("UPDATE statutes SET source_url = ?, quality = 'unprocessed', quality_detail = NULL WHERE id = ?").run(detail.original_source_url, tr.id);
          pdfMapping.set(tr.id, detail.original_source_url);
          if (!statutesWithPdf.find((s) => s.id === tr.id)) {
            statutesWithPdf.push({ ...tr, source_url: detail.original_source_url });
          }
        }
      } catch { /* parse failed */ }
    }
    console.error(`[parse-pdfs] Failed-only mode: ${statutesWithPdf.length} acts to retry`);
  }

  const result = await processStatutes(statutesWithPdf, Math.min(limit, statutesWithPdf.length), pdfMapping, ocrTitleValidate, forceOcr);

  rebuildFtsIndex();

  console.error("");
  console.error("[parse-pdfs] Done!");
  console.error(`  Statutes processed: ${result.statutesDone}`);
  console.error(`  Provisions added: ${result.provisionsAdded}`);

  const totalProvisions = (
    db.prepare("SELECT COUNT(*) AS c FROM provisions").get() as { c: number }
  ).c;
  console.error(`  Total provisions in DB: ${totalProvisions}`);
}

main().catch((err) => {
  console.error("[parse-pdfs] Fatal error:", err);
  process.exit(1);
});
