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
  webSearch?: NativeWebSearchResult;
}
/** Citation offsets refer to textOf(assistant), using JS string indices. */
export interface WebCitation {
  url: string;
  title: string;
  startIndex: number;
  endIndex: number;
}
export interface NativeWebSearchCall {
  id: string;
  status?: string;
  action?: {
    type: string;
    query?: string;
    queries?: string[];
    url?: string;
    sources?: { url: string; title?: string }[];
  };
}
export interface NativeWebSearchResult {
  calls: NativeWebSearchCall[];
  citations: WebCitation[];
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
  /** Starts sub-agents that act with the caller's permissions. */
  "agent",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
/** Behaviours that policy keys on, so rules do not depend on tool names. */
export type ToolRole =
  /** Records plan progress only; the one write a plan-autonomy session may make. */
  "plan-state";
export interface ToolResult {
  content: (TextPart | ImagePart)[];
  details?: unknown;
  isError?: boolean;
  artifacts?: string[];
}
export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  /** JSON Schema of the arguments; validated before every execute. */
  parameters: object;
  risk?: Risk;
  capabilities?: Capability[];
  /** Trusted host declaration of behaviours that permission rules recognise. */
  roles?: ToolRole[];
  /**
   * Trusted host declaration: capabilities a specific call needs beyond `capabilities`,
   * derived from its arguments before permission checks. Throw to deny the call.
   */
  constrain?(params: T, call: { routeId: string }): Capability[] | void;
  source?: { kind: "builtin" | "mcp" | "plugin" | "device"; id: string };
  /** Trusted host declaration. Undeclared tools take an exclusive global lock. */
  scheduling?: {
    parallelSafe: boolean;
    /**
     * The tool only waits on other runs (e.g. sub-agents): it takes no execution slot or lock,
     * so the work it waits for can use the shared scheduler without deadlocking.
     */
    detached?: boolean;
    resources?(params: T): { key: string; access: "read" | "write" }[];
  };
  execute(
    callId: string,
    params: T,
    signal?: AbortSignal,
    update?: (result: ToolResult) => void,
    execution?: { routeId: string },
  ): Promise<ToolResult>;
}
export interface ModelRequest {
  routeId: string;
  messages: Message[];
  tools: ToolDefinition[];
  /** Explicit per-request permission, independent of the route's advertised support. */
  nativeWebSearch?: boolean;
  maxOutputTokens?: number;
  toolChoice?: "auto" | "required" | "none";
  reasoningEffort?: import("../contracts.js").ReasoningEffort;
  reasoningBudgetTokens?: number;
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
          .filter(
            (p: unknown): p is TextPart =>
              typeof p === "object" &&
              p !== null &&
              "type" in p &&
              p.type === "text" &&
              "text" in p &&
              typeof p.text === "string",
          )
          .map((p: TextPart) => p.text)
          .join("\n")
      : "";
