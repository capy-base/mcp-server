/**
 * Thin typed fetch client for the CapyDB control plane API.
 *
 * Intentionally has no dependency on `@capydb/sdk` — the MCP server only needs
 * a small slice of the API and a single-file client keeps the published
 * package lean. The API shape mirrors `backend/internal/httpapi/openapi.json`.
 */

import type {
  Backup,
  ConnectionInfo,
  CreateImportRequest,
  CreatePreviewRequest,
  CreateProjectRequest,
  CreateRestoreRequest,
  DatabaseTable,
  ImportPreflightResult,
  Job,
  PreviewDatabase,
  Project,
  ProjectObservability,
  RegionsResponse,
  SQLQueryRequest,
  SQLQueryResult,
  TableRowsResult,
} from "./types.js";

export const DEFAULT_API_URL = "https://capydb.dev/api/capydb";

/** Error raised for non-2xx control plane responses. */
export class CapyDBApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CapyDBApiError";
    this.status = status;
  }
}

export interface CapyDBClientOptions {
  /**
   * Returns the API key (`capy_...`) for each request. Resolved lazily so the
   * key can arrive after startup via the first-run device login.
   */
  getApiKey: () => string;
  /** Control plane base URL. Defaults to the hosted bridge. */
  baseUrl?: string;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export class CapyDBClient {
  private readonly getApiKey: () => string;
  private readonly baseUrl: string;

  constructor(options: CapyDBClientOptions) {
    this.getApiKey = options.getApiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.getApiKey()}`,
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (cause) {
      throw new Error(`CapyDB API request failed: ${method} ${path}: ${String(cause)}`, { cause });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new CapyDBApiError(response.status, extractErrorMessage(text, response.status));
    }
    if (text.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new Error(`CapyDB API returned invalid JSON for ${method} ${path}`, { cause });
    }
  }

  // ---- Regions ---------------------------------------------------------------

  async listRegions(): Promise<string[]> {
    const data = await this.request<RegionsResponse>("GET", "/v1/regions");
    return data.regions ?? [];
  }

  // ---- Projects ------------------------------------------------------------

  async createProject(body: CreateProjectRequest): Promise<{ project: Project; job: Job }> {
    return await this.request("POST", "/v1/projects", { body });
  }

  async listProjects(organizationId?: string): Promise<Project[]> {
    const data = await this.request<{ projects: Project[] | null }>("GET", "/v1/projects", {
      query: { organization_id: organizationId },
    });
    return data.projects ?? [];
  }

  async getProject(projectId: string): Promise<Project> {
    const data = await this.request<{ project: Project }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}`,
    );
    return data.project;
  }

  async getProjectConnections(projectId: string): Promise<ConnectionInfo> {
    const data = await this.request<{ connections: ConnectionInfo }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/connections`,
    );
    return data.connections;
  }

  // ---- Preview databases ---------------------------------------------------

  async createPreviewDatabase(
    projectId: string,
    body: CreatePreviewRequest,
  ): Promise<{ preview: PreviewDatabase; job: Job }> {
    return await this.request(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/preview-databases`,
      {
        body,
      },
    );
  }

  async listPreviewDatabases(projectId: string): Promise<PreviewDatabase[]> {
    const data = await this.request<{ preview_databases: PreviewDatabase[] | null }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/preview-databases`,
    );
    return data.preview_databases ?? [];
  }

  async deletePreviewDatabase(previewId: string): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "DELETE",
      `/v1/preview-databases/${encodeURIComponent(previewId)}`,
    );
    return data.job;
  }

  async getPreviewConnections(previewId: string): Promise<ConnectionInfo> {
    const data = await this.request<{ connections: ConnectionInfo }>(
      "GET",
      `/v1/preview-databases/${encodeURIComponent(previewId)}/connections`,
    );
    return data.connections;
  }

  async resetPreviewDatabase(previewId: string): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "POST",
      `/v1/preview-databases/${encodeURIComponent(previewId)}/reset`,
    );
    return data.job;
  }

  async extendPreviewDatabase(previewId: string, ttlHours: number): Promise<PreviewDatabase> {
    const data = await this.request<{ preview: PreviewDatabase }>(
      "POST",
      `/v1/preview-databases/${encodeURIComponent(previewId)}/extend`,
      { body: { ttl_hours: ttlHours } },
    );
    return data.preview;
  }

  // ---- Backups, restores, imports -------------------------------------------

  async createBackup(projectId: string, label?: string): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/backups`,
      { body: label !== undefined ? { label } : {} },
    );
    return data.job;
  }

  async listBackups(projectId: string): Promise<Backup[]> {
    const data = await this.request<{ backups: Backup[] | null }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/backups`,
    );
    return data.backups ?? [];
  }

  async createRestore(projectId: string, body: CreateRestoreRequest): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/restores`,
      { body },
    );
    return data.job;
  }

  async createImport(projectId: string, body: CreateImportRequest): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/imports`,
      { body },
    );
    return data.job;
  }

  async runImportPreflight(projectId: string, sourceUrl: string): Promise<ImportPreflightResult> {
    const data = await this.request<{ preflight: ImportPreflightResult }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/imports/preflight`,
      { body: { source_url: sourceUrl } },
    );
    return data.preflight;
  }

  // ---- Studio (SQL + data browser) ------------------------------------------

  async runSql(projectId: string, body: SQLQueryRequest): Promise<SQLQueryResult> {
    const data = await this.request<{ result: SQLQueryResult }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/sql`,
      { body },
    );
    return data.result;
  }

  async listTables(projectId: string): Promise<DatabaseTable[]> {
    const data = await this.request<{ tables: DatabaseTable[] | null }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/tables`,
    );
    return data.tables ?? [];
  }

  async getTableRows(
    projectId: string,
    schema: string,
    table: string,
    limit?: number,
  ): Promise<TableRowsResult> {
    const data = await this.request<{ result: TableRowsResult }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/rows`,
      { query: { limit } },
    );
    return data.result;
  }

  // ---- Observability + jobs --------------------------------------------------

  async getObservability(projectId: string): Promise<ProjectObservability> {
    const data = await this.request<{ observability: ProjectObservability }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/observability`,
    );
    return data.observability;
  }

  async getJob(jobId: string): Promise<Job> {
    const data = await this.request<{ job: Job }>("GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
    return data.job;
  }

  async listJobs(projectId: string, limit?: number): Promise<Job[]> {
    const data = await this.request<{ jobs: Job[] | null }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/jobs`,
      { query: { limit } },
    );
    return data.jobs ?? [];
  }
}

/** The control plane returns `{ "error": "<message>" }` for failures. */
function extractErrorMessage(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
    ) {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON — fall through to the generic message.
  }
  return body.length > 0 ? `HTTP ${status}: ${body.slice(0, 500)}` : `HTTP ${status}`;
}
