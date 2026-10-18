import type { JsonObject } from "../runtime/types.js";

export type SecurityAuditStage = "input" | "tool";
export type SecurityAuditRequest = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly routeId: string;
} & (
  | {
      readonly stage: "input";
      readonly inputId: string;
      readonly delivery: "start" | "steer" | "enqueue";
      readonly text: string;
      readonly assetIds: readonly string[];
    }
  | {
      readonly stage: "tool";
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments: JsonObject;
    }
);

export interface SecurityAuditFinding {
  code: string;
  severity: "low" | "medium" | "high";
  action: "flag" | "deny";
}

export interface SecurityAuditRule {
  id: string;
  stages: readonly SecurityAuditStage[];
  evaluate(
    request: SecurityAuditRequest,
    signal: AbortSignal,
  ): readonly SecurityAuditFinding[] | Promise<readonly SecurityAuditFinding[]>;
}

export interface SecurityAuditRecord {
  id: string;
  createdAt: string;
  projectId: string;
  sessionId: string;
  routeId: string;
  stage: SecurityAuditStage;
  inputId?: string;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  mode: "audit" | "enforce";
  decision: "allow" | "deny";
  durationMs: number;
  findings: (SecurityAuditFinding & { ruleId: string })[];
  failures: { ruleId: string; kind: "error" | "invalid_result" | "timeout" }[];
}
