/**
 * Response types for the CapyDB control plane API.
 *
 * Hand-derived from `backend/internal/httpapi/openapi.json` — the authoritative
 * source for the API shape. Only the subset of the API surfaced by the MCP
 * tools is typed here.
 */

/** Response from `GET /v1/regions` — the regions a project can be placed in. */
export interface RegionsResponse {
  regions: string[];
}

export interface Project {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  region: string;
  environment: string;
  plan: string;
  state: string;
  primary_instance_id?: string;
  database_name?: string;
  role_name?: string;
  public_host?: string;
  pooled_port?: number;
  direct_port?: number;
  ssl_mode?: string;
  storage_limit_bytes?: number;
  max_connections?: number;
  statement_timeout?: string;
  idle_transaction_timeout?: string;
  latest_job_id?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface PreviewDatabase {
  id: string;
  project_id: string;
  name: string;
  mode?: string;
  state: string;
  database_name?: string;
  role_name?: string;
  public_host?: string;
  pooled_port?: number;
  direct_port?: number;
  ssl_mode?: string;
  source_kind?: string;
  source_database?: string;
  source_backup_key?: string;
  source_restore_time?: string;
  ttl_expires_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectionInfo {
  /** Pooled (PgBouncer) connection URL — the default for applications. */
  pooled_url?: string;
  /** Direct Postgres connection URL (for migrations and long-lived sessions). */
  direct_url?: string;
  username: string;
}

export interface Backup {
  id: string;
  project_id: string;
  backup_key?: string;
  database_name?: string;
  label?: string;
  size_bytes?: number;
  state: string;
  verification_state?: "pending" | "verified" | "failed";
  verification_error?: string;
  verified_at?: string;
  created_at: string;
}

export interface Job {
  id: string;
  organization_id: string;
  project_id?: string;
  preview_database_id?: string;
  host_id?: string;
  instance_id?: string;
  type: string;
  state: "pending" | "running" | "completed" | "failed";
  attempts: number;
  max_attempts: number;
  error?: string;
  last_exit_code?: number;
  last_stderr?: string;
  last_stdout?: string;
  retry_classification?: string;
  locked_resource?: string;
  claimed_at?: string;
  claimed_by?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ImportPreflightCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail?: string;
}

export interface SourceExtension {
  name: string;
  version: string;
}

export interface SourceInspection {
  server_version: string;
  database_size_bytes: number;
  extensions: SourceExtension[];
}

export interface ImportPreflightResult {
  ok: boolean;
  checks: ImportPreflightCheck[];
  source: SourceInspection;
  storage_limit_bytes: number;
  target_version: string;
}

export interface SQLQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  duration_ms: number;
  /** True when the result was cut off at the row cap. */
  truncated: boolean;
}

export interface DatabaseTable {
  schema: string;
  table: string;
  type: string;
}

export interface TableRowsResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface ActiveQuerySample {
  pid: number;
  username: string;
  state: string;
  query: string;
  duration_ms: number;
  wait_event?: string;
  wait_event_type?: string;
}

export interface SlowQuerySample {
  query: string;
  calls: number;
  rows: number;
  total_time_ms: number;
  mean_time_ms: number;
}

export interface ProjectObservability {
  connection_count: number;
  connection_limit: number;
  connection_usage_percent: number;
  database_size_bytes: number;
  storage_limit_bytes: number;
  storage_usage_percent: number;
  pg_stat_statements: boolean;
  active_queries: ActiveQuerySample[];
  slow_queries: SlowQuerySample[];
  alerts: string[];
}

export interface CreateProjectRequest {
  name: string;
  /** URL-safe slug; derived from the name when omitted. */
  slug?: string;
  /** Region to place the project in. Omit to let CapyDB pick. */
  region?: string;
  environment?: string;
  /** Required only for platform admins acting on behalf of an organization. */
  organization_id?: string;
}

export interface CreatePreviewRequest {
  name?: string;
  /** Data source mode for the preview (e.g. `empty`, `clone`). */
  mode?: string;
  ttl_hours?: number;
}

export interface CreateRestoreRequest {
  backup_key: string;
  restore_point_id?: string;
  restore_time?: string;
  target_kind?: string;
  preview_id?: string;
  preview_name?: string;
  ttl_hours?: number;
  recreate?: boolean;
  allow_unverified_backup?: boolean;
}

export interface SQLQueryRequest {
  query: string;
  /** Row cap for the result (default 200, max 1000). */
  max_rows?: number;
}
