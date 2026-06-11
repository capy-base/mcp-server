#!/usr/bin/env node
/**
 * CapyDB MCP server — stdio entry point.
 *
 * Exposes CapyDB managed Postgres (projects, preview databases, backups,
 * restores, imports, SQL, observability, jobs) to MCP clients.
 *
 * Authentication (in precedence order):
 * 1. CAPYDB_API_KEY (optional) — explicit API key for headless/CI setups.
 * 2. The CapyDB CLI's saved credentials (`capydb auth login`) from the shared
 *    user config file.
 * 3. First-run browser device login: with no credential, the server still
 *    starts; the first tool call returns a one-time approval URL, and once the
 *    user approves it in the dashboard the minted key is saved for future runs.
 *
 * Other configuration:
 * - CAPYDB_API_URL (optional) — control plane base URL,
 *                    defaults to https://capydb.dev/api/capydb.
 * - CAPYDB_APP_URL (optional) — dashboard origin for approval URLs; derived
 *                    from CAPYDB_API_URL when unset.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AuthManager } from "./auth.js";
import { CapyDBClient } from "./client.js";
import { registerTools } from "./tools.js";

const SERVER_VERSION = "0.2.0";

async function main(): Promise<void> {
  const auth = await AuthManager.create();
  const client = new CapyDBClient({ getApiKey: () => auth.apiKey(), baseUrl: auth.apiUrl });

  const server = new McpServer({
    name: "capydb",
    title: "CapyDB",
    version: SERVER_VERSION,
  });
  registerTools(server, client, auth);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP transport; diagnostics must go to stderr.
  console.error(
    `capydb-mcp v${SERVER_VERSION} ready (API: ${auth.apiUrl}, auth: ${auth.describe()})`,
  );
}

main().catch((error: unknown) => {
  console.error("capydb-mcp: fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
