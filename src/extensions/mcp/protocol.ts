import { AppError, invariant } from "../../core/util.js";
import { wireMember, wireObject, type WireObject } from "../../core/wire.js";
import { decodeEventStream } from "../../transport/sse.js";

// JSON-RPC framing and request types shared by the MCP client and its task modules.
export { wireMember, wireObject, type WireObject };
export const MCP_MODERN_VERSION = "2026-07-28";
export interface MCPRequestContext {
  requestId: RpcId;
  method: string;
  params: WireObject;
  localContext?: unknown;
  signal: AbortSignal;
  setTaskStatus?: (status: "working" | "input_required") => void;
}
export type MCPInputHandler = (
  params: unknown,
  context: MCPRequestContext,
) => Promise<unknown>;
export interface MCPRequestOptions {
  /** Host-only absolute callback deadline; never serialized to the peer. */
  taskDeadline?: number;
  signal?: AbortSignal;
  timeout?: number;
  progress?: (value: WireObject) => void;
  localContext?: unknown;
  onSubscriptionAcknowledged?: (filter: MCPNotificationFilter) => void;
}
export interface MCPNotificationFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
  taskIds?: string[];
}

export const MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
export type RpcId = number | string;
export type RpcMessage = {
  jsonrpc: "2.0";
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
/**
 * Negotiated server capabilities. Only the flags this client reads are named; like
 * every wire member they are truthiness checks, never trusted as specific types.
 */
export interface MCPServerCapabilities {
  [name: string]: unknown;
  extensions?: WireObject;
  tools?: { listChanged?: unknown };
  resources?: { listChanged?: unknown; subscribe?: unknown };
  prompts?: { listChanged?: unknown };
  tasks?: { requests?: { tools?: { call?: unknown } } };
}
/** A tools/list entry that passed validation; other members stay wire values. */
export interface MCPToolDeclaration extends WireObject {
  name: string;
  description?: string;
  inputSchema: WireObject;
  outputSchema?: WireObject;
  execution?: WireObject & {
    taskSupport?: "forbidden" | "optional" | "required";
  };
}
/** A tool result that passed validation; `content` is always an array. */
export interface MCPToolResult extends WireObject {
  content: unknown[];
  structuredContent?: unknown;
  isError?: unknown;
}
export type MCPProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
export function isProtocolVersion(value: unknown): value is MCPProtocolVersion {
  return (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(value);
}
/** True for an array naming at least one protocol version this client speaks. */
export function isProtocolVersionList(value: unknown): boolean {
  return Array.isArray(value) && value.some(isProtocolVersion);
}
export function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || typeof value === "number";
}
export class MCPProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number | string = "mcp_protocol_error",
    readonly data?: unknown,
  ) {
    super(message);
  }
}
export function rpc(value: unknown): RpcMessage {
  const message = wireObject(value);
  invariant(
    message && message.jsonrpc === "2.0",
    "Invalid MCP JSON-RPC message",
    502,
  );
  invariant(
    message.id === undefined ||
      typeof message.id === "string" ||
      Number.isSafeInteger(message.id),
    "Invalid MCP request ID",
    502,
  );
  if (message.method !== undefined)
    invariant(
      typeof message.method === "string" && message.method.length > 0,
      "Invalid MCP method",
      502,
    );
  else
    invariant(
      message.id !== undefined && "result" in message !== "error" in message,
      "Invalid MCP response",
      502,
    );
  if (message.error)
    invariant(
      Number.isInteger(wireMember(message.error, "code")) &&
        typeof wireMember(message.error, "message") === "string",
      "Invalid MCP error",
      502,
    );
  return message as RpcMessage;
}
/** Empty frames carry MCP resume cursors; the shared decoder also enforces UTF-8 bytes. */
export function frames(response: Response, max: number, signal: AbortSignal) {
  invariant(response.body, "MCP response has no body", 502);
  return decodeEventStream(response.body, {
    signal,
    maxFrameChars: max,
    maxFrameBytes: max,
    emitEmptyFrames: true,
    error: (message) => new AppError(502, "invalid_request", "MCP " + message),
  });
}
