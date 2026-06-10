#!/usr/bin/env node
/**
 * CapyDB MCP server — stdio entry point.
 *
 * Exposes CapyDB managed Postgres (projects, preview databases, backups,
 * restores, imports, SQL, observability, jobs) to MCP clients.
 *
 * Configuration (environment variables):
 * - CAPYDB_API_KEY  (required) — CapyDB API key; project-scoped keys recommended.
 * - CAPYDB_API_URL  (optional) — control plane base URL,
 *                     defaults to https://capydb.dev/api/capydb.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CapyDBClient, DEFAULT_API_URL } from "./client.js";
import { registerTools } from "./tools.js";

const SERVER_VERSION = "0.1.0";

async function main(): Promise<void> {
  const apiKey = process.env["CAPYDB_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") {
    // stdout is the MCP transport; diagnostics must go to stderr.
    console.error(
      "capydb-mcp: CAPYDB_API_KEY is not set. Create an API key in the CapyDB dashboard " +
        "(Organization → API Keys) and export it: CAPYDB_API_KEY=capy_...",
    );
    process.exit(1);
  }

  const baseUrl = process.env["CAPYDB_API_URL"] ?? DEFAULT_API_URL;
  const client = new CapyDBClient({ apiKey: apiKey.trim(), baseUrl });

  const server = new McpServer({
    name: "capydb",
    title: "CapyDB",
    version: SERVER_VERSION,
  });
  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`capydb-mcp v${SERVER_VERSION} ready (API: ${baseUrl})`);
}

main().catch((error: unknown) => {
  console.error("capydb-mcp: fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
