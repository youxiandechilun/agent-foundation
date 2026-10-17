/** Foundation-owned execution contracts. No agent framework types cross this boundary. */
export type JsonValue =
  null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface TextPart {
  type: "text";
  text: string;
}
export interface ImagePart {
  type: "image";
  mimeType: string;
  data: string;
}
export interface ThinkingPart {
  type: "thinking";
  thinking: string;
  signature?: string;
}
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
}
export type ContentPart = TextPart | ImagePart | ThinkingPart | ToolCall;
export interface Usage {
  reported?: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}
export interface UserMessage {
  role: "user";
  content: string | (TextPart | ImagePart)[];
  timestamp: number;
  inputId?: string;
}
export interface SystemMessage {
  role: "system";
  content: string;
  timestamp: number;
  requiredCapabilities?: Capability[];
}
export interface AssistantMessage {
  role: "assistant";
  content: ContentPart[];
  model: string;
  provider: string;
  stopReason: "stop" | "toolUse" | "length" | "error" | "aborted";
  timestamp: number;
  usage: Usage;
  responseId?: string;
  errorMessage?: string;
  providerState?: { protocol: string; routeId: string; items: unknown[] };
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextPart | ImagePart)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}
export type Message =
  SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
export type Risk = "read" | "write" | "execute" | "network" | "control";
export const CAPABILITIES = [
  "files.read",
  "files.write",
  "exec",
  "media",
  "browser",
  "computer",
  "mcp",
  "plugin",
  "memory.read",
  "memory.write",
  "network",
  "node",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export interface ToolResult {
  content: (TextPart | ImagePart)[];
  details?: unknown;
  isError?: boolean;
  artifacts?: string[];
}
export interface ToolDefinition<T = any> {
  name: string;
  description: string;
  parameters: Record<string, any>;
  risk?: Risk;
  capabilities?: Capability[];
  source?: { kind: "builtin" | "mcp" | "plugin" | "device"; id: string };
  /** Trusted host declaration. Undeclared tools take an exclusive global lock. */
  scheduling?: {
    parallelSafe: boolean;
    /**
     * The tool only waits on other runs (e.g. sub-agents): it takes no execution slot or lock,
     * so the work it waits for can use the shared scheduler without deadlocking.
     */
    detached?: boolean;
    resources?: (params: T) => { key: string; access: "read" | "write" }[];
  };
  execute: (
    callId: string,
    params: T,
    signal?: AbortSignal,
    update?: (result: ToolResult) => void,
    execution?: { routeId: string },
  ) => Promise<ToolResult>;
}
export interface ModelRequest {
  routeId: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxOutputTokens?: number;
  toolChoice?: "auto" | "required" | "none";
}
export type ModelDelta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-arguments"; callId: string; text: string };
export interface TextProvider {
  complete(
    request: ModelRequest,
    delta?: (event: ModelDelta) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<AssistantMessage>;
}
export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});
export const textOf = (message: Message | { content: unknown }) =>
  typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n")
      : "";
