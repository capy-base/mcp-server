/**
 * MCP tool registrations for the CapyDB control plane.
 *
 * Conventions:
 * - Read-only tools set `readOnlyHint: true`.
 * - Destructive tools (preview deletion, restores) set `destructiveHint: true`.
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
  // ---- Clusters --------------------------------------------------------------

  server.registerTool(
    "list_clusters",
    {
      title: "List clusters",
      description:
        "List the active CapyDB clusters (regions) projects can be created on, including Postgres version, installed extensions, and database-count capacity. Use this to pick a region or cluster_id for create_project.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(auth, () => client.listClusters()),
  );

  // ---- Projects ------------------------------------------------------------

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description:
        "Create a new CapyDB Postgres project. Provisioning is asynchronous; this tool waits up to 5 minutes for the provision job to finish and returns the final project and job state. The project's plan is derived from the organization's billing state and cannot be chosen here. Omit cluster_id and region to let CapyDB pick (use list_clusters to see what is available).",
      inputSchema: {
        name: z.string().describe("Project name."),
        region: z
          .string()
          .optional()
          .describe("Region to place the project in (see list_clusters). Omit to let CapyDB pick."),
        cluster_id: z
          .string()
          .optional()
          .describe("Specific cluster to place the project on. Omit to let CapyDB pick by region."),
        slug: z.string().optional().describe("URL-safe slug; derived from the name when omitted."),
      },
    },
    async ({ name, region, cluster_id, slug }) =>
      run(auth, async () => {
        let created: { project: Project; job: Job };
        try {
          created = await client.createProject({ name, region, cluster_id, slug });
        } catch (error) {
          if (error instanceof CapyDBApiError && error.status === 412) {
            throw new Error(
              `No active plan. Ask the user to pick a plan (1 month free) at ${BILLING_URL} — then retry this tool.`,
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
            note: "Provisioning is still running after 5 minutes — poll with get_job until it completes.",
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
        "SECRET-BEARING OUTPUT: the URLs embed live database credentials — never log them, echo them into files, or include them in commit messages or chat summaries.",
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
          .positive()
          .optional()
          .describe("Time to live in hours before the preview expires."),
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
    "get_preview_connection_strings",
    {
      title: "Get preview database connection strings",
      description:
        "Get a preview database's pooled and direct Postgres connection URLs. " +
        "SECRET-BEARING OUTPUT: the URLs embed live database credentials — never log them, echo them into files, or include them in commit messages or chat summaries.",
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
        "Restore from a backup (backup_key), a named restore point (restore_point_id), or a PITR timestamp (restore_time) into a preview database — either an existing one (preview_id) or a new one (preview_name). " +
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
          .positive()
          .optional()
          .describe("TTL for a newly created preview target."),
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
          target_kind: "preview",
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
        "Synchronously inspect an external source Postgres database (size, server version, installed extensions) and report whether an import into the project is expected to succeed, with per-check pass/warn/fail detail. Does not modify either database. The source URL contains credentials — do not repeat it back.",
      inputSchema: {
        project_id: z.string().describe("Project id."),
        source_url: z
          .string()
          .describe(
            "Postgres connection URL of the source database (postgres://user:pass@host:port/db).",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ project_id, source_url }) =>
      run(auth, () => client.runImportPreflight(project_id, source_url)),
  );

  // ---- Studio (SQL + data browser) ------------------------------------------

  server.registerTool(
    "run_sql",
    {
      title: "Run SQL",
      description:
        "Execute a SQL statement against the LIVE project database. Intended for read-mostly use (SELECTs, EXPLAIN, lightweight inspection) — DML/DDL is not blocked, so treat writes with the same care as running them in production. Results are capped (default 200 rows, max 1000) and queries time out after 15 seconds. Every execution is recorded in the project's SQL history.",
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
        'Get a single asynchronous job. Poll until state is "completed" or "failed". Use this after create_preview_database, create_backup, restore, or delete_preview_database.',
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
