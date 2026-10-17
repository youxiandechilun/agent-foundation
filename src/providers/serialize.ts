import type { Route } from "../config.js";
import { textOf, type Message, type ToolDefinition } from "../runtime/types.js";

const parts = (message: Message): any[] =>
  typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
const imageUrl = (p: any) => `data:${p.mimeType};base64,${p.data}`;
export function completionsMessages(messages: Message[], route: Route) {
  const result: any[] = [];
  let visual: any[] = [];
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
    if (m.role === "system")
      result.push({ role: "system", content: m.content });
    else if (m.role === "user")
      result.push({
        role: "user",
        content: parts(m).map((p) =>
          p.type === "image"
            ? { type: "image_url", image_url: { url: imageUrl(p) } }
            : { type: "text", text: p.text },
        ),
      });
    else if (m.role === "toolResult") {
      result.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: textOf(m),
      });
      visual.push(
        ...m.content
          .filter((p) => p.type === "image")
          .map((p) => ({ type: "image_url", image_url: { url: imageUrl(p) } })),
      );
    } else {
      const calls = m.content.filter((p) => p.type === "toolCall");
      const value: any = { role: "assistant", content: textOf(m) || null };
      if (calls.length)
        value.tool_calls = calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        }));
      if (route.compat.requiresReasoningContentOnAssistantMessages)
        value.reasoning_content = m.content
          .filter((p) => p.type === "thinking")
          .map((p) => p.thinking)
          .join("");
      result.push(value);
    }
  }
  flush();
  return result;
}
export function responsesInput(messages: Message[], routeId: string) {
  const result: any[] = [];
  for (const m of messages) {
    if (m.role === "system")
      result.push({ role: "system", content: m.content });
    else if (m.role === "user")
      result.push({
        role: "user",
        content: parts(m).map((p) =>
          p.type === "image"
            ? { type: "input_image", image_url: imageUrl(p) }
            : { type: "input_text", text: p.text },
        ),
      });
    else if (m.role === "toolResult")
      result.push({
        type: "function_call_output",
        call_id: m.toolCallId,
        output: m.content.some((p) => p.type === "image")
          ? m.content.map((p) =>
              p.type === "image"
                ? { type: "input_image", image_url: imageUrl(p) }
                : { type: "input_text", text: p.text },
            )
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
  const output: any[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    let content: any[];
    if (m.role === "toolResult")
      content = [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          is_error: m.isError,
          content: parts(m).map((p) =>
            p.type === "image"
              ? {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: p.mimeType,
                    data: p.data,
                  },
                }
              : { type: "text", text: p.text },
          ),
        },
      ];
    else
      content =
        m.role === "assistant" &&
        m.providerState?.protocol === "anthropic-messages" &&
        m.providerState.routeId === routeId &&
        m.providerState.items.length
          ? m.providerState.items
          : parts(m).flatMap<any>((p) => {
              if (p.type === "toolCall")
                return [
                  {
                    type: "tool_use",
                    id: p.id,
                    name: p.name,
                    input: p.arguments,
                  },
                ];
              if (p.type === "image")
                return [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: p.mimeType,
                      data: p.data,
                    },
                  },
                ];
              if (p.type === "thinking")
                return m.role === "assistant" &&
                  m.providerState?.routeId === routeId &&
                  p.signature
                  ? [
                      {
                        type: "thinking",
                        thinking: p.thinking,
                        signature: p.signature,
                      },
                    ]
                  : [];
              return [{ type: "text", text: p.text }];
            });
    if (!content.length) continue;
    if (output.at(-1)?.role === role) output.at(-1).content.push(...content);
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
