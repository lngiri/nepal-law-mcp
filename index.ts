#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getDb, searchStatutes, getProvision, listActs, getActStatus, getStatuteCount, getStatuteProvisionsCount } from "./src/db.js";

function createServer(): Server {
  const server = new Server(
    {
      name: "nepal-law-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_statute",
        description:
          "Full-text search across all Nepali statutes. Returns matching statutes and relevant provisions. Use for searching acts by name, keyword, or topic.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query (supports FTS5 syntax like AND, OR, NOT, phrase searches)",
            },
            limit: {
              type: "number",
              description: "Maximum number of results (default 20)",
              default: 20,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_provision",
        description:
          "Get the full text of a specific section or provision from an act. Provide the act name (or partial name) and the section number.",
        inputSchema: {
          type: "object",
          properties: {
            act_name: {
              type: "string",
              description: "Name of the act (can be partial, e.g. 'Muluki' or 'अख्तियार')",
            },
            section_number: {
              type: "string",
              description: "Section number (e.g. '3', '4.1', '१')",
            },
          },
          required: ["act_name", "section_number"],
        },
      },
      {
        name: "list_acts",
        description:
          "List all acts currently in the database with their Nepali and English titles, year, and status.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "check_status",
        description:
          "Check whether a specific act is currently in force or has been repealed. Returns the act's current legal status.",
        inputSchema: {
          type: "object",
          properties: {
            act_name: {
              type: "string",
              description: "Name of the act to check (can be partial, e.g. 'Muluki Criminal' or 'अपराध संहिता')",
            },
          },
          required: ["act_name"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "search_statute": {
          const query = String(args?.query ?? "").trim();
          if (!query) {
            return {
              content: [{ type: "text", text: "Query parameter is required." }],
              isError: true,
            };
          }
          const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
          const results = searchStatutes(query, limit);
          if (results.length === 0) {
            return {
              content: [{ type: "text", text: `No results found for "${query}".` }],
            };
          }
          const lines = results.map(
            (r, i) =>
              `${i + 1}. **${r.title_en}** (${r.title_np})\n   ${r.snippet ?? "No preview available."}`
          );
          return {
            content: [
              {
                type: "text",
                text: `Found ${results.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`,
              },
            ],
          };
        }

        case "get_provision": {
          const actName = String(args?.act_name ?? "").trim();
          const sectionNumber = String(args?.section_number ?? "").trim();
          if (!actName || !sectionNumber) {
            return {
              content: [{ type: "text", text: "Both act_name and section_number are required." }],
              isError: true,
            };
          }
          const provision = getProvision(actName, sectionNumber);
          if (!provision) {
            return {
              content: [
                {
                  type: "text",
                  text: `No provision found for act "${actName}" section "${sectionNumber}".`,
                },
              ],
            };
          }
          const lines = [
            `**Section${provision.section_number ? ` ${provision.section_number}` : ""}${provision.section_title ? ` — ${provision.section_title}` : ""}**`,
            "",
            provision.text,
          ];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
          };
        }

        case "list_acts": {
          const acts = listActs();
          if (acts.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No acts in database. Run `npm run ingest` to populate the database first.",
                },
              ],
            };
          }
          const lines = acts.map(
            (a) =>
              `- **${a.title_en}** (${a.title_np})${a.year ? ` [${a.year}]` : ""} — ${a.status}`
          );
          return {
            content: [
              {
                type: "text",
                text: `Total: ${acts.length} acts\n\n${lines.join("\n")}`,
              },
            ],
          };
        }

        case "check_status": {
          const actName = String(args?.act_name ?? "").trim();
          if (!actName) {
            return {
              content: [{ type: "text", text: "act_name parameter is required." }],
              isError: true,
            };
          }
          const statute = getActStatus(actName);
          if (!statute) {
            return {
              content: [
                {
                  type: "text",
                  text: `Act "${actName}" not found in database. Use search_statute to find the correct name, or run npm run ingest to populate the database.`,
                },
              ],
            };
          }
          const provisionsCount = getStatuteProvisionsCount(statute.id);
          const qualityLabel =
            statute.quality === "verified"
              ? "✅ Verified"
              : statute.quality === "low_confidence"
                ? "⚠️ Low Confidence"
                : statute.quality === "error"
                  ? "❌ Error"
                  : "⏳ Unprocessed";
          return {
            content: [
              {
                type: "text",
                text: `**${statute.title_en}** (${statute.title_np})\nYear: ${statute.year ?? "N/A"}\nStatus: **${statute.status === "in_force" ? "✅ In Force" : statute.status === "repealed" ? "🚫 Repealed" : "❓ Unknown"}**\nQuality: **${qualityLabel}**\nProvisions: ${provisionsCount}`,
              },
            ],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error executing ${name}: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

async function main() {
  getDb();
  const count = getStatuteCount();
  console.error(`[nepal-law-mcp] Database ready. ${count} statutes indexed.`);

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[nepal-law-mcp] Server connected via stdio transport. Ready for requests.");
}

main().catch((err) => {
  console.error("[nepal-law-mcp] Fatal error:", err);
  process.exit(1);
});
