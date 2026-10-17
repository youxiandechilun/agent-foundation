import { z } from "zod";
import type {
  Message,
  ToolDefinition,
  AssistantMessage,
} from "../runtime/types.js";
import { emptyUsage } from "../runtime/types.js";
import { compileSchema } from "../runtime/json-schema.js";
import { invariant, hash } from "../util.js";

const identity = z.string().min(1).max(200);
const text = z
  .object({ type: z.literal("text"), text: z.string().max(200000) })
  .passthrough();
const image = z
  .object({
    type: z.literal("image"),
    data: z.string().max(5 * 1024 * 1024),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  })
  .passthrough();
const ordinary = z.discriminatedUnion("type", [text, image]);
const use = z
  .object({
    type: z.literal("tool_use"),
    id: identity,
    name: z.string().min(1).max(256),
    input: z.record(z.string(), z.json()),
  })
  .passthrough();
const result = z
  .object({
    type: z.literal("tool_result"),
    toolUseId: identity,
    content: z.array(ordinary).max(100),
    structuredContent: z.record(z.string(), z.json()).optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();
const part = z.discriminatedUnion("type", [text, image, use, result]);
const requestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.union([part, z.array(part).min(1).max(100)]),
          })
          .passthrough(),
      )
      .min(1)
      .max(100),
    systemPrompt: z.string().max(32000).optional(),
    maxTokens: z.number().int().positive(),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(256),
            description: z.string().max(32000).optional(),
            inputSchema: z.record(z.string(), z.json()),
          })
          .passthrough(),
      )
      .max(64)
      .optional(),
    toolChoice: z
      .object({ mode: z.enum(["auto", "required", "none"]) })
      .strict()
      .optional(),
    includeContext: z.enum(["none", "thisServer", "allServers"]).optional(),
  })
  .passthrough();
