import type { Message, Capability } from "./runtime/types.js";
import type { TeamBinding } from "./collaboration/types.js";

export type ReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type Mode = "chat" | "code" | "office" | (string & {});
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Project {
  id: string;
  name: string;
  root: string;
  createdAt: string;
}
export type Autonomy = "plan" | "assist" | "autonomous";
export interface Session {
  id: string;
  projectId: string;
  name: string;
  mode: Mode;
  routeId: string;
  createdAt: string;
  autonomy?: Autonomy;
  archived?: boolean;
  agentId?: string;
  subagentsEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  reasoningBudgetTokens?: number;
  collaboration?: TeamBinding;
  teamRootSessionId?: string;
  teamMemberId?: string;
  forkedFromSessionId?: string;
  forkedThroughMessageId?: string;
  /** Explicit cross-session reading grants; project scope still applies. */
  readableSessionIds?: string[];
  /** Set on delegated sessions; their effective permissions include the parent's restrictions. */
  parentSessionId?: string;
  /** Nesting level of a sub-agent session (1 = direct child of a user session). */
  delegationDepth?: number;
}
export interface Run {
  id: string;
  sessionId: string;
  status: RunStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** Requested structured-output schema and the validated result, when used. */
  outputSchema?: Record<string, unknown>;
  output?: unknown;
}
export interface Asset {
  id: string;
  projectId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: string;
  origin: "upload" | "artifact" | "model";
}
export interface Input {
  teamRoleDecision?: "redistribute" | "add_agents";
  contextSessionIds?: string[];
  resumeFromRunId?: string;
  text?: string;
  assetIds?: string[];
  delivery?: "start" | "steer" | "enqueue";
  clientMessageId?: string;
  skillIds?: string[];
  /** JSON Schema for a structured final result (start inputs only). */
  outputSchema?: Record<string, unknown>;
}
export interface FoundationEvent {
  schemaVersion: 1;
  id: string;
  runId: string;
  sessionId: string;
  type: string;
  timestamp: string;
  seq: number | null;
  data: Record<string, unknown>;
}
export interface Job {
  costEntryId?: string;
  routeVersion?: string;
  id: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
  routeId: string;
  kind: "image" | "video";
  status:
    "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  prompt: string;
  idempotencyKey: string;
  requestHash: string;
  remoteId?: string;
  output?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  request?: MediaRequest;
  progress?: number;
  outputs?: MediaOutput[];
  adapterState?: Record<string, unknown>;
}
export interface MediaRequest {
  schemaVersion: 1;
  kind: "image" | "video";
  operation: "generate" | "edit" | "variation";
  prompt: string;
  inputAssets: string[];
  parameters: {
    width?: number;
    height?: number;
    durationSeconds?: number;
    aspectRatio?: string;
    seed?: number;
    count?: number;
    [key: string]: unknown;
  };
}
export interface MediaOutput {
  type: "image" | "video" | "text";
  mime?: string;
  url?: string;
  base64?: string;
  text?: string;
  assetId?: string;
}
export interface Approval {
  id: string;
  runId: string;
  tool: string;
  args: unknown;
  fingerprint: string;
  status: "pending" | "approved" | "denied" | "expired";
  expiresAt: string;
}
export interface StoredMessage {
  id: string;
  runId: string;
  message: Message;
}
export interface MemoryEntry {
  revision?: number;
  id: string;
  projectId: string;
  namespace: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}
export interface MemoryProposal {
  id: string;
  projectId: string;
  namespace: string;
  content: string;
  tags: string[];
  source: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  memoryId?: string;
}
export interface Skill {
  source?: string;
  version?: string;
  resources?: {
    path: string;
    encoding: "utf8" | "base64";
    data: string;
    sha256: string;
    bytes: number;
  }[];
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  capabilities: Capability[];
  sha256: string;
  createdAt: string;
}
export interface PolicyRule {
  id: string;
  effect: "allow" | "ask" | "deny";
  capabilities: Capability[];
  tools?: string[];
  projectId?: string;
  routeId?: string;
  mode?: Mode;
  pluginId?: string;
  expiresAt?: string;
}
export interface AgentDefinition {
  id: string;
  name: string;
  instructions: string;
  mode: Mode;
  routeId?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningBudgetTokens?: number;
  skillIds: string[];
  toolAllowlist: string[];
  maxSteps: number;
  memoryNamespace: string;
}
export interface InboxEntry {
  skillIds?: string[];
  id: string;
  runId: string;
  delivery: "start" | "steer" | "enqueue";
  message: Message;
  status: "pending" | "applied" | "rejected";
  createdAt: string;
}
export interface ToolEffect {
  id: string;
  runId: string;
  callId: string;
  tool: string;
  argsHash: string;
  status:
    "prepared" | "running" | "completed" | "failed" | "unknown" | "skipped";
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export const terminalStatuses = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
