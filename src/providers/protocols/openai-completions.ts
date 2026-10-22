import { id, invariant } from "../../core/util.js";
import { completionsMessages, functionTools } from "../serialize.js";
import type { TextProtocol } from "../protocol.js";

export const openaiCompletions: TextProtocol = {
  id: "openai-completions",
  url: (base) => base + "/chat/completions",
  body({ request, route, budget }) {
    const body: Record<string, any> = {
      ...route.requestDefaults,
      model: route.model,
      messages: completionsMessages(request.messages, route),
      stream: true,
      [(route.compat.maxTokensField as string) || "max_tokens"]: budget,
    };
    if (request.tools.length) body.tools = functionTools(request.tools);
    if (route.compat.supportsUsageInStreaming !== false)
      body.stream_options = { include_usage: true };
    return body;
  },
  disableReasoning(body, route) {
    if (route.compat.supportsReasoningEffort !== false)
      body.reasoning_effort = "none";
  },
  enableReasoning(body, route, { effort }) {
    invariant(
      !effort || route.compat.supportsReasoningEffort !== false,
      "Model route does not support reasoning_effort",
      400,
    );
    if (route.compat.supportsReasoningEffort !== false)
      body.reasoning_effort = effort ?? body.reasoning_effort ?? "medium";
  },
  async event(event, response) {
    const choice = event.choices?.[0],
      d = choice?.delta || choice?.message;
    if (event.id) response.output.responseId = event.id;
    if (d) {
      await response.text(
        typeof d.content === "string"
          ? d.content
          : Array.isArray(d.content)
            ? d.content.map((p: any) => p.text || "").join("")
            : "",
      );
      await response.thought(d.reasoning_content || d.reasoning || "");
      for (const c of d.tool_calls || []) {
        response.started = true;
        const index = c.index ?? response.calls.size;
        const call = response.calls.get(index) || {
          id: c.id || id("call"),
          name: "",
          json: "",
        };
        if (c.id) call.id = c.id;
        if (c.function?.name) call.name += c.function.name;
        if (c.function?.arguments) {
          call.json += c.function.arguments;
          await response.toolArguments(call.id, c.function.arguments);
        }
        response.calls.set(index, call);
      }
    }
    response.usage(event.usage);
    if (choice?.finish_reason)
      response.finish(
        choice.finish_reason === "length"
          ? "length"
          : choice.finish_reason === "content_filter"
            ? "error"
            : "stop",
      );
  },
};
