/**
 * MCP tool registrations for the CapyDB control plane.
 *
 * Conventions:
 * - Read-only tools set `readOnlyHint: true`.
 * - Destructive tools (preview deletion/reset, restores, imports) set
 *   `destructiveHint: true`.
 * - Production overwrite restores are intentionally NOT exposed: the `restore`
 *   tool only targets preview databases.
 * - Results are returned as pretty-printed JSON text.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { sleep, type AuthManager } from "./auth.js";
import { CapyDBApiError, type CapyDBClient } from "./client.js";
import type { Job, Project } from "./types.js";

const PROVISION_POLL_INTERVAL_MS = 3_000;
const PROVISION_TIMEOUT_MS = 5 * 60_000;
const BILLING_URL = "https://capydb.dev/dashboard/settings?tab=billing";

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
  const message =
    error instanceof CapyDBApiError
      ? `CapyDB API error (HTTP ${error.status}): ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Gates every tool on authentication before running its handler. When no API
 * key is available, the result text carries the device-login approval URL so
 * the host model relays it to the user.
 */
async function run(auth: AuthManager, handler: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const authState = await auth.ensure();
    if (!authState.ok) {
      return { isError: true, content: [{ type: "text", text: authState.message }] };
    }
    return jsonResult(await handler());
  } catch (error) {
    return errorResult(error);
  }
}

