import { z } from "zod";
import { Store } from "../store.js";
import { id, now, invariant, redactJson } from "../util.js";
import { compileSchema } from "../runtime/json-schema.js";
export interface MCPOrigin {
  sessionId: string;
  runId: string;
  routeId: string;
  toolName: string;
  samplingRemaining?: number;
}
export interface MCPInteraction {
  id: string;
  serverId: string;
  kind: "elicitation" | "sampling";
  request: any;
  origin?: MCPOrigin;
  status: "pending" | "completed" | "declined" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
}
export function validateElicitation(params: any) {
  invariant(
    params &&
      typeof params.message === "string" &&
      params.message.length <= 32000,
    "Invalid elicitation message",
  );
  const mode = params.mode || "form";
  if (mode === "url") {
    invariant(
      typeof params.elicitationId === "string" &&
        params.elicitationId.length <= 200,
      "URL elicitation requires an ID",
    );
    const url = new URL(params.url);
    invariant(
      url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
      "Elicitation URL requires HTTPS or loopback HTTP",
    );
    invariant(
      !url.username && !url.password,
      "Credentials in elicitation URL are prohibited",
    );
    return;
  }
  invariant(mode === "form", "Unsupported elicitation mode");
  const schema = params.requestedSchema;
  invariant(
    schema?.type === "object" &&
      schema.properties &&
      Object.keys(schema.properties).length <= 100,
    "Invalid elicitation form schema",
  );
  for (const entry of Object.values(schema.properties) as any[]) {
    const scalar = ["string", "number", "integer", "boolean"].includes(
      entry?.type,
    );
    const enumArray =
      entry?.type === "array" &&
      entry.items?.type === "string" &&
      (Array.isArray(entry.items.enum) || Array.isArray(entry.items.oneOf));
    invariant(
      scalar || enumArray,
      "Elicitation accepts flat primitive fields or string enum arrays",
    );
    invariant(
      !entry.writeOnly && entry.format !== "password",
      "Sensitive data must use URL elicitation",
    );
  }
  compileSchema(schema);
}
export class MCPInteractions {
  private waiting = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  constructor(readonly store: Store) {
    for (const r of store.list<MCPInteraction>("mcp-interactions"))
      if (r.status === "pending")
        store.put("mcp-interactions", { ...r, status: "expired" });
  }
  list(serverId?: string) {
    return this.store
      .list<MCPInteraction>("mcp-interactions")
      .filter((r) => !serverId || r.serverId === serverId);
  }
  async ask(
    serverId: string,
    kind: MCPInteraction["kind"],
    request: any,
    signal: AbortSignal,
    origin?: MCPOrigin,
  ) {
    signal.throwIfAborted();
    invariant(this.waiting.size < 64, "Too many pending MCP interactions", 429);
    const entry: MCPInteraction = {
      id: id("mcp-input"),
      serverId,
      kind,
      request: redactJson(structuredClone(request)),
      origin: origin ? { ...origin, samplingRemaining: undefined } : undefined,
      status: "pending",
      createdAt: now(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };
    this.store.put("mcp-interactions", entry);
    if (origin)
      this.store.emit(origin.runId, "mcp.input_requested", {
        interaction: entry,
      });
    let timer: ReturnType<typeof setTimeout>;
    const abort = () =>
      this.reject(
        entry.id,
        "cancelled",
        signal.reason instanceof Error
          ? signal.reason
          : new Error("MCP interaction cancelled"),
      );
    try {
      return await new Promise<any>((resolve, reject) => {
        this.waiting.set(entry.id, { resolve, reject });
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(
          () =>
            this.reject(
              entry.id,
              "expired",
              new Error("MCP interaction expired"),
            ),
          300000,
        );
        if (signal.aborted) abort();
      });
    } finally {
      clearTimeout(timer!);
      signal.removeEventListener("abort", abort);
      this.waiting.delete(entry.id);
    }
  }
  resolve(interactionId: string, input: unknown) {
    const reply = z
      .object({
        action: z.enum(["accept", "decline", "cancel"]),
        content: z.record(z.string(), z.json()).optional(),
      })
      .strict()
      .parse(input);
    const entry = this.store.get<MCPInteraction>(
        "mcp-interactions",
        interactionId,
      ),
      pending = this.waiting.get(interactionId);
    invariant(
      entry.status === "pending" &&
        pending &&
        Date.parse(entry.expiresAt) > Date.now(),
      "MCP interaction is no longer pending",
      409,
    );
    if (
      entry.kind === "elicitation" &&
      (entry.request.mode || "form") === "form" &&
      reply.action === "accept"
    ) {
      const validate = compileSchema({
        ...entry.request.requestedSchema,
        additionalProperties: false,
      });
      invariant(
        validate(reply.content || {}),
        "Elicitation response does not match requested schema",
      );
    } else
      invariant(
        reply.content === undefined,
        "This interaction does not accept form content",
      );
    const result = {
      action: reply.action,
      ...(reply.action === "accept" && reply.content
        ? { content: reply.content }
        : {}),
    };
    this.store.put("mcp-interactions", {
      ...entry,
      status:
        reply.action === "accept"
          ? "completed"
          : reply.action === "decline"
            ? "declined"
            : "cancelled",
    });
    this.waiting.delete(interactionId);
    pending.resolve(result);
    if (entry.origin)
      this.store.emit(entry.origin.runId, "mcp.input_resolved", {
        id: entry.id,
        action: reply.action,
      });
    return {
      id: entry.id,
      status: this.store.get<MCPInteraction>("mcp-interactions", entry.id)
        .status,
    };
  }
  private reject(key: string, status: "cancelled" | "expired", error: Error) {
    const pending = this.waiting.get(key);
    if (!pending) return;
    this.waiting.delete(key);
    const entry = this.store.get<MCPInteraction>("mcp-interactions", key);
    this.store.put("mcp-interactions", { ...entry, status });
    pending.reject(error);
  }
  close() {
    for (const key of this.waiting.keys())
      this.reject(key, "cancelled", new Error("MCP interaction host closed"));
  }
}
