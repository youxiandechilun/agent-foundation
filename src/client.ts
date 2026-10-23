import type {
  Asset,
  FoundationEvent,
  Input,
  Mode,
  Project,
  Session,
} from "./contracts.js";
import type { SecurityAuditRecord } from "./security/types.js";
import { decodeEventStream } from "./transport/sse.js";
export class FoundationHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${status}: ${message}`);
  }
  get retryable() {
    return [408, 429, 502, 503, 504].includes(this.status);
  }
}
export interface EventStreamOptions {
  reconnect?: boolean;
  maxReconnects?: number;
  retryMs?: number;
  maxFrameChars?: number;
}
interface DeviceAuthOptionalFields {
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: string;
  intervalSeconds?: number;
  nextPollAt?: string;
  error?: string;
}
interface DeviceAuthGrantStatus extends DeviceAuthOptionalFields {
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
}
export interface DeviceAuthPendingStatus extends DeviceAuthGrantStatus {
  state: "pending";
  userCode: string;
  nextPollAt: string;
}
export interface DeviceAuthTerminalStatus extends DeviceAuthGrantStatus {
  state: "authorized" | "denied" | "expired" | "failed";
  userCode?: undefined;
  verificationUriComplete?: undefined;
  nextPollAt?: undefined;
}
export interface DeviceAuthInactiveStatus extends DeviceAuthOptionalFields {
  state: "idle" | "cancelled";
}
/** Public device authorization state; no device code or credentials are returned. */
export type DeviceAuthStatus =
  DeviceAuthPendingStatus | DeviceAuthTerminalStatus | DeviceAuthInactiveStatus;
async function pause(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function parseEvent(data: string): FoundationEvent {
  const event: unknown = JSON.parse(data);
  if (!isFoundationEvent(event))
    throw new Error("Invalid foundation event frame");
  return event;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isAsset(value: unknown): value is Asset {
  return (
    isRecord(value) &&
    ["id", "projectId", "name", "mime", "sha256", "createdAt"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value.size === "number" &&
    (value.origin === "upload" ||
      value.origin === "artifact" ||
      value.origin === "model")
  );
}
function isDeviceAuthStatus(value: unknown): value is DeviceAuthStatus {
  if (!isRecord(value)) return false;
  if (
    ![
      "userCode",
      "verificationUri",
      "verificationUriComplete",
      "expiresAt",
      "nextPollAt",
      "error",
    ].every((key) => value[key] === undefined || typeof value[key] === "string")
  )
    return false;
  if (value.state === "idle" || value.state === "cancelled")
    return (
      value.intervalSeconds === undefined ||
      typeof value.intervalSeconds === "number"
    );
  if (
    typeof value.verificationUri !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.intervalSeconds !== "number"
  )
    return false;
  if (value.state === "pending")
    return (
      typeof value.userCode === "string" && typeof value.nextPollAt === "string"
    );
  return (
    (value.state === "authorized" ||
      value.state === "denied" ||
      value.state === "expired" ||
      value.state === "failed") &&
    value.userCode === undefined &&
    value.verificationUriComplete === undefined &&
    value.nextPollAt === undefined
  );
}
function isFoundationEvent(event: unknown): event is FoundationEvent {
  return (
    isRecord(event) &&
    event.schemaVersion === 1 &&
    ["id", "sessionId", "runId", "type", "timestamp"].every(
      (key) => typeof event[key] === "string",
    ) &&
    (event.seq === null ||
      (typeof event.seq === "number" &&
        Number.isSafeInteger(event.seq) &&
        event.seq > 0)) &&
    isRecord(event.data)
  );
}

/** Own fetch client, portable to Node/Electron/browsers. Only replay-safe GET streams reconnect automatically. */
export class FoundationClient {
  #token: string;
  constructor(
    readonly baseUrl: string,
    token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.#token = token;
  }
  private headers(json = true) {
    return {
      Authorization: `Bearer ${this.#token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }
  private async jsonResult(response: Response) {
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new FoundationHttpError(
        response.status,
        "invalid_response",
        `HTTP ${response.status}: invalid JSON response`,
      );
    }
    if (!response.ok) {
      const error =
        isRecord(result) && isRecord(result.error) ? result.error : undefined;
      throw new FoundationHttpError(
        response.status,
        typeof error?.code === "string" ? error.code : "http_error",
        typeof error?.message === "string"
          ? error.message
          : `HTTP ${response.status}`,
      );
    }
    return result;
  }
  async request<T = unknown>(
    method: string,
    route: string,
    data?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    // The optional type argument is the caller's declared server contract.
    // Untyped requests retain unknown and require validation before use.
    return (await this.jsonResult(
      await fetch(this.baseUrl + route, {
        method,
        headers: this.headers(),
        body: data === undefined ? undefined : JSON.stringify(data),
        signal,
      }),
    )) as T;
  }
  applications() {
    return this.request("GET", "/v1/applications");
  }
  browserOpen(
    projectId: string,
    options: { owner?: string; url?: string; cdpEndpoint?: string } = {},
  ) {
    return this.request("POST", "/v1/browser", { ...options, projectId });
  }
  browserAction(
    browserId: string,
    projectId: string,
    action: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    return this.request(
      "POST",
      `/v1/browser/${encodeURIComponent(browserId)}/action`,
      { ...action, projectId },
      signal,
    );
  }
  browserClose(browserId: string, projectId: string) {
    return this.request(
      "DELETE",
      `/v1/browser/${encodeURIComponent(browserId)}`,
      { projectId },
    );
  }
  browserPair(projectId: string, name = "user browser") {
    return this.request("POST", "/v1/browser/bridge/pair", { projectId, name });
  }
  browserBridgeAction(
    nodeId: string,
    projectId: string,
    action: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    return this.request(
      "POST",
      `/v1/browser/bridge/${encodeURIComponent(nodeId)}/action`,
      { ...action, projectId },
      signal,
    );
  }
  browserRevoke(nodeId: string, projectId: string) {
    return this.request(
      "DELETE",
      `/v1/browser/bridge/${encodeURIComponent(nodeId)}`,
      { projectId },
    );
  }
  computerAction(
    projectId: string,
    action: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    return this.request(
      "POST",
      "/v1/computer/action",
      { ...action, projectId },
      signal,
    );
  }
  computerStop() {
    return this.request("POST", "/v1/computer/stop", {});
  }
  computerResume() {
    return this.request("POST", "/v1/computer/resume", {});
  }
  office(
    operation:
      | "inspect"
      | "create"
      | "table"
      | "analyze"
      | "transform"
      | "edit-sheet"
      | "replace-text"
      | "compose-pdf"
      | "preview-pdf",
    projectId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    return this.request(
      "POST",
      "/v1/office/" + operation,
      { ...args, projectId },
      signal,
    );
  }
  project(
    name: string,
    directory?: string,
    options: { billingAccount?: string } = {},
  ) {
    return this.request<Project>("POST", "/v1/projects", {
      name,
      directory,
      ...options,
    });
  }
  session(
    projectId: string,
    mode: Mode = "chat",
    routeId?: string,
    options: {
      agentId?: string;
      subagentsEnabled?: boolean;
      reasoningEffort?: import("./contracts.js").ReasoningEffort;
      reasoningBudgetTokens?: number;
    } = {},
  ) {
    return this.request<Session>("POST", "/v1/sessions", {
      projectId,
      mode,
      routeId,
      ...options,
    });
  }
  teams() {
    return this.request<{
      teams: import("./collaboration/types.js").TeamDefinition[];
    }>("GET", "/v1/teams");
  }
  putTeam(team: import("./collaboration/types.js").TeamDefinition) {
    return this.request<import("./collaboration/types.js").TeamDefinition>(
      "POST",
      "/v1/teams",
      team,
    );
  }
  configureCollaboration(
    sessionId: string,
    settings: import("./collaboration/types.js").TeamBindingInput | null,
  ) {
    return this.request<import("./contracts.js").Session>(
      settings === null ? "DELETE" : "PUT",
      `/v1/sessions/${encodeURIComponent(sessionId)}/collaboration`,
      settings === null ? undefined : settings,
    );
  }
  forkSession(sessionId: string, throughMessageId?: string) {
    return this.request<import("./contracts.js").Session>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/fork`,
      { throughMessageId },
    );
  }
  resolveTeamRoles(sessionId: string, decision: "redistribute" | "add_agents") {
    return this.request<import("./contracts.js").Session>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/role-review/decision`,
      { decision },
    );
  }
  sessionBranches(sessionId: string) {
    return this.request<{
      branches: Pick<
        import("./contracts.js").Session,
        "id" | "name" | "forkedFromSessionId" | "forkedThroughMessageId"
      >[];
    }>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/branches`);
  }
  exportMigration(sessionId: string, signal?: AbortSignal) {
    return this.request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/migration`,
      undefined,
      signal,
    );
  }
  /** Explicit, cancellable diagnostics; directory sizes are sampled separately from SQL. */
  storageStats(signal?: AbortSignal) {
    return this.request<import("./storage/metrics.js").StorageStats>(
      "GET",
      "/v1/storage/stats",
      undefined,
      signal,
    );
  }
  importMigration(
    projectId: string,
    bundle: unknown,
    key: string,
    routeId?: string,
    signal?: AbortSignal,
  ) {
    return this.request(
      "POST",
      "/v1/migrations/import",
      { projectId, bundle, key, routeId },
      signal,
    );
  }
  mcpInteractions(serverId?: string) {
    return this.request(
      "GET",
      "/v1/mcp-interactions" +
        (serverId ? "?serverId=" + encodeURIComponent(serverId) : ""),
    );
  }
  resolveMCPInteraction(
    id: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ) {
    return this.request(
      "POST",
      `/v1/mcp-interactions/${encodeURIComponent(id)}/resolve`,
      { action, content },
    );
  }
  beginMCPOAuth(serverId: string) {
    return this.request(
      "POST",
      `/v1/mcp/${encodeURIComponent(serverId)}/auth-begin`,
    );
  }
  beginMCPDeviceAuth(serverId: string) {
    return this.deviceAuthRequest(
      "POST",
      `/v1/mcp/${encodeURIComponent(serverId)}/auth-device`,
    );
  }
  mcpDeviceAuth(serverId: string) {
    return this.deviceAuthRequest(
      "GET",
      `/v1/mcp/${encodeURIComponent(serverId)}/auth-device`,
    );
  }
  pollMCPDeviceAuth(serverId: string) {
    return this.deviceAuthRequest(
      "POST",
      `/v1/mcp/${encodeURIComponent(serverId)}/auth-device-poll`,
    );
  }
  async waitMCPDeviceAuth(serverId: string, signal?: AbortSignal) {
    for (;;) {
      signal?.throwIfAborted();
      const status = await this.deviceAuthRequest(
        "POST",
        `/v1/mcp/${encodeURIComponent(serverId)}/auth-device-poll`,
        signal,
      );
      if (status.state !== "pending") return status;
      const next = Math.min(
        Date.parse(status.nextPollAt),
        Date.parse(status.expiresAt),
      );
      if (!Number.isFinite(next))
        throw new FoundationHttpError(
          502,
          "invalid_response",
          "Device polling schedule is invalid",
        );
      await pause(Math.max(1, Math.min(60000, next - Date.now())), signal);
    }
  }
  cancelMCPDeviceAuth(serverId: string) {
    return this.deviceAuthRequest(
      "DELETE",
      `/v1/mcp/${encodeURIComponent(serverId)}/auth-device`,
    );
  }
  private async deviceAuthRequest(
    method: string,
    route: string,
    signal?: AbortSignal,
  ): Promise<DeviceAuthStatus> {
    const status = await this.request(method, route, undefined, signal);
    if (!isDeviceAuthStatus(status))
      throw new FoundationHttpError(
        502,
        "invalid_response",
        "Device polling status is invalid",
      );
    return status;
  }
  readMCPRegistration(serverId: string, acknowledgeUnknown = false) {
    return this.request(
      "POST",
      `/v1/mcp/${encodeURIComponent(serverId)}/registration-read`,
      { acknowledgeUnknown },
    );
  }
  updateMCPRegistration(serverId: string, changes: Record<string, unknown>) {
    return this.request(
      "PUT",
      `/v1/mcp/${encodeURIComponent(serverId)}/registration-remote`,
      { changes },
    );
  }
  deleteMCPRegistration(serverId: string) {
    return this.request(
      "DELETE",
      `/v1/mcp/${encodeURIComponent(serverId)}/registration-remote`,
    );
  }
  mcpOAuthKeys(serverId: string) {
    return this.request(
      "GET",
      `/v1/mcp/${encodeURIComponent(serverId)}/auth-keys`,
    );
  }
  rotateMCPOAuthKeys(serverId: string) {
    return this.request(
      "POST",
      `/v1/mcp/${encodeURIComponent(serverId)}/auth-keys-rotate`,
    );
  }
  mcpClientTasks(serverId: string) {
    return this.request(
      "GET",
      `/v1/mcp/${encodeURIComponent(serverId)}/client-tasks`,
    );
  }
  registerMCPOAuth(serverId: string) {
    return this.request(
      "POST",
      `/v1/mcp/${encodeURIComponent(serverId)}/register`,
    );
  }
  mcpRegistration(serverId: string) {
    return this.request(
      "GET",
      `/v1/mcp/${encodeURIComponent(serverId)}/registration`,
    );
  }
  resetMCPRegistration(serverId: string, acknowledgeUnknown = false) {
    return this.request(
      "DELETE",
      `/v1/mcp/${encodeURIComponent(serverId)}/registration`,
      { acknowledgeUnknown },
    );
  }
  completeMCPOAuth(serverId: string, callbackUrl: string) {
    return this.request(
      "POST",
      `/v1/mcp/${encodeURIComponent(serverId)}/auth-complete`,
      { callbackUrl },
    );
  }
  submit(sessionId: string, input: Input) {
    return this.request<{ runId: string; inputId: string; events: string }>(
      "POST",
      `/v1/sessions/${sessionId}/inputs`,
      input,
    );
  }
  securityAudits(
    sessionId: string,
    page: { limit?: number; offset?: number } = {},
  ): Promise<{
    records: SecurityAuditRecord[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const query = new URLSearchParams();
    if (page.limit !== undefined) query.set("limit", String(page.limit));
    if (page.offset !== undefined) query.set("offset", String(page.offset));
    return this.request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/security-audits?${query}`,
    );
  }
  processAction(
    sessionId: string,
    action: "start" | "read" | "write" | "resize" | "stop" | "list",
    args: Record<string, unknown> = {},
  ) {
    return this.request<{ runId: string; events: string }>(
      "POST",
      `/v1/sessions/${sessionId}/process-actions`,
      { action, arguments: args },
    );
  }
  costs(
    filter: { projectId?: string; sessionId?: string; runId?: string } = {},
  ) {
    const query = new URLSearchParams(
      Object.entries(filter).filter(([, v]) => v !== undefined) as [
        string,
        string,
      ][],
    );
    return this.request("GET", "/v1/costs?" + query);
  }
  reconcileCost(chargeId: string, actualUsd: number, reference: string) {
    return this.request(
      "POST",
      `/v1/costs/${encodeURIComponent(chargeId)}/reconcile`,
      { actualUsd, reference },
    );
  }
  async upload(
    projectId: string,
    name: string,
    data: Blob | Uint8Array,
    signal?: AbortSignal,
  ) {
    return this.jsonResult(
      await fetch(
        `${this.baseUrl}/v1/assets?projectId=${encodeURIComponent(projectId)}&name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: {
            ...this.headers(false),
            "Content-Type": "application/octet-stream",
          },
          body: data as BodyInit,
          signal,
        },
      ),
    ).then((value) => {
      if (!isAsset(value))
        throw new FoundationHttpError(
          502,
          "invalid_response",
          "Asset response is invalid",
        );
      return value;
    });
  }
  async download(assetId: string, signal?: AbortSignal) {
    const response = await fetch(
      `${this.baseUrl}/v1/assets/${encodeURIComponent(assetId)}/content`,
      { headers: this.headers(false), signal },
    );
    if (!response.ok) {
      await this.jsonResult(response);
      throw new Error("Download failed");
    }
    return response.blob();
  }
  async *events(
    runId: string,
    after = 0,
    signal?: AbortSignal,
    options: EventStreamOptions = {},
  ): AsyncGenerator<FoundationEvent> {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("Invalid event cursor");
    let cursor = after,
      retries = 0;
    const maximum =
      options.reconnect === false ? 0 : (options.maxReconnects ?? 8);
    while (true) {
      signal?.throwIfAborted();
      try {
        const response = await fetch(
          `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events?after=${cursor}`,
          {
            headers: {
              ...this.headers(false),
              Accept: "text/event-stream",
              ...(cursor ? { "Last-Event-ID": String(cursor) } : {}),
            },
            signal,
          },
        );
        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => ({}));
          const error =
            isRecord(payload) && isRecord(payload.error)
              ? payload.error
              : undefined;
          throw new FoundationHttpError(
            response.status,
            typeof error?.code === "string" ? error.code : "http_error",
            typeof error?.message === "string"
              ? error.message
              : `SSE HTTP ${response.status}`,
          );
        }
        if (
          !(response.headers.get("content-type") || "").includes(
            "text/event-stream",
          ) ||
          !response.body
        )
          throw new Error("Expected an event stream");
        for await (const frame of decodeEventStream(response.body, {
          signal,
          maxFrameChars: options.maxFrameChars || 64 * 1024 * 1024,
        })) {
          const event = parseEvent(frame.data);
          if (event.runId !== runId) throw new Error("Event run ID mismatch");
          if (event.seq !== null) {
            if (event.seq <= cursor) continue;
            cursor = event.seq;
            retries = 0;
          }
          yield event;
          if (event.type === "run.completed") return;
        }
        throw new Error("Event stream ended before run settlement");
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        if (error instanceof FoundationHttpError && !error.retryable)
          throw error;
        if (retries++ >= maximum) throw error;
      }
      await pause(
        Math.min(
          (options.retryMs ?? 250) * 2 ** Math.min(retries - 1, 5),
          10000,
        ),
        signal,
      );
    }
  }
}
