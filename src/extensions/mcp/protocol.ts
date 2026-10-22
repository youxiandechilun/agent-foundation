import { AppError, invariant } from "../../core/util.js";
import { decodeEventStream } from "../../transport/sse.js";

// JSON-RPC framing and request types shared by the MCP client and its task modules.
export const MCP_MODERN_VERSION = "2026-07-28";
export interface MCPRequestContext {
  requestId: RpcId;
  method: string;
  params: any;
  localContext?: unknown;
  signal: AbortSignal;
  setTaskStatus?: (status: "working" | "input_required") => void;
}
export type MCPInputHandler = (
  params: any,
  context: MCPRequestContext,
) => Promise<unknown>;
export interface MCPRequestOptions {
  /** Host-only absolute callback deadline; never serialized to the peer. */
  taskDeadline?: number;
  signal?: AbortSignal;
  timeout?: number;
  progress?: (value: any) => void;
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
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
};
export class MCPProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number | string = "mcp_protocol_error",
    readonly data?: unknown,
  ) {
    super(message);
  }
}
export function rpc(value: any): RpcMessage {
  invariant(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.jsonrpc === "2.0",
    "Invalid MCP JSON-RPC message",
    502,
  );
  invariant(
    value.id === undefined ||
      typeof value.id === "string" ||
      Number.isSafeInteger(value.id),
    "Invalid MCP request ID",
    502,
  );
  if (value.method !== undefined)
    invariant(
      typeof value.method === "string" && value.method.length > 0,
      "Invalid MCP method",
      502,
    );
  else
    invariant(
      value.id !== undefined && "result" in value !== "error" in value,
      "Invalid MCP response",
      502,
    );
  if (value.error)
    invariant(
      Number.isInteger(value.error.code) &&
        typeof value.error.message === "string",
      "Invalid MCP error",
      502,
    );
  return value;
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
