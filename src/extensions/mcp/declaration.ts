import { z } from "zod";
import { oauthSchema } from "./auth/oauth.js";

export const declaration = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    name: z.string().max(100),
    transport: z.enum(["stdio", "http"]),
    protocol: z.enum(["legacy", "modern", "auto"]).default("auto"),
    oauth: oauthSchema.optional(),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    url: z.string().url().optional(),
    envRefs: z.record(z.string(), z.string()).default({}),
    isolation: z
      .object({
        boundary: z.enum(["native", "docker", "windows-appcontainer"]),
        workspaceRoot: z.string().optional(),
        readOnly: z.boolean().default(true),
        network: z.boolean().default(false),
      })
      .strict()
      .optional(),
    headerEnvRefs: z.record(z.string(), z.string()).default({}),
    clientFeatures: z
      .object({
        roots: z
          .array(
            z
              .object({
                uri: z.string().url(),
                name: z.string().max(200).optional(),
              })
              .strict(),
          )
          .max(100)
          .optional(),
        elicitation: z.boolean().default(false),
        taskExtension: z.boolean().default(false),
        tasks: z
          .object({
            sampling: z.boolean().default(false),
            elicitation: z.boolean().default(false),
            maxTasks: z.number().int().min(1).max(128).default(32),
            maxTtlMs: z.number().int().min(100).max(3600000).default(300000),
            pollIntervalMs: z.number().int().min(10).max(60000).default(100),
            pageSize: z.number().int().min(1).max(100).default(20),
          })
          .strict()
          .optional(),
        sampling: z
          .object({
            routeId: z.string().min(1),
            maxTokens: z.number().int().min(1).max(32768).default(1024),
            maxRequestsPerCall: z.number().int().min(1).max(32).default(4),
            tools: z.boolean().default(false),
            maxTools: z.number().int().min(1).max(64).default(32),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    enabled: z.boolean().default(false),
    toolAllowlist: z.array(z.string()).default(["*"]),
    timeoutMs: z.number().int().min(100).max(300000).default(30000),
    maxMessageBytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(8 * 1024 * 1024),
  })
  .strict();
export type MCPDeclaration = z.infer<typeof declaration> & {
  status?: string;
  error?: string;
};
