import * as cheerio from "cheerio";
import { upsertStatute, insertProvision, getDb } from "./db.js";
import type { ScrapedAct } from "./types.js";

const INDEX_URL = "https://lawcommission.gov.np/pages/alphabetical-index-of-acts/";
const CRAWL_DELAY_MS = 10_000;

const NEPALI_DIGITS: Record<string, string> = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
  "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nepaliToEnglishDigits(str: string): string {
  return str.replace(/[०-९]/g, (d) => NEPALI_DIGITS[d] ?? d);
}

export function extractYear(title: string): string | null {
  const eng = nepaliToEnglishDigits(title);
  const m = eng.match(/(?:20\d{2}|19\d{2})/);
  return m ? m[0] : null;
}

function makeEnglishTitle(titleNp: string): string {
  const year = extractYear(titleNp);
  let name = titleNp.replace(/,\s*(?:२०\d{2}|19\d{2}|20\d{2})\s*$/, "").trim();
  name = name.replace(/ऐन$/, "Act").trim();
  if (name.length > 80) {
    name = name.substring(0, 77) + "...";
  }
  return year ? `${name}, ${year}` : `${name} Act`;
}

export interface ActEntry {
  titleNp: string;
  categoryUrl: string | null;
}

function extractHalf(
  $: cheerio.CheerioAPI,
  cells: cheerio.Cheerio<any>,
  serialIdx: number,
  nameIdx: number,
  volIdx: number
): ActEntry | null {
  if (serialIdx >= cells.length || nameIdx >= cells.length) return null;
  const serial = $(cells[serialIdx]).text().trim();
  const nameNp = $(cells[nameIdx]).text().trim();
  if (!nameNp || nameNp.length < 3) return null;
  if (!serial || !/^[\d०-९]+/.test(serial)) return null;

  const volCell = volIdx < cells.length ? $(cells[volIdx]) : null;
  const link = volCell ? (volCell.find("a").attr("href") ?? null) : null;

  return { titleNp: nameNp, categoryUrl: link };
}

export async function fetchActList(): Promise<ActEntry[]> {
  console.error(`[scraper] Fetching act index from ${INDEX_URL}`);
  const resp = await fetch(INDEX_URL);
  if (!resp.ok) {
    throw new Error(`Failed to fetch index page: ${resp.status} ${resp.statusText}`);
  }
  const html = await resp.text();
  const $ = cheerio.load(html);
  const acts: ActEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  $(".custom-bs-table.old__pmList table tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) return;

    const rowText = cells.map((_, c) => $(c).text().trim()).get().join(" ");
    if (!rowText || rowText.includes("क्रस") || /^[अ-हौ]\s+/.test(rowText)) {
      skipped++;
      return;
    }

    const left = extractHalf($, cells, 0, 1, 2);
    if (left && !seen.has(left.titleNp)) {
      seen.add(left.titleNp);
      acts.push(left);
    }

    if (cells.length >= 7) {
      const right = extractHalf($, cells, 4, 5, 6);
      if (right && !seen.has(right.titleNp)) {
        seen.add(right.titleNp);
        acts.push(right);
      }
    }
  });

  console.error(`[scraper] Found ${acts.length} acts on index page (skipped ${skipped} header/separator rows)`);
  return acts;
}

async function fetchPageText(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return null;
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("text/html")) return await resp.text();
    return null;
  } catch {
    return null;
  }
}

async function crawlCategoryPage(catUrl: string): Promise<{ sourceUrl: string | null }> {
  const html = await fetchPageText(catUrl);
  if (!html) return { sourceUrl: null };
  const $ = cheerio.load(html);

  const pdfHref = $("a[href$='.pdf'], a[href*='.pdf']").first().attr("href");
  if (pdfHref) {
    return { sourceUrl: pdfHref.startsWith("http") ? pdfHref : `https://lawcommission.gov.np${pdfHref}` };
  }

  const cdnLink = $("a[href*='giwmscdn'], a[href*='/media/']").first().attr("href");
  if (cdnLink) {
    return { sourceUrl: cdnLink.startsWith("http") ? cdnLink : `https://lawcommission.gov.np${cdnLink}` };
  }

  return { sourceUrl: null };
}

export async function ingestAll(
  onProgress?: (current: number, total: number, title: string) => void
): Promise<{ statutes: number; provisions: number }> {
  const acts = await fetchActList();
  const total = acts.length;
  let statuteCount = 0;

  for (let i = 0; i < total; i++) {
    const entry = acts[i];
    const label = entry.titleNp.slice(0, 60);
    console.error(`[scraper] [${i + 1}/${total}] Storing: ${label}`);
    onProgress?.(i + 1, total, entry.titleNp);

    try {
      const year = extractYear(entry.titleNp);
      const titleEn = makeEnglishTitle(entry.titleNp);
      let sourceUrl: string | null = null;

      if (entry.categoryUrl) {
        const result = await crawlCategoryPage(entry.categoryUrl);
        sourceUrl = result.sourceUrl;
      }

      upsertStatute({
        title_np: entry.titleNp,
        title_en: titleEn,
        year,
        status: "unknown",
        source_url: sourceUrl,
      });
      statuteCount++;
    } catch (err) {
      console.error(`[scraper] Error storing "${label}":`, err);
    }

    if (i < total - 1) await delay(CRAWL_DELAY_MS);
  }

  getDb().exec("INSERT INTO statutes_fts(statutes_fts) VALUES('rebuild')");

  const provCount = (getDb().prepare("SELECT COUNT(*) AS c FROM provisions").get() as { c: number }).c;
  console.error(`[scraper] Done. ${statuteCount} statutes stored. Provisions: ${provCount}`);
  return { statutes: statuteCount, provisions: provCount };
}

export async function ingestSingle(actName: string): Promise<{ statuteId: number | null }> {
  const acts = await fetchActList();
  const entry = acts.find(
    (a) =>
      a.titleNp.includes(actName) ||
      makeEnglishTitle(a.titleNp).toLowerCase().includes(actName.toLowerCase())
  );
  if (!entry) {
    console.error(`[scraper] Act "${actName}" not found in index`);
    return { statuteId: null };
  }

  let sourceUrl: string | null = null;
  if (entry.categoryUrl) {
    const result = await crawlCategoryPage(entry.categoryUrl);
    sourceUrl = result.sourceUrl;
  }

  const year = extractYear(entry.titleNp);
  const titleEn = makeEnglishTitle(entry.titleNp);
  const statuteId = upsertStatute({
    title_np: entry.titleNp,
    title_en: titleEn,
    year,
    status: "unknown",
    source_url: sourceUrl,
  });

  return { statuteId };
}
