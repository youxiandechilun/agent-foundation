import { z } from "zod";
import { Store } from "../../storage/store.js";
import { id, now, invariant, redactJson } from "../../core/util.js";
import { compileSchema } from "../../runtime/json-schema.js";
import { wireObject, type WireObject } from "./protocol.js";
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
  request: WireObject;
  origin?: MCPOrigin;
  status: "pending" | "completed" | "declined" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
}
export function validateElicitation(value: unknown) {
  const params = wireObject(value);
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
    const url = new URL(String(params.url));
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
  const schema = wireObject(params.requestedSchema),
    properties = wireObject(schema?.properties);
  invariant(
    schema?.type === "object" &&
      properties &&
      Object.keys(properties).length <= 100,
    "Invalid elicitation form schema",
  );
  for (const value of Object.values(properties)) {
    const entry = wireObject(value) ?? {},
      items = wireObject(entry.items);
    const scalar = (
      ["string", "number", "integer", "boolean"] as unknown[]
    ).includes(entry.type);
    const enumArray =
      entry.type === "array" &&
      items?.type === "string" &&
      (Array.isArray(items.enum) || Array.isArray(items.oneOf));
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
/** The host's answer to an elicitation or sampling consent request. */
export interface MCPInteractionReply {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, z.core.util.JSONType>;
}
export class MCPInteractions {
  private waiting = new Map<
    string,
    {
      resolve: (value: MCPInteractionReply) => void;
      reject: (error: Error) => void;
    }
  >();
  constructor(readonly store: Store) {
    for (const r of store.list<MCPInteraction>("mcp-interactions", {
      status: "pending",
    }))
      store.put("mcp-interactions", { ...r, status: "expired" });
  }
  list(serverId?: string) {
    return this.store.list<MCPInteraction>("mcp-interactions", {
      serverId: serverId || undefined,
    });
  }
  async ask(
    serverId: string,
    kind: MCPInteraction["kind"],
    request: unknown,
    signal: AbortSignal,
    origin?: MCPOrigin,
  ): Promise<MCPInteractionReply> {
    signal.throwIfAborted();
    invariant(this.waiting.size < 64, "Too many pending MCP interactions", 429);
    const entry: MCPInteraction = {
      id: id("mcp-input"),
      serverId,
      kind,
      request: wireObject(redactJson(structuredClone(request))) ?? {},
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
      return await new Promise<MCPInteractionReply>((resolve, reject) => {
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
        ...wireObject(entry.request.requestedSchema),
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
