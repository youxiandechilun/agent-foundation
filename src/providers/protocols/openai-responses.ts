import { errorText, invariant } from "../../core/util.js";
import { functionTools, responsesInput } from "../serialize.js";
import type { TextProtocol } from "../protocol.js";

const terminal = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

export const openaiResponses: TextProtocol = {
  id: "openai-responses",
  url: (base) => base + "/responses",
  body({ request, route, routeId, budget }) {
    const body: Record<string, any> = {
      ...route.requestDefaults,
      model: route.model,
      input: responsesInput(request.messages, routeId),
      stream: true,
      store: false,
      max_output_tokens: budget,
      include: ["reasoning.encrypted_content"],
    };
    if (request.tools.length)
      body.tools = functionTools(request.tools).map((t) => ({
        type: t.type,
        ...t.function,
      }));
    return body;
  },
  disableReasoning(body) {
    body.reasoning = { effort: "none" };
  },
  enableReasoning(body, _route, { effort }) {
    const previous =
      typeof body.reasoning === "object" &&
      body.reasoning !== null &&
      !Array.isArray(body.reasoning)
        ? body.reasoning
        : {};
    body.reasoning = {
      summary: "auto",
      effort: "medium",
      ...previous,
      ...(effort ? { effort } : {}),
    };
  },
  async event(event, response) {
    const { output, calls } = response;
    if (event.type === "response.created")
      output.responseId = event.response?.id;
    if (event.type === "response.output_text.delta")
      await response.text(event.delta);
    if (event.type === "response.reasoning_summary_text.delta")
      await response.thought(event.delta);
    if (
      event.type === "response.output_item.added" &&
      event.item?.type === "function_call"
    ) {
      response.started = true;
      calls.set(event.output_index ?? calls.size, {
        id: event.item.call_id,
        name: event.item.name || "",
        json: event.item.arguments || "",
      });
    }
    if (event.type === "response.function_call_arguments.delta") {
      const call = calls.get(event.output_index);
      invariant(
        call && typeof event.delta === "string",
        "Responses argument delta has no declared call",
        502,
      );
      response.started = true;
      call.json += event.delta;
      await response.toolArguments(call.id, event.delta);
    }
    if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item.type === "function_call") {
        response.started = true;
        calls.set(event.output_index ?? calls.size, {
          id: item.call_id,
          name: item.name,
          json: item.arguments,
        });
      }
      if (["reasoning", "compaction"].includes(item.type))
        response.providerState().items.push(item);
    }
    if (terminal.has(event.type)) {
      const result = event.response;
      output.responseId = result?.id || output.responseId;
      response.usage(result?.usage);
      response.finish(
        event.type === "response.completed"
          ? "stop"
          : event.type === "response.incomplete"
            ? "length"
            : "error",
      );
      if (result?.error)
        output.errorMessage = errorText(result.error.message || result.error);
      // Some compatible endpoints send only the terminal response object.
      if (!output.content.some((p) => p.type === "text"))
        for (const item of result?.output || [])
          if (item.type === "message")
            for (const p of item.content || [])
              if (p.type === "output_text") await response.text(p.text);
      for (const item of result?.output || [])
        if (
          item.type === "function_call" &&
          ![...calls.values()].some((c) => c.id === item.call_id)
        )
          calls.set(calls.size, {
            id: item.call_id,
            name: item.name,
            json: item.arguments,
          });
    }
  },
  jsonEvents: (value) => [
    {
      type:
        value.status === "incomplete"
          ? "response.incomplete"
          : "response.completed",
      response: value,
    },
  ],
};
