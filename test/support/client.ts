import { FoundationClient } from "../../src/client.js";
import assert from "node:assert/strict";
import type { Kernel } from "../../src/core/kernel.js";
import type { MCPManager } from "../../src/extensions/mcp/manager.js";
import type { PluginManager } from "../../src/extensions/plugins/manager.js";
import type { SkillManager } from "../../src/extensions/skills.js";
import type {
  BrowserManager,
  BrowserAction,
  BrowserActionResult,
} from "../../src/host/browser/manager.js";
import type { BrowserBridge } from "../../src/host/browser/bridge.js";
import type { ComputerController } from "../../src/host/computer/manager.js";
import type { Office } from "../../src/host/office/manager.js";
import type { NodeManager } from "../../src/host/nodes.js";
import type { CostLedger } from "../../src/runtime/cost.js";
import type {
  Asset,
  Job,
  Session,
  StoredMessage,
  FoundationEvent,
  Approval,
} from "../../src/contracts.js";

type Result<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;
type Page<K extends string, T> = Record<K, T[]> & {
  cursor: number;
  hasMore: boolean;
};
type MCPResult<P extends string> = P extends `${string}/auth-begin`
  ? Result<MCPManager["authBegin"]>
  : P extends `${string}/auth-complete`
    ? Result<MCPManager["authComplete"]>
    : P extends `${string}/registration-read` | `${string}/registration-remote`
      ? Result<MCPManager["remoteRegistration"]>
      : P extends `${string}/registration`
        ? Result<MCPManager["registrationStatus"]>
        : P extends `${string}/register`
          ? Result<MCPManager["registerClient"]>
          : P extends `${string}/tools`
            ? { tools: Result<MCPManager["catalog"]> }
            : P extends `${string}/client-tasks`
              ? { tasks: Result<MCPManager["receivedTasks"]> }
              : unknown;
type Response<
  P extends string,
  M extends string,
  D,
> = P extends "/v1/applications"
  ? { enabled: string[] }
  : P extends "/v1/browser"
    ? M extends "POST"
      ? Result<BrowserManager["open"]>
      : { browsers: Result<BrowserManager["list"]> }
    : P extends "/v1/nodes/pair"
      ? Result<NodeManager["pair"]>
      : P extends "/v1/computer/action"
        ? Result<ComputerController["action"]>
        : P extends `/v1/office/${infer O}`
          ? O extends keyof OfficeResults
            ? OfficeResults[O]
            : unknown
          : P extends "/v1/jobs"
            ? M extends "POST"
              ? Job
              : Page<"jobs", Job>
            : P extends `/v1/jobs/${string}`
              ? Job
              : P extends "/v1/plugins"
                ? Result<PluginManager["install"]>
                : P extends "/v1/skills"
                  ? Result<SkillManager["install"]>
                  : P extends "/v1/mcp"
                    ? Result<MCPManager["get"]>
                    : P extends `/v1/mcp/${string}`
                      ? MCPResult<P>
                      : P extends `/v1/memories/${string}`
                        ? import("../../src/contracts.js").MemoryEntry
                        : P extends `/v1/agents/${string}/start`
                          ? Result<Kernel["submit"]>
                          : P extends `/v1/plugins/${string}/export`
                            ? Result<PluginManager["export"]>
                            : P extends "/v1/migrations/import"
                              ? Result<Kernel["importMigration"]>
                              : P extends "/v1/sessions/import"
                                ? Session
                                : P extends `/v1/sessions/${string}/export`
                                  ? {
                                      format: "foundation-session-v1";
                                      session: Session;
                                      messages: StoredMessage[];
                                    }
                                  : P extends `/v1/sessions/${string}/migration`
                                    ? Result<Kernel["exportMigration"]>
                                    : P extends `/v1/sessions/${string}/fork`
                                      ? Session
                                      : P extends `/v1/sessions/${string}`
                                        ? {
                                            session: Session;
                                            messages: StoredMessage[];
                                            runs: import("../../src/contracts.js").Run[];
                                          }
                                        : P extends `/v1/runs/${string}/context`
                                          ? {
                                              inputTokens: number;
                                              precision: string;
                                              counter: string;
                                            }
                                          : P extends `/v1/runs/${string}/events${string}`
                                            ? {
                                                events: FoundationEvent[];
                                                cursor: number;
                                                status: string;
                                              }
                                            : P extends `/v1/runs/${string}`
                                              ? import("../../src/contracts.js").Run
                                              : P extends "/v1/approvals"
                                                ? Page<"approvals", Approval>
                                                : P extends `/v1/approvals/${string}/resolve`
                                                  ? Approval
                                                  : P extends `/v1/assets/${string}`
                                                    ? Asset
                                                    : P extends `/v1/browser/${string}/action`
                                                      ? D extends {
                                                          action: infer A extends
                                                            BrowserAction["action"];
                                                        }
                                                        ? BrowserActionResult<A>
                                                        : BrowserActionResult
                                                      : unknown;
