import { z } from "zod";

export const auditIdentifier = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
export const auditStages = z
  .array(z.enum(["input", "tool"]))
  .min(1)
  .max(2)
  .transform((stages) => [...new Set(stages)]);

const textRuleSchema = z
  .object({
    id: auditIdentifier.refine((id) => !id.startsWith("builtin.")),
    terms: z.array(z.string().min(1).max(500)).min(1).max(32),
    action: z.enum(["flag", "deny"]),
    stages: auditStages.default(["input"]),
    caseSensitive: z.boolean().default(false),
  })
  .strict();

export const securityAuditSchema = z
  .object({
    mode: z.enum(["off", "audit", "enforce"]).default("off"),
    timeoutMs: z.number().int().min(10).max(60_000).default(1000),
    onError: z.enum(["allow", "deny"]).default("deny"),
    promptInjection: z.enum(["off", "flag", "deny"]).default("flag"),
    textRules: z
      .array(textRuleSchema)
      .max(32)
      .refine(
        (rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
        "Security audit rule identifiers must be unique",
      )
      .default([]),
  })
  .strict();

export type SecurityAuditConfig = z.infer<typeof securityAuditSchema>;
