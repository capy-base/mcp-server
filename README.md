# @capydb/mcp

Official [CapyDB](https://capydb.dev) MCP server. Gives AI agents (Claude Code, Cursor, and any other
[Model Context Protocol](https://modelcontextprotocol.io) client) safe, structured access to your managed
Postgres: projects, preview databases, backups, restores, imports, SQL, and observability.
Every CapyDB project runs in its own isolated database cell - a dedicated Postgres runtime
reached with normal connection strings.

Runs over stdio and talks to the CapyDB control plane API - no local database access required.

## Install

No install needed; run it with `npx`:

```bash
npx @capydb/mcp
```

Or add it to Claude Code directly:

```bash
claude mcp add capydb -- npx @capydb/mcp
```

## Authentication

No setup is required. Credentials are resolved in this order:

1. **`CAPYDB_API_KEY`** environment variable - always wins. Use this for headless/CI setups.
2. **The CapyDB CLI's saved login** - if you have run `capydb auth login`, the MCP server reuses
   that credential (same config file, same revocation point).
3. **First-run browser approval** - with no credential at all, the server still starts. The first
   tool call returns a one-time approval URL:

   > CapyDB needs a one-time approval. Ask the user to open:
   > `https://capydb.dev/dashboard/cli/login?session=...` - then retry this tool.

   Open the link, approve in the dashboard (signing up and picking a plan inline if needed), and
   retry the tool. The minted API key is saved to the shared CLI config file (`chmod 600`) and no
   further approval is ever needed. Keys minted this way are labeled as agent-created in the
   dashboard key list, where they can be audited and revoked.

The shared config file lives at the CLI's config path: `~/Library/Application Support/capydb/config.json`
on macOS, `$XDG_CONFIG_HOME/capydb/config.json` (default `~/.config/...`) on Linux, `%AppData%\capydb\config.json`
on Windows.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CAPYDB_API_KEY` | no | - | Explicit CapyDB API key; skips the device login. Create one in the dashboard under **Organization → API Keys**. **Use a project-scoped key** for long-lived setups so the agent can only touch the project it is working on. |
| `CAPYDB_API_URL` | no | `https://capydb.dev/api/capydb` | Control plane base URL. Only change this for self-hosted / staging setups. |
| `CAPYDB_APP_URL` | no | derived from `CAPYDB_API_URL` | Dashboard origin used for device-login approval URLs. |

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "capydb": {
      "command": "npx",
      "args": ["@capydb/mcp"]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "capydb": {
      "command": "npx",
      "args": ["@capydb/mcp"]
    }
  }
}
```

For headless/CI, add `"env": { "CAPYDB_API_KEY": "capy_..." }` to the server entry.

## Tools

| Tool | What it does | Notes |
| --- | --- | --- |
| `list_regions` | List regions projects can be created in | read-only |
| `create_project` | Create a Postgres project and wait for provisioning | async; waits up to 5 min |
| `list_projects` | List your Postgres projects | read-only |
| `get_project` | Get one project (state, plan, limits) | read-only |
| `get_connection_strings` | Pooled + direct URLs for a project | **secret-bearing output** |
| `create_preview_database` | Create a disposable preview/branch DB (`empty` or `clone`) | async job |
| `list_preview_databases` | List previews with state and TTL | read-only |
| `delete_preview_database` | Delete a preview and its role | **destructive**, async job |
| `get_preview_connection_strings` | Pooled + direct URLs for a preview | **secret-bearing output** |
| `create_backup` | On-demand backup of the project DB | async job |
| `list_backups` | List backups incl. verification state | read-only |
| `restore` | Restore a backup / restore point / PITR timestamp **into a preview** | **destructive** to the target preview; cannot overwrite production |
| `import_preflight` | Check an external source DB before an import | read-only, connects out |
| `run_sql` | Run a SQL statement against the live project DB | read-mostly; row-capped, 15s timeout, recorded in SQL history |
| `list_tables` | List tables and views | read-only |
| `get_table_rows` | Read rows from a table | read-only |
| `get_observability` | Live metrics: connections, size, active/slow queries, alerts | read-only |
| `get_job` | Poll an async job until `completed`/`failed` | read-only |
| `list_jobs` | List a project's async jobs | read-only |

`create_project` notes: the project's plan is derived from the organization's billing state and cannot
be chosen per project. If the organization has no active plan, the tool fails with a link to
`https://capydb.dev/dashboard/settings?tab=billing` (1 month free) so the user can pick one and retry.

### Safety model

- **Production overwrite is not exposed.** The `restore` tool only targets preview databases (new or
  existing). Overwriting the production database is irreversible and requires explicit human confirmation
  plus the org admin role, so it stays in the dashboard and CLI.
- Destructive tools (`delete_preview_database`, `restore`) carry the MCP `destructiveHint` annotation so
  clients can require approval.
- Connection-string tools are clearly marked secret-bearing; instruct your agent not to persist their
  output.
- `run_sql` executes against the live database. Prefer running risky SQL against a preview created with
  `create_preview_database` (mode `clone`) and its `get_preview_connection_strings`.
- **Credential hygiene:** the device-login key is org-wide, expires after 90 days, and is meant for
  interactive sessions. For long-lived or shared agent setups, create a **project-scoped key** in the
  dashboard and pass it via `CAPYDB_API_KEY` instead. Every key - including agent-minted ones - is listed
  with its provenance in the dashboard and can be revoked there at any time.

## Typical flows

**Fresh machine to running database**

1. Any tool → one-time browser approval → 2. `create_project` → 3. `get_connection_strings`.

**Branch database per task**

1. `create_preview_database` (mode `clone`) → 2. `get_job` until `completed` →
3. `get_preview_connection_strings` → work → 4. `delete_preview_database`.

**Investigate production state**

`get_observability` → `list_tables` → `run_sql` with `SELECT`s (use `max_rows` to keep results small).

**Recover data without touching production**

`list_backups` → `restore` with `backup_key` and a `preview_name` → query the preview → copy what you need.

## Development

```bash
pnpm install
pnpm typecheck   # tsgo (TypeScript native preview)
pnpm lint        # oxlint
pnpm build       # tsdown → dist/index.js
node dist/index.js   # CAPYDB_API_KEY=capy_... to skip the device login
```

The API client is hand-written against the control plane's OpenAPI spec
(`backend/internal/httpapi/openapi.json` in the CapyDB monorepo layout). For a full typed SDK, see
[`@capydb/sdk`](https://www.npmjs.com/package/@capydb/sdk).

## License

MIT
