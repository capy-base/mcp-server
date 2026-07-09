/**
 * CapyDB control-plane types used by the MCP tools.
 *
 * Entity and request shapes are re-exported from `@capydb/sdk` (generated from
 * the control plane's OpenAPI document) so they can never drift from the API.
 * A handful of request/response shapes the SDK only exposes as operation-level
 * types (regions, connections, SQL, import) are defined locally against the same
 * OpenAPI source.
 */

export type {
  ActiveQuerySample,
  Backup,
  CreatePreviewRequest,
  CreateProjectRequest,
  CreateRestoreRequest,
  DatabaseTable,
  ImportPreflightCheck,
  ImportPreflightResult,
  Job,
  PreviewDatabase,
  Project,
  ProjectObservability,
  SlowQuerySample,
  SourceExtension,
  SourceInspection,
  TableRowsResult,
} from "@capydb/sdk";

/** Response from `GET /v1/regions` — the regions a project can be placed in. */
export interface RegionsResponse {
  regions: string[];
}

export interface ConnectionInfo {
  /** Pooled (PgBouncer) connection URL — the default for applications. */
  pooled_url?: string;
  /** Direct Postgres connection URL (for migrations and long-lived sessions). */
  direct_url?: string;
  username: string;
}

export interface SQLQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  duration_ms: number;
  /** True when the result was cut off at the row cap. */
  truncated: boolean;
}

export interface SQLQueryRequest {
  query: string;
  /** Row cap for the result (default 200, max 1000). */
  max_rows?: number;
}

export interface CreateImportRequest {
  /**
   * Live Postgres connection URL to import from. The dump-upload variant
   * (upload_key) is intentionally not exposed over MCP — it needs the
   * presigned-upload flow only the CLI and dashboard implement.
   */
  source_url: string;
  /** Drop and recreate the target database before importing. */
  recreate?: boolean;
}
