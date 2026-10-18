import { z } from "zod";

export const serverIdSchema = z.string().regex(/^server_[a-f0-9-]{36}$/);
export const hostSchema = z.string().min(1).max(253).refine(
  (host) => !/[\s\x00-\x1f/@\\]/.test(host), "Host must be an IP or hostname",
);
export const fingerprintSchema = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/);
export const serverInputSchema = z.object({
  name: z.string().min(1).max(180),
  host: hostSchema,
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(180).refine((value) => !/[\x00-\x1f]/.test(value)),
  environment: z.string().max(100).default(""),
  tags: z.array(z.string().min(1).max(100)).max(50).default([]),
  projectIds: z.array(z.string().min(1)).min(1).max(100),
  hostFingerprint: fingerprintSchema,
}).strict();
export const serverProfileSchema = serverInputSchema.extend({
  id: serverIdSchema,
  credentialRef: z.string().uuid().optional(),
  credentialKinds: z.array(z.enum(["password", "privateKey"])),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type ServerInput = z.infer<typeof serverInputSchema>;
export type ServerProfile = z.infer<typeof serverProfileSchema>;
export const credentialsSchema = z.object({
  password: z.string().min(1).max(16384).optional(),
  privateKey: z.string().min(1).max(65536).optional(),
  passphrase: z.string().min(1).max(16384).optional(),
}).strict().refine((value) => Boolean(value.password || value.privateKey), "Credentials required")
  .refine((value) => !value.passphrase || Boolean(value.privateKey), "Passphrase requires a private key");
/** Host-only input: never include this model in Agent tools or ordinary memory. */
export type ServerCredentials = z.infer<typeof credentialsSchema>;
export const execInputSchema = z.object({
  serverId: serverIdSchema,
  command: z.string().min(1).max(16000).refine((value) => !value.includes("\0")),
  timeoutMs: z.number().int().min(100).max(300000).optional(),
}).strict();
export const commandEvidenceSchema = z.object({
  command: z.string(),
  status: z.enum(["completed", "unknown", "failed"]),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  truncated: z.boolean(),
  error: z.string().optional(),
}).strict();
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;
export const serverFactSchema = z.object({
  id: z.string(), serverId: serverIdSchema, projectId: z.string(),
  kind: z.enum(["observation", "note"]),
  source: z.enum(["command", "agent", "user"]),
  text: z.string().max(24000),
  createdAt: z.string().datetime(), verifiedAt: z.string().datetime().optional(),
  evidence: commandEvidenceSchema.optional(),
}).strict();
export type ServerFact = z.infer<typeof serverFactSchema>;
export interface ServerIntegrationOptions {
  vaultPath?: string;
  vaultKeyEnv?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export const probeSchema = z.object({
  host: hostSchema, port: z.number().int().min(1).max(65535).default(22),
}).strict();
export const noteSchema = z.object({
  serverId: serverIdSchema, text: z.string().min(1).max(12000),
}).strict();
export const remotePathSchema = z.string().min(1).max(4000)
  .refine((value) => value.startsWith("/") && !/[\\\x00-\x1f]/.test(value)
    && !value.split("/").some((part) => part === "." || part === ".."), "Normalized absolute remote path required");
export const transferInputSchema = z.object({
  serverId: serverIdSchema, remotePath: remotePathSchema,
  timeoutMs: z.number().int().min(100).max(300000).optional(),
}).strict();
export const uploadInputSchema = transferInputSchema.extend({ assetId: z.string().min(1) });
