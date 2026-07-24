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

/**
 * `POST /v1/projects` body. Defined locally (not re-exported from the SDK)
 * because `postgres_version` lands in the next `@capydb/sdk` publish; the shape
 * mirrors CreateProjectRequest in the OpenAPI document. Switch back to the SDK
 * re-export once the published SDK includes it.
 */
export interface CreateProjectRequest {
  environment?: "production" | "non_production";
  name: string;
  /** Required only for platform admins acting on behalf of an organization. */
  organization_id?: string;
  /**
   * Postgres major version for the new database ("16" | "17" | "18"). Omit
   * for the platform default. Immutable after creation.
   */
  postgres_version?: "16" | "17" | "18";
  /** Region to place the project in. Omit to let CapyDB pick. */
  region?: string;
  slug?: string;
}

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
  /**
   * Must be true: the API refuses imports without explicit confirmation (an
   * import writes over the project's live database).
   */
  confirm: boolean;
}

/**
 * Canonical schema document from `GET /v1/projects/{id}/schema` (and its
 * preview-database sibling). Defined locally because the schema endpoints land
 * in the next `@capydb/sdk` publish; switch back to SDK re-exports once
 * published.
 */
export interface DatabaseSchema {
  database_name: string;
  extensions: SchemaExtension[];
  postgres_version: string;
  schemas: SchemaNamespace[];
}

export interface SchemaExtension {
  name: string;
  version: string;
}

export interface SchemaNamespace {
  enums: SchemaEnum[];
  name: string;
  tables: SchemaTable[];
}

export interface SchemaEnum {
  comment?: string;
  name: string;
  values: string[];
}

export interface SchemaTable {
  columns: SchemaColumn[];
  comment?: string;
  foreign_keys: SchemaForeignKey[];
  kind: "table" | "partitioned_table" | "view" | "materialized_view" | "foreign_table";
  name: string;
  primary_key: string[];
  unique_constraints: SchemaUniqueConstraint[];
}

export interface SchemaColumn {
  /** Declared array dimension count (>= 1 for array columns). */
  array_dims?: number;
  comment?: string;
  /** Formatted pg type, e.g. `character varying(255)`. */
  data_type: string;
  default?: string;
  /** Set for identity columns. */
  identity?: "always" | "by_default";
  is_array: boolean;
  is_enum: boolean;
  is_generated: boolean;
  is_nullable: boolean;
  name: string;
  position: number;
  /** Underlying pg type name; the element type for array columns. */
  udt_name: string;
  udt_schema: string;
}

export interface SchemaForeignKey {
  columns: string[];
  name: string;
  on_delete: string;
  on_update: string;
  referenced_columns: string[];
  referenced_schema: string;
  referenced_table: string;
}

export interface SchemaUniqueConstraint {
  columns: string[];
  name: string;
}

/** Generated source file from `GET /v1/projects/{id}/schema/types`. */
export interface GeneratedTypes {
  content: string;
  filename: string;
  language: "typescript" | "zod" | "drizzle";
  style?: "capydb" | "supabase";
}

/**
 * Named restore point (`/v1/projects/{id}/restore-points`). Defined locally
 * for the same publish-lag reason as the schema types above.
 */
export interface RestorePoint {
  backup_id?: string;
  backup_key?: string;
  created_at: string;
  created_by_actor_id?: string;
  created_by_actor_kind: string;
  id: string;
  kind: string;
  label: string;
  note?: string;
  organization_id: string;
  pitr_time?: string;
  project_id: string;
  state: string;
  updated_at: string;
}

export interface CreateRestorePointRequest {
  backup_key?: string;
  /** Backup pins an existing recorded backup; pitr pins a timestamp. */
  kind: "backup" | "pitr";
  label: string;
  note?: string;
  /** PITR target timestamp (RFC 3339) when kind is "pitr". */
  pitr_time?: string;
}

/**
 * A Postgres extension offered on the project's database.
 *
 * `installed_version` is what the database actually has; `available_version` is
 * what the platform now provides. They diverge after a platform upgrade until
 * the customer applies an update, which is what `update_available` signals.
 * Extensions CapyDB manages for its own observability never report it.
 */
export interface ProjectExtension {
  available_version?: string;
  default_version?: string;
  description: string;
  enabled: boolean;
  installed_version?: string;
  name: string;
  requires_restart?: boolean;
  trusted: boolean;
  update_available?: boolean;
}
