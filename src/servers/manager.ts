import path from "node:path";
import { z } from "zod";
import type { Store } from "../storage/store.js";
import { id, invariant, now } from "../core/util.js";
import { ServerVault } from "./vault.js";
import { SshTransport } from "./ssh.js";
import { serverAccess } from "./access.js";
import {
  credentialsSchema, execInputSchema, probeSchema, serverInputSchema,
  serverProfileSchema, serverFactSchema, type ServerProfile, type ServerFact,
  type ServerIntegrationOptions, type ServerCredentials, type CommandEvidence,
} from "./types.js";

export class ServerManager {
  private readonly vault: ServerVault;
  readonly transport = new SshTransport();
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  private readonly access;
  private closed = false;
  constructor(readonly store: Store, dataDir: string, options: ServerIntegrationOptions = {}) {
    this.timeoutMs = z.number().int().min(100).max(300000).parse(options.timeoutMs ?? 30000);
    this.maxOutputBytes = z.number().int().min(64).max(4 * 1024 * 1024).parse(options.maxOutputBytes ?? 64000);
    this.vault = new ServerVault(options.vaultPath ?? path.join(dataDir, "server-vault", "credentials.json"), options.vaultKeyEnv);
    this.access = serverAccess(store);
  }
  list(projectId?: string): ServerProfile[] {
    if (projectId) this.store.project(projectId);
    return this.store.list<unknown>("servers").map((value) => serverProfileSchema.parse(value))
      .filter((server) => !projectId || server.projectIds.includes(projectId));
  }
  profile(serverId: string): ServerProfile {
    return serverProfileSchema.parse(this.store.get<unknown>("servers", serverId));
  }
  owned(serverId: string, projectId: string): ServerProfile {
    this.store.project(projectId);
    const server = this.profile(serverId);
    invariant(server.projectIds.includes(projectId), "Server is not available to this project", 403, "server_project_denied");
    return server;
  }
  private checkProjects(projectIds: string[]): void {
    for (const projectId of projectIds) this.store.project(projectId);
    invariant(new Set(projectIds).size === projectIds.length, "Duplicate server project IDs");
  }
  create(input: unknown): ServerProfile {
    const value = serverInputSchema.parse(input);
    this.checkProjects(value.projectIds);
    invariant(this.store.count("servers") < 1000, "Server profile limit reached", 429);
    const timestamp = now();
    return this.store.put("servers", { ...value, id: id("server"), credentialKinds: [], createdAt: timestamp, updatedAt: timestamp });
  }
  update(serverId: string, input: unknown): Promise<ServerProfile> {
    const value = serverInputSchema.parse(input);
    this.checkProjects(value.projectIds);
    return this.access.change(serverId, async () => {
      const previous = this.profile(serverId);
      return this.store.put("servers", { ...previous, ...value, updatedAt: now() });
    });
  }
  remove(serverId: string): Promise<{ removed: true }> {
    return this.access.change(serverId, async () => {
      const server = this.profile(serverId);
      if (server.credentialRef) await this.vault.remove(server.credentialRef);
      this.store.transaction(() => {
        for (const value of this.store.list<unknown>("server-facts", { serverId }))
          this.store.remove("server-facts", serverFactSchema.parse(value).id);
        this.store.remove("servers", serverId);
      });
      return { removed: true };
    });
  }
  setCredentials(serverId: string, input: unknown): Promise<ServerProfile> {
    const credentials = credentialsSchema.parse(input);
    return this.access.change(serverId, async () => {
      const server = this.profile(serverId);
      const credentialRef = await this.vault.put(serverId, credentials, server.credentialRef);
      const credentialKinds: ServerProfile["credentialKinds"] = [];
      if (credentials.password) credentialKinds.push("password");
      if (credentials.privateKey) credentialKinds.push("privateKey");
      return this.store.put("servers", { ...server, credentialRef, credentialKinds, updatedAt: now() });
    });
  }
  deleteCredentials(serverId: string): Promise<ServerProfile> {
    return this.access.change(serverId, async () => {
      const { credentialRef, ...server } = this.profile(serverId);
      if (credentialRef) await this.vault.remove(credentialRef);
      return this.store.put("servers", { ...server, credentialKinds: [], updatedAt: now() });
    });
  }
  async credentials(server: ServerProfile): Promise<ServerCredentials> {
    invariant(server.credentialRef, "No server credentials configured", 409, "server_credentials_missing");
    return this.vault.get(server.id, server.credentialRef);
  }
  async withAccess<T>(serverId: string, projectId: string, signal: AbortSignal | undefined,
    operation: (server: ServerProfile, stop: AbortSignal) => Promise<T>): Promise<T> {
    invariant(!this.closed, "Server integration closed", 409);
    const server = this.owned(serverId, projectId), lease = this.access.acquire(serverId);
    const stop = AbortSignal.any([lease.controller.signal, ...(signal ? [signal] : [])]);
    try { stop.throwIfAborted(); return await operation(server, stop); }
    finally { lease.release(); }
  }
  read(serverId: string, projectId?: string): { server: ServerProfile; facts: ServerFact[] } {
    const server = projectId ? this.owned(serverId, projectId) : this.profile(serverId);
    const facts = this.store.list<unknown>("server-facts", { serverId, ...(projectId ? { projectId } : {}) },
      { descending: true, limit: 100 }).reverse().map((value) => serverFactSchema.parse(value));
    return { server, facts };
  }
  probe(input: unknown, signal?: AbortSignal): Promise<{ host: string; port: number; hostFingerprint: string; trusted: false }> {
    const value = probeSchema.parse(input);
    return this.transport.probe(value.host, value.port, this.timeoutMs, signal);
  }
  private persist(projectId: string, serverId: string, text: string, evidence?: CommandEvidence, source: "agent" | "user" = "agent"): ServerFact {
    const timestamp = now();
    const stdout = evidence ? this.boundedOutput(this.vault.redact(evidence.stdout), this.maxOutputBytes) : "";
    const stderr = evidence ? this.boundedOutput(this.vault.redact(evidence.stderr), this.maxOutputBytes - Buffer.byteLength(stdout)) : "";
    const fact = serverFactSchema.parse({
      id: id("server-fact"), projectId, serverId,
      kind: evidence ? "observation" : "note", source: evidence ? "command" : source,
      text: this.vault.redact(text), createdAt: timestamp,
      ...(evidence ? { evidence: {
        ...evidence, command: this.vault.redact(evidence.command), stdout, stderr,
        truncated: evidence.truncated || stdout !== this.vault.redact(evidence.stdout) || stderr !== this.vault.redact(evidence.stderr),
        ...(evidence.error ? { error: this.vault.redact(evidence.error) } : {}),
      } } : {}),
      ...(evidence?.status === "completed" ? { verifiedAt: evidence.finishedAt } : {}),
    });
    return this.store.put("server-facts", fact);
  }
  private boundedOutput(text: string, bytes: number): string {
    return new TextDecoder("utf-8").decode(Buffer.from(text).subarray(0, Math.max(0, bytes)), { stream: true });
  }
  async remember(serverId: string, projectId: string, text: string, source: "agent" | "user" = "agent"): Promise<ServerFact> {
    z.string().min(1).max(12000).parse(text);
    return this.withAccess(serverId, projectId, undefined, async (server, stop) => {
      // Load this server's known values for local redaction, including short passwords.
      if (server.credentialRef) await this.credentials(server);
      stop.throwIfAborted();
      return this.persist(projectId, serverId, text, undefined, source);
    });
  }
  async exec(projectId: string, input: unknown, signal?: AbortSignal): Promise<{ result: CommandEvidence; factId: string }> {
    const value = execInputSchema.parse(input);
    return this.withAccess(value.serverId, projectId, signal, async (server, stop) => {
      const credentials = await this.credentials(server);
      stop.throwIfAborted();
      const result = await this.transport.exec(server, credentials, value.command, {
        timeoutMs: Math.min(value.timeoutMs ?? this.timeoutMs, this.timeoutMs), maxOutputBytes: this.maxOutputBytes, signal: stop,
      });
      const fact = this.persist(projectId, server.id, `Command ${result.status}; exit ${result.exitCode ?? "unobserved"}`, result);
      invariant(fact.evidence, "Missing command evidence", 500);
      return { result: fact.evidence, factId: fact.id };
    });
  }
  sanitize(text: string): string { return this.vault.redact(text); }
  close(): void { this.closed = true; this.transport.close(); }
}
