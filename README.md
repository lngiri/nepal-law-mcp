# nepal-law-mcp

## 🌐 Live Demo
**https://nepal-law-mcp.vercel.app/**

नेपाल कानून आयोगबाट प्रकाशित ३२८ वटा ऐनहरू र ३,४२४ वटा धाराहरू खोज्न मिल्ने tool।

An MCP (Model Context Protocol) server with a web interface that provides search access to Nepali statutes scraped from [lawcommission.gov.np](https://lawcommission.gov.np). Includes a full PDF parsing pipeline with OCR fallback for section-level text extraction.

## Features

- **search_statute**: Full-text search across all statute titles and provisions using SQLite FTS5 + LIKE fallback
- **get_provision**: Retrieve the full text of a specific section by act name and section number
- **list_acts**: List all 328 acts in the database with Nepali/English titles, year, and status
- **check_status**: Check whether an act is in force or repealed, with text quality and provision count
- **Web interface**: Nepali-language SPA at `http://localhost:3001` with search (debounced), browse, and provision viewer
- **PDF pipeline**: Download PDFs from CDN, extract sections via pdfjs-dist + tesseract OCR, quality-check

## Setup

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build
```

## Ingest Data

```bash
# Ingest all acts from the alphabetical index
npm run ingest

# Ingest a single act by name
npm run ingest -- --single "अख्तियार"
```

## Parse PDFs (extract section-level text)

```bash
# Process acts with PDF URLs (default: 5)
npm run parse-pdfs

# Process more acts
MAX_ACTS=100 npm run parse-pdfs

# Retry only previously-failed acts
FAILED_ONLY=1 npm run parse-pdfs

# Enable OCR-based title validation
OCR_TITLE_VALIDATE=1 npm run parse-pdfs
```

## Web Interface

```bash
# Start the web server on port 3001
npm run web

# Or development mode (hot-reload)
npm run web:dev
```

Open http://localhost:3001 to search and browse all acts.

## Usage with Roo Code / Claude Desktop

```json
{
  "mcpServers": {
    "nepal-law": {
      "command": "node",
      "args": ["path/to/nepal-law-mcp/dist/index.js"]
    }
  }
}
```

## Project Structure

```
nepal-law-mcp/
├── src/
│   ├── index.ts        # MCP server (stdio transport)
│   ├── db.ts           # SQLite database with FTS5
│   ├── scraper.ts      # Web scraper module
│   └── types.ts        # TypeScript types
├── scripts/
│   ├── ingest.ts       # Standalone ingest runner
│   └── parse-pdfs.ts   # PDF download + section extraction pipeline
├── web/
│   ├── server.ts       # Express.js REST API
│   ├── public/
│   │   └── index.html  # Nepali-language SPA
│   └── README.md
├── data/               # SQLite database location
├── package.json
├── tsconfig.json
├── README.md
└── SUMMARY.md
```

## Development

```bash
npm run dev      # Watch mode for TypeScript compilation
npm run build    # Compile TypeScript
npm run start    # Run the MCP server
npm run web      # Run the web interface
```

## DB State

| Metric | Value |
|---|---|
| Statutes in DB | 328 |
| Provisions extracted | 3,408 from 94 acts |
| Verified quality | 80 |
| Low confidence | 14 |
| Unprocessed (no source_url) | 233 |
