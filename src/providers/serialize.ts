import type { Route } from "../core/config.js";
import {
  textOf,
  type ContentPart,
  type ImagePart,
  type Message,
  type TextPart,
  type ToolDefinition,
} from "../runtime/types.js";

const parts = <T extends ContentPart>(
  content: string | T[],
): (TextPart | T)[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;
const imageUrl = (p: ImagePart) => `data:${p.mimeType};base64,${p.data}`;
function openaiPart(
  p: TextPart | ImagePart,
  protocol: "completions" | "responses",
) {
  const responses = protocol === "responses";
  if (p.type === "image")
    return responses
      ? { type: "input_image", image_url: imageUrl(p) }
      : { type: "image_url", image_url: { url: imageUrl(p) } };
  return { type: responses ? "input_text" : "text", text: p.text };
}
function anthropicPart(p: ContentPart) {
  switch (p.type) {
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: p.mimeType, data: p.data },
      };
    case "toolCall":
      return {
        type: "tool_use",
        id: p.id,
        name: p.name,
        input: p.arguments,
      };
    case "thinking":
      return {
        type: "thinking",
        thinking: p.thinking,
        signature: p.signature,
      };
    case "text":
      return { type: "text", text: p.text };
  }
}
function completionMessage(message: Message, route: Route) {
  if (message.role === "system")
    return { role: "system", content: message.content };
  if (message.role === "user")
    return {
      role: "user",
      content: parts(message.content).map((p) => openaiPart(p, "completions")),
    };
  if (message.role === "toolResult")
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: textOf(message),
    };
  const calls = message.content.filter((p) => p.type === "toolCall");
  return {
    role: "assistant",
    content: textOf(message) || null,
    ...(calls.length
      ? {
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        }
      : {}),
    ...(route.compat.requiresReasoningContentOnAssistantMessages
      ? {
          reasoning_content: message.content
            .filter((p) => p.type === "thinking")
            .map((p) => p.thinking)
            .join(""),
        }
      : {}),
  };
}
export function completionsMessages(messages: Message[], route: Route) {
  const result: ReturnType<typeof completionMessage>[] = [];
  let visual: ReturnType<typeof openaiPart>[] = [];
  const flush = () => {
    if (visual.length) {
      result.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "Visual output from the preceding tool results:",
          },
          ...visual,
        ],
      });
      visual = [];
    }
  };
  for (const m of messages) {
    if (m.role !== "toolResult") flush();
    result.push(completionMessage(m, route));
    if (m.role === "toolResult")
      visual.push(
        ...m.content
          .filter((p) => p.type === "image")
          .map((p) => openaiPart(p, "completions")),
      );
  }
  flush();
  return result;
}
export function responsesInput(messages: Message[], routeId: string) {
  const result: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system")
      result.push({ role: "system", content: m.content });
    else if (m.role === "user")
      result.push({
        role: "user",
        content: parts(m.content).map((p) => openaiPart(p, "responses")),
      });
    else if (m.role === "toolResult")
      result.push({
        type: "function_call_output",
        call_id: m.toolCallId,
        output: m.content.some((p) => p.type === "image")
          ? m.content.map((p) => openaiPart(p, "responses"))
          : textOf(m),
      });
    else {
      if (
        m.providerState?.protocol === "openai-responses" &&
        m.providerState.routeId === routeId
      )
        result.push(...m.providerState.items);
      const text = textOf(m);
      if (text) result.push({ role: "assistant", content: text });
      for (const c of m.content)
        if (c.type === "toolCall")
          result.push({
            type: "function_call",
            call_id: c.id,
            name: c.name,
            arguments: JSON.stringify(c.arguments),
          });
    }
  }
  return result;
}
export function anthropicMessages(messages: Message[], routeId: string) {
  const output: { role: "assistant" | "user"; content: unknown[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    let content: unknown[];
    if (m.role === "toolResult")
      content = [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          is_error: m.isError,
          content: m.content.map(anthropicPart),
        },
      ];
    else
      content =
        m.role === "assistant" &&
        m.providerState?.protocol === "anthropic-messages" &&
        m.providerState.routeId === routeId &&
        m.providerState.items.length
          ? m.providerState.items.slice()
          : parts(m.content)
              .filter(
                (p) =>
                  p.type !== "thinking" ||
                  (m.role === "assistant" &&
                    m.providerState?.routeId === routeId &&
                    p.signature),
              )
              .map(anthropicPart);
    if (!content.length) continue;
    const previous = output.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else output.push({ role, content });
  }
  return output;
}
export const functionTools = (tools: ToolDefinition[]) =>
  tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
