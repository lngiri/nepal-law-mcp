import Database from "better-sqlite3";
import fs from "node:fs";

const db = new Database("data/nepal-law.db");
const PROGRESS_FILE = "data/fix-spacing-progress.json";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY environment variable required");
  process.exit(1);
}

async function fixText(text: string): Promise<string> {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Fix ONLY the missing word spaces in this Nepali legal text.
Do not change words, punctuation, or meaning.
Return ONLY the fixed text, no explanation.

Text: ${text}`,
        },
      ],
    }),
  });
  const data = await response.json() as any;
  return data.choices[0].message.content.trim();
}

async function main() {
  // Load progress
  let done: number[] = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    done = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  }

  const provisions = db
    .prepare(
      "SELECT id, text FROM provisions WHERE id NOT IN (" +
        (done.length ? done.join(",") : "0") +
        ")"
    )
    .all() as any[];

  console.log(`Remaining: ${provisions.length}`);

  // TEST: first 5 only
  const test = provisions.slice(0, 5);
  for (const p of test) {
    console.log("BEFORE:", p.text.substring(0, 100));
    const fixed = await fixText(p.text);
    console.log("AFTER:", fixed.substring(0, 100));
    console.log("---");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch(console.error);