export function registerTools(server: McpServer, client: CapyDBClient, auth: AuthManager): void {
  // ---- Regions ---------------------------------------------------------------

  server.registerTool(
    "list_regions",
    {
      title: "List regions",
      description:
        "List the regions a CapyDB Postgres project can be placed in. Use this to pick a region for create_project; omit the region to let CapyDB choose.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(auth, () => client.listRegions()),
  );

  // ---- Projects ------------------------------------------------------------

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description:
        "Create a new CapyDB Postgres project. Provisioning is asynchronous; this tool waits up to 5 minutes for the provision job to finish and returns the final project and job state. The project's plan is derived from the organization's billing state and cannot be chosen here. Omit the region to let CapyDB pick (use list_regions to see what is available).",
      inputSchema: {
        name: z.string().describe("Project name."),
        postgres_version: z
          .enum(["16", "17", "18"])
          .optional()
          .describe(
            "Postgres major version for the database. Omit for the platform default. Immutable after creation; previews and restores inherit it.",
          ),
        region: z
          .string()
          .optional()
          .describe("Region to place the project in (see list_regions). Omit to let CapyDB pick."),
        slug: z.string().optional().describe("URL-safe slug; derived from the name when omitted."),
      },
    },
    async ({ name, postgres_version, region, slug }) =>
      run(auth, async () => {
        let created: { project: Project; job: Job };
        try {
          created = await client.createProject({ name, postgres_version, region, slug });
        } catch (error) {
          // The control plane rejects provisioning without an active plan as a
          // 400 whose message comes from ensureOrganizationCanProvision
          // (backend/internal/service/billing.go) - there is no structured
          // error code, so match the stable message text.
          if (
            error instanceof CapyDBApiError &&
            error.status === 400 &&
            (error.message.includes("subscription is required") ||
              error.message.includes("organization billing is"))
          ) {
            throw new Error(
              `No active plan. Ask the user to pick a plan (1 month free) at ${BILLING_URL} - then retry this tool.`,
            );
          }
          throw error;
        }

        let job = created.job;
        const deadline = Date.now() + PROVISION_TIMEOUT_MS;
        while (job.state !== "completed" && job.state !== "failed" && Date.now() < deadline) {
          await sleep(PROVISION_POLL_INTERVAL_MS);
          job = await client.getJob(job.id);
        }

        const project = await client.getProject(created.project.id);
        if (job.state !== "completed" && job.state !== "failed") {
          return {
            project,
            job,
            note: "Provisioning is still running after 5 minutes - poll with get_job until it completes.",
          };
        }
        return { project, job };
      }),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List the CapyDB Postgres projects visible to the configured API key, including state, plan, region, and storage limits.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(auth, () => client.listProjects()),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get a project",
      description: "Get a single CapyDB project by id, including provisioning state and limits.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project_id }) => run(auth, () => client.getProject(project_id)),
  );

  server.registerTool(
    "get_connection_strings",
    {
      title: "Get project connection strings",
      description:
        "Get the project's pooled (PgBouncer) and direct Postgres connection URLs. " +
        "SECRET-BEARING OUTPUT: the URLs embed live database credentials - never log them, echo them into files, or include them in commit messages or chat summaries.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project_id }) => run(auth, () => client.getProjectConnections(project_id)),
  );

  // ---- Preview databases ---------------------------------------------------

  server.registerTool(
    "create_preview_database",
    {
      title: "Create a preview database",
      description:
        'Create a disposable preview/branch database for a project. Provisioning is asynchronous: poll the returned job with get_job until it completes. Mode "empty" creates a blank database; "clone" copies the production data. Previews expire after their TTL.',
      inputSchema: {
        project_id: z.string().describe("Project id."),
        name: z.string().optional().describe("Preview name (e.g. a branch or PR slug)."),
        mode: z
          .enum(["empty", "clone"])
          .optional()
          .describe('Data source: "empty" (blank) or "clone" (copy of production).'),
        ttl_hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .optional()
          .describe("Time to live in hours before the preview expires (1-168, default 24)."),
      },
    },
    async ({ project_id, name, mode, ttl_hours }) =>
      run(auth, () => client.createPreviewDatabase(project_id, { name, mode, ttl_hours })),
  );

  server.registerTool(
    "list_preview_databases",
    {
      title: "List preview databases",
      description: "List a project's preview databases with state, source, and TTL expiry.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project_id }) => run(auth, () => client.listPreviewDatabases(project_id)),
  );

  server.registerTool(
    "delete_preview_database",
    {
      title: "Delete a preview database",
      description:
        "Permanently delete a preview database and its role. The data is not recoverable. Deletion runs asynchronously via the returned job.",
      inputSchema: {
        preview_id: z.string().describe("Preview database id."),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ preview_id }) => run(auth, () => client.deletePreviewDatabase(preview_id)),
  );

  server.registerTool(
    "reset_preview_database",
    {
      title: "Reset a preview database",
      description:
        'Reset a preview database back to its source state: "clone" previews are re-cloned from the current production data, "empty" previews are wiped clean. The preview keeps its name and connection route, but its CURRENT DATA IS LOST. The reset runs asynchronously: poll the returned job with get_job.',
      inputSchema: {
        preview_id: z.string().describe("Preview database id."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ preview_id }) => run(auth, () => client.resetPreviewDatabase(preview_id)),
  );

  server.registerTool(
    "extend_preview_ttl",
    {
      title: "Extend a preview database's TTL",
      description:
        "Set a preview database's expiry to ttl_hours from NOW - an absolute new TTL, not a delta added to the remaining time (e.g. ttl_hours 24 makes the preview expire 24 hours from this call, even if it had 3 days left). The preview must be ready and not already expired. Returns the updated preview with its new ttl_expires_at.",
      inputSchema: {
        preview_id: z.string().describe("Preview database id."),
        ttl_hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .describe("New TTL in hours, measured from now (1-168)."),
      },
      annotations: { idempotentHint: true },
    },
    async ({ preview_id, ttl_hours }) =>
      run(auth, () => client.extendPreviewDatabase(preview_id, ttl_hours)),
  );

  server.registerTool(
    "get_preview_connection_strings",
    {
      title: "Get preview database connection strings",
      description:
        "Get a preview database's pooled and direct Postgres connection URLs. " +
        "SECRET-BEARING OUTPUT: the URLs embed live database credentials - never log them, echo them into files, or include them in commit messages or chat summaries.",
      inputSchema: {
        preview_id: z.string().describe("Preview database id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ preview_id }) => run(auth, () => client.getPreviewConnections(preview_id)),
  );

  // ---- Backups, restores, imports -------------------------------------------

  server.registerTool(
    "create_backup",
    {
      title: "Create a backup",
      description:
        "Enqueue an on-demand backup of the project database. Runs asynchronously: poll the returned job with get_job.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
        label: z.string().optional().describe("Optional human-readable label for the backup."),
      },
    },
    async ({ project_id, label }) => run(auth, () => client.createBackup(project_id, label)),
  );

  server.registerTool(
    "list_backups",
    {
      title: "List backups",
      description: "List a project's completed backups, including verification state.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project_id }) => run(auth, () => client.listBackups(project_id)),
  );

  server.registerTool(
    "restore",
    {
      title: "Restore into a preview database",
      description:
        "Restore from a backup (backup_key), a named restore point (restore_point_id), or a PITR timestamp (restore_time) into a preview database - either an existing one (preview_id) or a new one (preview_name; omit both to create an auto-named preview). " +
        "Exactly one source must be given. " +
        "This tool deliberately cannot overwrite the production project database: overwriting production is irreversible and requires explicit human confirmation with the org admin role, so it is only available from the dashboard and CLI. " +
        "Restoring into an existing preview replaces that preview's data.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
        backup_key: z.string().optional().describe("Backup to restore from."),
        restore_point_id: z.string().optional().describe("Named restore point to restore from."),
        restore_time: z
          .string()
          .optional()
          .describe("Point-in-time recovery target timestamp (RFC 3339)."),
        preview_id: z
          .string()
          .optional()
          .describe("Existing preview database to restore into (its data is replaced)."),
        preview_name: z
          .string()
          .optional()
          .describe("Name for a new preview database to restore into."),
        ttl_hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .optional()
          .describe("TTL for a newly created preview target (1-168 hours, default 24)."),
        allow_unverified_backup: z
          .boolean()
          .optional()
          .describe("Permit restoring from a backup whose verification has not passed."),
      },
      annotations: { destructiveHint: true },
    },
    async ({
      project_id,
      backup_key,
      restore_point_id,
      restore_time,
      preview_id,
      preview_name,
      ttl_hours,
      allow_unverified_backup,
    }) => {
      const sources = [backup_key, restore_point_id, restore_time].filter(
        (source) => source !== undefined && source !== "",
      );
      if (sources.length !== 1) {
        return errorResult(
          new Error(
            "Provide exactly one restore source: backup_key, restore_point_id, or restore_time.",
          ),
        );
      }
      if (preview_id !== undefined && preview_name !== undefined) {
        return errorResult(
          new Error(
            "Provide preview_id (existing preview) or preview_name (new preview), not both.",
          ),
        );
      }
      return run(auth, () =>
        client.createRestore(project_id, {
          backup_key: backup_key ?? "",
          restore_point_id,
          restore_time,
          // Never "project": production overwrite is not exposed over MCP.
          // "preview" replaces an existing preview; "new_preview" creates one
          // (named via preview_name, or auto-named when omitted).
          target_kind: preview_id !== undefined ? "preview" : "new_preview",
          preview_id,
          preview_name,
          ttl_hours,
          allow_unverified_backup,
        }),
      );
    },
  );

  server.registerTool(
    "import_preflight",
    {
      title: "Run an import preflight",
      description:
        "Synchronously inspect an external source Postgres database (size, server version, installed extensions) and report whether an import into the project is expected to succeed, with per-check pass/warn/fail detail. Does not modify either database. The source URL contains credentials - do not repeat it back.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
        source_url: z
          .string()
          .describe(
            "Postgres connection URL of the source database (postgres://user:pass@host:port/db). Must be a direct or session-mode endpoint: transaction-pooler URLs (Neon '-pooler' hostnames, Supabase port 6543) are rejected. Supabase sources get their platform-managed schemas (auth/storage/realtime/…) excluded automatically.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ project_id, source_url }) =>
      run(auth, () => client.runImportPreflight(project_id, source_url)),
  );

  server.registerTool(
    "import_database",
    {
      title: "Import a database",
      description:
        "Import a live external Postgres database into the project from its connection URL. " +
        "DESTRUCTIVE: the import OVERWRITES the project's production database - existing data not present in the source is lost and cannot be recovered except from backups. " +
        "Run import_preflight first, then ask the user before calling this tool; set confirm to true only after the user has explicitly approved overwriting the project database. " +
        "The import runs asynchronously: poll the returned job with get_job. The source URL contains credentials - do not repeat it back. " +
        "Importing from a dump file is not supported here (it needs the CLI's upload flow: `capydb import --file`).",
      inputSchema: {
        project_id: z.string().describe("Project id."),
        source_url: z
          .string()
          .describe(
            "Postgres connection URL of the source database (postgres://user:pass@host:port/db). Must be a direct or session-mode endpoint: transaction-pooler URLs (Neon '-pooler' hostnames, Supabase port 6543) are rejected. Supabase sources get their platform-managed schemas (auth/storage/realtime/…) excluded automatically.",
          ),
        recreate: z
          .boolean()
          .optional()
          .describe("Drop and recreate the target database before importing (cleanest overwrite)."),
        confirm: z
          .boolean()
          .describe(
            "Must be true. Confirms the user explicitly approved overwriting the project's database with the imported data.",
          ),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ project_id, source_url, recreate, confirm }) => {
      if (!confirm) {
        return errorResult(
          new Error(
            "Import not confirmed: the import overwrites the project's database. Ask the user for explicit approval, then retry with confirm: true.",
          ),
        );
      }
      // The server now enforces the confirm too; forward the agent's
      // assertion instead of re-asserting it client-side.
      return run(auth, () => client.createImport(project_id, { source_url, recreate, confirm }));
    },
  );

  // ---- Studio (SQL + data browser) ------------------------------------------

  server.registerTool(
    "run_sql",
    {
      title: "Run SQL",
      description:
        "Execute a SQL statement against the LIVE project database. Intended for read-mostly use (SELECTs, EXPLAIN, lightweight inspection) - DML/DDL is not blocked, so treat writes with the same care as running them in production. Results are capped (default 200 rows, max 1000) and queries time out after 15 seconds. Every execution is recorded in the project's SQL history.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
        query: z.string().describe("SQL statement to execute."),
        max_rows: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Row cap for the result (default 200, max 1000)."),
      },
    },
    async ({ project_id, query, max_rows }) =>
      run(auth, () => client.runSql(project_id, { query, max_rows })),
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description: "List tables and views in the project database.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project_id }) => run(auth, () => client.listTables(project_id)),
  );

  server.registerTool(
    "get_table_rows",
    {
      title: "Get table rows",
      description: "Return rows from a table in the project database.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
        schema: z.string().describe('Schema name (e.g. "public").'),
        table: z.string().describe("Table name."),
        limit: z.number().int().positive().optional().describe("Maximum number of rows to return."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project_id, schema, table, limit }) =>
      run(auth, () => client.getTableRows(project_id, schema, table, limit)),
  );

  // ---- Observability + jobs --------------------------------------------------

  server.registerTool(
    "get_observability",
    {
      title: "Get live project metrics",
      description:
        "Get a live observability snapshot of the project database: connection usage, database size versus storage limit, active queries, slowest statements (when pg_stat_statements is available), and derived alerts.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project_id }) => run(auth, () => client.getObservability(project_id)),
  );

  server.registerTool(
    "get_job",
    {
      title: "Get a job",
      description:
        'Get a single asynchronous job. Poll until state is "completed" or "failed". Use this after create_preview_database, create_backup, restore, import_database, reset_preview_database, or delete_preview_database.',
      inputSchema: {
        job_id: z.string().describe("Job id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id }) => run(auth, () => client.getJob(job_id)),
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List project jobs",
      description: "List a project's asynchronous jobs, newest first.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of jobs to return (default 25)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project_id, limit }) => run(auth, () => client.listJobs(project_id, limit)),
  );
}