type OfficeResults = {
  inspect: Result<Office["inspect"]>;
  create: Result<Office["create"]>;
  table: Result<Office["table"]>;
  analyze: Result<Office["analyze"]>;
  transform: Result<Office["transform"]>;
  "edit-sheet": Result<Office["editSpreadsheet"]>;
  "replace-text": Result<Office["replaceText"]>;
  "compose-pdf": Result<Office["composePdf"]>;
  "preview-pdf": Result<Office["renderPdf"]>;
};
type BridgeResult<A extends string> = A extends "tabs"
  ? { url: string }[]
  : A extends "screenshot"
    ? { asset: Asset }
    : { title: string; text: string; url: string; tabId: number };

/** Fixtures use the actual service return contracts; arbitrary HTTP calls remain unknown. */
export class TestClient extends FoundationClient {
  request<M extends string, P extends string, const D = undefined>(
    method: M,
    route: P,
    data?: D,
    signal?: AbortSignal,
  ): Promise<Response<P, M, D>>;
  override request<T = unknown>(
    method: string,
    route: string,
    data?: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  override request<T = unknown>(
    method: string,
    route: string,
    data?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return super.request<T>(method, route, data, signal);
  }
  override browserOpen(...args: Parameters<FoundationClient["browserOpen"]>) {
    return super.browserOpen(...args) as Promise<
      Result<BrowserManager["open"]>
    >;
  }
  override browserPair(...args: Parameters<FoundationClient["browserPair"]>) {
    return super.browserPair(...args) as Promise<Result<BrowserBridge["pair"]>>;
  }
  browserAction<A extends BrowserAction["action"]>(
    browserId: string,
    projectId: string,
    action: Record<string, unknown> & { action: A },
    signal?: AbortSignal,
  ): Promise<BrowserActionResult<A>>;
  override browserAction(
    ...args: Parameters<FoundationClient["browserAction"]>
  ): Promise<BrowserActionResult>;
  override browserAction(
    ...args: Parameters<FoundationClient["browserAction"]>
  ) {
    return super.browserAction(...args) as Promise<BrowserActionResult>;
  }
  browserBridgeAction<A extends string>(
    nodeId: string,
    projectId: string,
    action: Record<string, unknown> & { action: A },
    signal?: AbortSignal,
  ): Promise<BridgeResult<A>>;
  override browserBridgeAction(
    ...args: Parameters<FoundationClient["browserBridgeAction"]>
  ): Promise<unknown>;
  override browserBridgeAction(
    ...args: Parameters<FoundationClient["browserBridgeAction"]>
  ) {
    return super.browserBridgeAction(...args);
  }
  override computerAction(
    ...args: Parameters<FoundationClient["computerAction"]>
  ) {
    return super.computerAction(...args) as Promise<
      Result<ComputerController["action"]>
    >;
  }
  office<O extends keyof OfficeResults>(
    operation: O,
    projectId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OfficeResults[O]>;
  override office(
    ...args: Parameters<FoundationClient["office"]>
  ): Promise<OfficeResults[keyof OfficeResults]>;
  override office(...args: Parameters<FoundationClient["office"]>) {
    return super.office(...args) as Promise<OfficeResults[keyof OfficeResults]>;
  }
  override exportMigration(
    ...args: Parameters<FoundationClient["exportMigration"]>
  ) {
    return super.exportMigration(...args) as Promise<
      Result<Kernel["exportMigration"]>
    >;
  }
  override importMigration(
    ...args: Parameters<FoundationClient["importMigration"]>
  ) {
    return super.importMigration(...args) as Promise<
      Result<Kernel["importMigration"]>
    >;
  }
  override beginMCPOAuth(
    ...args: Parameters<FoundationClient["beginMCPOAuth"]>
  ) {
    return super.beginMCPOAuth(...args) as Promise<
      Result<MCPManager["authBegin"]>
    >;
  }
  override completeMCPOAuth(
    ...args: Parameters<FoundationClient["completeMCPOAuth"]>
  ) {
    return super.completeMCPOAuth(...args) as Promise<
      Result<MCPManager["authComplete"]>
    >;
  }
  override registerMCPOAuth(
    ...args: Parameters<FoundationClient["registerMCPOAuth"]>
  ) {
    return super.registerMCPOAuth(...args) as Promise<
      Result<MCPManager["registerClient"]>
    >;
  }
  override mcpRegistration(
    ...args: Parameters<FoundationClient["mcpRegistration"]>
  ) {
    return super.mcpRegistration(...args) as Promise<
      Result<MCPManager["registrationStatus"]>
    >;
  }
  async dynamicRegistration(serverId: string) {
    const status = await this.mcpRegistration(serverId);
    assert.ok("remoteManagement" in status);
    return status;
  }
  override async readMCPRegistration(
    ...args: Parameters<FoundationClient["readMCPRegistration"]>
  ) {
    const result = (await super.readMCPRegistration(...args)) as Result<
      MCPManager["remoteRegistration"]
    >;
    assert.equal(result.state, "registered");
    assert.ok("metadata" in result);
    return result;
  }
  override async updateMCPRegistration(
    ...args: Parameters<FoundationClient["updateMCPRegistration"]>
  ) {
    const result = (await super.updateMCPRegistration(...args)) as Result<
      MCPManager["remoteRegistration"]
    >;
    assert.ok(result.state === "registered");
    return result;
  }
  override async deleteMCPRegistration(
    ...args: Parameters<FoundationClient["deleteMCPRegistration"]>
  ) {
    const result = (await super.deleteMCPRegistration(...args)) as Result<
      MCPManager["remoteRegistration"]
    >;
    assert.ok(result.state === "unregistered");
    return result;
  }
  override resetMCPRegistration(
    ...args: Parameters<FoundationClient["resetMCPRegistration"]>
  ) {
    return super.resetMCPRegistration(...args) as Promise<
      Result<MCPManager["resetRegistration"]>
    >;
  }
  override mcpOAuthKeys(...args: Parameters<FoundationClient["mcpOAuthKeys"]>) {
    return super.mcpOAuthKeys(...args) as Promise<
      Result<MCPManager["keyStatus"]>
    >;
  }
  override rotateMCPOAuthKeys(
    ...args: Parameters<FoundationClient["rotateMCPOAuthKeys"]>
  ) {
    return super.rotateMCPOAuthKeys(...args) as Promise<
      Result<MCPManager["keyStatus"]>
    >;
  }
  override mcpClientTasks(
    ...args: Parameters<FoundationClient["mcpClientTasks"]>
  ) {
    return super.mcpClientTasks(...args) as Promise<{
      tasks: Result<MCPManager["receivedTasks"]>;
    }>;
  }
  override costs(...args: Parameters<FoundationClient["costs"]>) {
    return super.costs(...args) as Promise<Result<CostLedger["summary"]>>;
  }
  override reconcileCost(
    ...args: Parameters<FoundationClient["reconcileCost"]>
  ) {
    return super.reconcileCost(...args) as Promise<
      Result<CostLedger["reconcile"]>
    >;
  }
}
