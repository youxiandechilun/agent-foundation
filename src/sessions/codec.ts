import { z } from "zod";
import type { StoredMessage } from "../contracts.js";
import type { NativeWebSearchResult } from "../runtime/types.js";
import { invariant, redactJson } from "../core/util.js";
import { jsonBytes } from "./json-stream.js";
import { modeIdSchema } from "../modes/registry.js";

const identity = z.string().min(1).max(200);
const text = z.object({ type: z.literal("text"), text: z.string() }).strict();
const image = z
  .object({
    type: z.literal("image"),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    data: z
      .string()
      .refine(
        (value) =>
          value.length % 4 === 0 &&
          Buffer.from(value, "base64").toString("base64") === value,
        "Image must use canonical base64",
      ),
  })
  .strict();
const call = z
  .object({
    type: z.literal("toolCall"),
    id: identity,
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    arguments: z.record(z.string(), z.json()),
  })
  .strict();
const thinking = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string().optional(),
  })
  .strict();
const timestamp = z.number().nonnegative().finite();
const count = z.number().nonnegative().finite();
const usage = z
  .object({
    reported: z.boolean().optional(),
    input: count,
    output: count,
    cacheRead: count,
    cacheWrite: count,
    totalTokens: count,
  })
  .strict();
// The snapshot byte limit applies first; these bounds also constrain individual metadata fields.
const webUrl = z
  .string()
  .max(8000)
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const searchText = z.string().max(40000);
const searchItems = <T extends z.ZodType>(item: T) => z.array(item).max(10000);
const webSearch: z.ZodType<NativeWebSearchResult> = z
  .object({
    calls: searchItems(
      z
        .object({
          id: identity,
          status: identity.optional(),
          action: z
            .object({
              type: identity,
              query: searchText.optional(),
              queries: searchItems(searchText).optional(),
              url: webUrl.optional(),
              sources: searchItems(
                z
                  .object({ url: webUrl, title: searchText.optional() })
                  .strict(),
              ).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    citations: searchItems(
      z
        .object({
          url: webUrl,
          title: searchText,
          startIndex: z.number().int().nonnegative(),
          endIndex: z.number().int().nonnegative(),
        })
        .strict()
        .refine((value) => value.endIndex >= value.startIndex),
    ),
  })
  .strict();
const message = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("user"),
      content: z.union([z.string(), z.array(z.union([text, image]))]),
      timestamp,
      inputId: identity.optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.array(z.union([text, image, thinking, call])),
      model: z.string(),
      provider: z.string(),
      timestamp,
      usage,
      stopReason: z.enum(["stop", "toolUse", "length", "error", "aborted"]),
      responseId: z.string().optional(),
      errorMessage: z.string().optional(),
      webSearch: webSearch.optional(),
      providerState: z
        .object({
          protocol: z.string(),
          routeId: z.string(),
          items: z.array(z.json()),
        })
        .optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("toolResult"),
      toolCallId: identity,
      toolName: z.string(),
      content: z.array(z.union([text, image])),
      details: z.json().optional(),
      isError: z.boolean(),
      timestamp,
    })
    .strict(),
]);
const snapshot = z
  .object({
    format: z.literal("foundation-session-v1"),
    session: z
      .object({
        projectId: identity,
        name: z.string().max(200),
        mode: modeIdSchema,
        routeId: identity,
        agentId: identity.optional(),
      })
      .passthrough(),
    messages: z.array(
      z.object({ id: identity, runId: identity, message }).strict(),
    ),
  })
  .strict();

/** Owner-authored transcript import. It imports evidence, never runs historical tool calls. */
export function decodeSessionSnapshot(
  input: unknown,
  maxMessages: number,
  maxBytes = 8 * 1024 * 1024,
) {
  invariant(
    jsonBytes(input, maxBytes) <= maxBytes,
    "Session snapshot exceeds byte limit",
    413,
  );
  const decoded = snapshot.parse(input);
  // Redact independently validated records so a long transcript does not need
  // an additional complete serialized string and parsed object tree.
  decoded.session = snapshot.shape.session.parse(redactJson(decoded.session));
  decoded.messages = decoded.messages.map((item) =>
    snapshot.shape.messages.element.parse(redactJson(item)),
  );
  invariant(
    decoded.messages.length <= maxMessages,
    "Session snapshot exceeds message limit",
    413,
  );
  const ids = new Set<string>(),
    calls = new Set<string>(),
    pending = new Map<string, string>();
  for (const item of decoded.messages) {
    invariant(!ids.has(item.id), "Duplicate imported message ID");
    ids.add(item.id);
    const value = item.message;
    if (value.role === "toolResult") {
      invariant(
        pending.get(value.toolCallId) === value.toolName,
        "Orphan, duplicate or mismatched imported tool result",
      );
      pending.delete(value.toolCallId);
    } else {
      invariant(
        pending.size === 0,
        "Imported tool calls must be followed by their results",
      );
      if (value.role === "assistant") {
        // Provider continuation IDs and signatures are not portable across hosts or routes.
        delete value.providerState;
        delete value.responseId;
        value.content = value.content.filter((p) => p.type !== "thinking");
        for (const part of value.content)
          if (part.type === "toolCall") {
            invariant(!calls.has(part.id), "Duplicate imported tool call ID");
            calls.add(part.id);
            pending.set(part.id, part.name);
          }
      }
    }
  }
  invariant(
    pending.size === 0,
    "Incomplete tool groups cannot be imported; export a settled transcript",
  );
  return {
    session: decoded.session,
    messages: decoded.messages as StoredMessage[],
  };
}
