import { invariant } from "../core/util.js";
import type { AssistantMessage } from "../runtime/types.js";

const referenceType = "agent-foundation/content-reference";
type Field = "text" | "thinking" | "input";
interface ContentReference {
  type: typeof referenceType;
  version: 1;
  contentIndex: number;
  field: Field;
  block: Record<string, unknown>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Restore new compact references; pre-existing native items remain unchanged. */
export function anthropicReplayItems(message: AssistantMessage): unknown[] {
  return (message.providerState?.items ?? []).map((item) => {
    if (!record(item) || item.type !== referenceType) return item;
    invariant(
      item.version === 1 &&
        Number.isSafeInteger(item.contentIndex) &&
        record(item.block),
      "Invalid provider replay reference",
      502,
    );
    const part = message.content[Number(item.contentIndex)];
    let value: unknown;
    if (
      item.field === "text" &&
      part?.type === "text" &&
      item.block.type === "text"
    ) {
      value = part.text;
    } else if (
      item.field === "thinking" &&
      part?.type === "thinking" &&
      item.block.type === "thinking"
    )
      value = part.thinking;
    else if (
      item.field === "input" &&
      part?.type === "toolCall" &&
      item.block.type === "tool_use" &&
      item.block.id === part.id
    )
      value = part.arguments;
    else invariant(false, "Invalid provider replay content reference", 502);
    return { ...item.block, [String(item.field)]: value };
  });
}

/** Store large native payloads once; retain signatures, unknown fields and native order. */
export function compactAnthropicItems(
  message: AssistantMessage,
  items: unknown[],
): unknown[] {
  return items.map((item) => {
    if (!record(item)) return item;
    let index = -1,
      field: Field | undefined;
    if (item.type === "text" && typeof item.text === "string") {
      // Only reference whole semantic blocks. A secret redactor may change text
      // length before persistence, so offsets into coalesced blocks are unsafe.
      index = message.content.findIndex(
        (part) => part.type === "text" && part.text === item.text,
      );
      field = "text";
    } else if (item.type === "thinking" && typeof item.thinking === "string") {
      index = message.content.findIndex(
        (part) =>
          part.type === "thinking" &&
          part.thinking === item.thinking &&
          part.signature === item.signature,
      );
      field = "thinking";
    } else if (item.type === "tool_use") {
      index = message.content.findIndex(
        (part) =>
          part.type === "toolCall" &&
          part.id === item.id &&
          JSON.stringify(part.arguments) === JSON.stringify(item.input),
      );
      field = "input";
    }
    if (index < 0 || !field) return item;
    const block = { ...item };
    delete block[field];
    const reference: ContentReference = {
      type: referenceType,
      version: 1,
      contentIndex: index,
      field,
      block,
    };
    // Small blocks are cheaper in the original representation.
    return JSON.stringify(reference).length + 32 < JSON.stringify(item).length
      ? reference
      : item;
  });
}
