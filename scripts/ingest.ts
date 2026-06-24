#!/usr/bin/env node

import { ingestAll, ingestSingle } from "../src/scraper.js";
import { getDb, getStatuteCount } from "../src/db.js";

function printUsage(): void {
  console.error("Usage:");
  console.error("  npm run ingest              # Ingest all acts from the index");
  console.error("  npm run ingest -- --single   # Prompt for single act name");
  console.error("  npm run ingest -- --help     # Show this help");
  console.error("");
  console.error("  Or directly: node dist/scripts/ingest.js [--single ACT_NAME]");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  const singleIndex = args.indexOf("--single");
  if (singleIndex !== -1 && args[singleIndex + 1]) {
    const actName = args[singleIndex + 1];
    console.error(`[ingest] Starting single act ingestion for: "${actName}"`);
    const result = await ingestSingle(actName);
    if (result.statuteId) {
      console.error(`[ingest] Act ingested with ID ${result.statuteId}`);
    } else {
      console.error(`[ingest] Act not found`);
      process.exit(1);
    }
  } else if (singleIndex !== -1) {
    printUsage();
    process.exit(1);
  } else {
    console.error("[ingest] Starting full ingestion of Nepali statutes...");
    console.error("[ingest] This will respect robots.txt Crawl-delay: 10 seconds between requests.");
    console.error("[ingest] The process may take a long time depending on the number of acts.");
    console.error("");

    const result = await ingestAll((current, total, title) => {
      const pct = ((current / total) * 100).toFixed(1);
      process.stdout.write(
        `\r[ingest] Progress: ${current}/${total} (${pct}%) - ${title.slice(0, 50)}`
      );
    });

    process.stdout.write("\n");
    console.error("");
    console.error(`[ingest] Ingestion complete:`);
    console.error(`  Statutes:  ${result.statutes}`);
    console.error(`  Provisions: ${result.provisions}`);

    const totalStats = getStatuteCount();
    console.error(`  Total in DB: ${totalStats} statutes`);
  }
}

main().catch((err) => {
  console.error("[ingest] Fatal error:", err);
  process.exit(1);
});
