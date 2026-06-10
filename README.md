# @capydb/mcp

Official [CapyDB](https://capydb.dev) MCP server. Gives AI agents (Claude Code, Cursor, and any other
[Model Context Protocol](https://modelcontextprotocol.io) client) safe, structured access to your managed
Postgres: projects, preview databases, backups, restores, imports, SQL, and observability.

Runs over stdio and talks to the CapyDB control plane API — no local database access required.

## Install

No install needed; run it with `npx`:

```bash
npx @capydb/mcp
```

Or add it to Claude Code directly:

```bash
claude mcp add capydb --env CAPYDB_API_KEY=capy_... -- npx @capydb/mcp
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CAPYDB_API_KEY` | yes | — | CapyDB API key. Create one in the dashboard under **Organization → API Keys**. **Use a project-scoped key** so the agent can only touch the project it is working on. |
| `CAPYDB_API_URL` | no | `https://capydb.dev/api/capydb` | Control plane base URL. Only change this for self-hosted / staging setups. |

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "capydb": {
      "command": "npx",
      "args": ["@capydb/mcp"],
      "env": {
        "CAPYDB_API_KEY": "capy_..."
      }
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
      "args": ["@capydb/mcp"],
      "env": {
        "CAPYDB_API_KEY": "capy_..."
      }
    }
  }
}
```

## Tools

| Tool | What it does | Notes |
| --- | --- | --- |
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

## Typical flows

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
CAPYDB_API_KEY=capy_... node dist/index.js
```

The API client is hand-written against the control plane's OpenAPI spec
(`backend/internal/httpapi/openapi.json` in the CapyDB monorepo layout). For a full typed SDK, see
[`@capydb/sdk`](https://www.npmjs.com/package/@capydb/sdk).

## License

MIT
