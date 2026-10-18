import { z } from "zod";
import type { RunStatus } from "../contracts.js";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const teamDefinitionSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(120),
    mode: z.enum(["code", "office"]),
    coordinatorAgentId: identifier,
    memberAgentIds: z.array(identifier).min(1).max(20),
  })
  .strict()
  .refine(
    (team) => new Set(team.memberAgentIds).size === team.memberAgentIds.length,
    {
      message: "Team members must be unique",
    },
  )
  .refine((team) => !team.memberAgentIds.includes(team.coordinatorAgentId), {
    message: "The coordinator must be separate from assigned members",
  });

export const teamBindingInputSchema = z
  .object({
    teamId: identifier,
    kind: z.enum(["task", "brainstorm"]),
    goal: z.string().trim().min(1).max(12000),
    constraints: z
      .array(z.string().trim().min(1).max(2000))
      .max(40)
      .default([]),
    acceptance: z.array(z.string().trim().min(1).max(2000)).max(40).default([]),
    maxTurns: z.number().int().min(1).max(100).default(12),
  })
  .strict();

export type TeamDefinition = z.infer<typeof teamDefinitionSchema>;
export type TeamBindingInput = z.input<typeof teamBindingInputSchema>;
export interface TeamRoleGap {
  responsibility: string;
  reason: string;
  blocking: boolean;
  attemptedAssignments: { agentId: string; reason: string }[];
}
export interface TeamRoleReview {
  status: "ready" | "needs_user" | "awaiting_review";
  roles: {
    agentId: string;
    declaredResponsibility: string;
    optimizedResponsibility: string;
  }[];
  gaps: TeamRoleGap[];
  rationale: string;
  revision: number;
  decision?: "redistribute" | "add_agents";
  scopeChange?: {
    userQuote: string;
    reason: string;
    removedResponsibilities: string[];
    previousReviewRevision: number;
  };
}
export type TeamBinding = z.infer<typeof teamBindingInputSchema> & {
  revision: number;
  currentRequest?: string;
  roleReview?: TeamRoleReview;
};

export interface TeamTask {
  id: string;
  teamId: string;
  projectId: string;
  workspaceRoot: string;
  rootSessionId: string;
  rootRunId: string;
  memberAgentId: string;
  sessionId: string;
  runId?: string;
  binding: TeamBinding;
  prompt: string;
  declaredResponsibility: string;
  optimizedResponsibility: string;
  refinedResponsibility: string;
  scope: string[];
  deliverable: string;
  status: "preparing" | RunStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export const dispatchSchema = z
  .object({
    agentId: identifier,
    prompt: z.string().trim().min(1).max(40000),
    refinedResponsibility: z.string().trim().min(1).max(12000).optional(),
    scope: z.array(z.string().min(1).max(2000)).max(100),
    deliverable: z.string().trim().min(1).max(4000),
    wait: z.boolean().default(true),
  })
  .strict();
export type TeamDispatch = z.input<typeof dispatchSchema>;

export const roleGapSchema = z
  .object({
    responsibility: z.string().trim().min(1).max(2000),
    reason: z.string().trim().min(1).max(4000),
    blocking: z.boolean(),
    attemptedAssignments: z
      .array(
        z
          .object({
            agentId: identifier,
            reason: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .max(21),
  })
  .strict();
export const roleReviewSchema = z
  .object({
    roles: z
      .array(
        z
          .object({
            agentId: identifier,
            optimizedResponsibility: z.string().trim().min(1).max(12000),
          })
          .strict(),
      )
      .min(2)
      .max(21),
    gaps: z.array(roleGapSchema).max(40),
    rationale: z.string().trim().min(1).max(8000),
    scopeChange: z
      .object({
        userQuote: z.string().trim().min(4).max(4000),
        reason: z.string().trim().min(1).max(4000),
        removedResponsibilities: z
          .array(z.string().trim().min(1).max(2000))
          .min(1)
          .max(40),
      })
      .strict()
      .optional(),
  })
  .strict();
export const roleDecisionSchema = z
  .object({ decision: z.enum(["redistribute", "add_agents"]) })
  .strict();

export const statusSchema = z
  .object({
    taskId: z.string().min(1).max(200).optional(),
    waitMs: z.number().int().min(0).max(60000).default(0),
  })
  .strict();
export const readSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