export interface SamplingLimits {
  tools?: boolean;
  maxTools?: number;
}
export function decodeSamplingRequest(
  input: unknown,
  limits: SamplingLimits = {},
) {
  const data = requestSchema.parse(input),
    messages: Message[] = [],
    tools: ToolDefinition[] = [];
  invariant(
    !data.includeContext || data.includeContext === "none",
    "Implicit sampling conversation context is disabled",
    403,
  );
  invariant(
    (data.tools?.length || 0) <= (limits.maxTools || 32),
    "Sampling tool limit exceeded",
    413,
  );
  const names = new Set<string>(),
    aliases = new Map<string, string>(),
    seen = new Set<string>(),
    pending = new Map<string, string>();
  for (const tool of data.tools || []) {
    invariant(limits.tools, "Sampling tool use is not enabled", 403);
    invariant(!names.has(tool.name), "Duplicate sampling tool name");
    names.add(tool.name);
    invariant(
      tool.inputSchema.type === "object",
      "Sampling tools require an object input schema",
    );
    const parameters = {
      ...tool.inputSchema,
      $schema:
        tool.inputSchema.$schema ||
        "https://json-schema.org/draft/2020-12/schema",
    };
    compileSchema(parameters);
    const alias = /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)
      ? tool.name
      : "mcp_sample_" + hash(tool.name).slice(0, 40);
    invariant(!aliases.has(alias), "Sampling provider tool name collision");
    aliases.set(alias, tool.name);
    // These are model declarations only; executing a server-supplied tool on the host is prohibited.
    tools.push({
      name: tool.name,
      description: tool.description || tool.name,
      parameters,
      risk: "execute",
      capabilities: ["mcp"],
      execute: async () => {
        throw new Error("Sampling tools are executed by the MCP server");
      },
    });
  }
  if (data.toolChoice)
    invariant(limits.tools, "Sampling tool choice is not enabled", 403);
  invariant(
    data.toolChoice?.mode !== "required" || tools.length > 0,
    "Required sampling tool choice needs tools",
  );
  if (data.systemPrompt)
    messages.push({
      role: "system",
      content: data.systemPrompt,
      timestamp: Date.now(),
    });
  const aliasFor = (name: string) =>
    [...aliases].find(([, original]) => original === name)?.[0] ||
    (/^[a-zA-Z0-9_-]{1,64}$/.test(name)
      ? name
      : "mcp_sample_" + hash(name).slice(0, 40));
  for (const item of data.messages) {
    const blocks = Array.isArray(item.content) ? item.content : [item.content],
      results = blocks.filter((p) => p.type === "tool_result");
    if (results.length) {
      invariant(
        limits.tools &&
          item.role === "user" &&
          results.length === blocks.length,
        "Tool-result messages must contain only user tool results",
      );
      for (const entry of results) {
        const name = pending.get(entry.toolUseId);
        invariant(name, "Orphan or duplicate sampling tool result");
        pending.delete(entry.toolUseId);
        const content: (
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        )[] = entry.content.map((p) =>
          p.type === "image"
            ? { type: "image", data: p.data, mimeType: p.mimeType }
            : { type: "text", text: p.text },
        );
        if (entry.structuredContent)
          content.push({
            type: "text",
            text: JSON.stringify(entry.structuredContent),
          });
        messages.push({
          role: "toolResult",
          toolCallId: entry.toolUseId,
          toolName: aliasFor(name),
          content,
          isError: entry.isError || false,
          timestamp: Date.now(),
        });
      }
      invariant(
        pending.size === 0,
        "Sampling must resolve the complete preceding tool group",
      );
      continue;
    }
    invariant(
      pending.size === 0,
      "Sampling tool calls must be immediately followed by their results",
    );
    const content = blocks.map((p) => {
      if (p.type === "tool_use") {
        invariant(
          limits.tools && item.role === "assistant",
          "Only assistant sampling messages may contain tool use",
        );
        invariant(!seen.has(p.id), "Duplicate sampling tool-use ID");
        seen.add(p.id);
        pending.set(p.id, p.name);
        return {
          type: "toolCall" as const,
          id: p.id,
          name: aliasFor(p.name),
          arguments: p.input,
        };
      }
      invariant(
        p.type === "text" || p.type === "image",
        "Invalid sampling content",
      );
      return p.type === "text"
        ? { type: "text" as const, text: p.text }
        : { type: "image" as const, data: p.data, mimeType: p.mimeType };
    });
    if (item.role === "assistant")
      messages.push({
        role: "assistant",
        content,
        model: "mcp-context",
        provider: "mcp",
        usage: emptyUsage(),
        stopReason: pending.size ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
    else {
      invariant(
        content.every((p) => p.type !== "toolCall"),
        "User sampling messages cannot contain tool use",
      );
      messages.push({
        role: "user",
        content: content as any,
        timestamp: Date.now(),
      });
    }
  }
  invariant(pending.size === 0, "Incomplete sampling tool group");
  return { data, messages, tools, aliases, aliasFor };
}
export function samplingResult(
  reply: AssistantMessage,
  request: ReturnType<typeof decodeSamplingRequest>,
  allowedTools: ToolDefinition[],
) {
  invariant(
    ["stop", "length", "toolUse"].includes(reply.stopReason),
    "MCP sampling provider did not complete",
    502,
  );
  const content: any[] = [],
    ids = new Set<string>(),
    byName = new Map(allowedTools.map((t) => [t.name, t]));
  for (const part of reply.content) {
    if (part.type === "thinking") continue;
    if (part.type === "toolCall") {
      invariant(
        request.data.toolChoice?.mode !== "none",
        "Model returned a tool call despite toolChoice:none",
        502,
      );
      const original = request.aliases.get(part.name),
        definition = original ? byName.get(original) : undefined;
      invariant(
        original && definition,
        "Model selected an unavailable sampling tool",
        403,
      );
      invariant(
        !ids.has(part.id),
        "Model returned duplicate sampling tool-use IDs",
        502,
      );
      ids.add(part.id);
      invariant(
        compileSchema(definition.parameters)(part.arguments),
        "Model sampling tool arguments violate the declared schema",
        502,
      );
      content.push({
        type: "tool_use",
        id: part.id,
        name: original,
        input: part.arguments,
      });
    } else
      content.push(
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image", data: part.data, mimeType: part.mimeType },
      );
  }
  invariant(ids.size <= 64, "Too many sampling tool calls", 502);
  invariant(
    request.data.toolChoice?.mode !== "required" || ids.size > 0,
    "Model did not satisfy required sampling tool choice",
    502,
  );
  return {
    role: "assistant",
    content:
      content.length === 1
        ? content[0]
        : content.length
          ? content
          : { type: "text", text: "" },
    model: reply.model,
    stopReason: ids.size
      ? "toolUse"
      : reply.stopReason === "length"
        ? "maxTokens"
        : "endTurn",
  };
}
