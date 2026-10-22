import { errorText, invariant } from "../../core/util.js";
import { wireMember } from "../../core/wire.js";
import { responseEvent, responseCall, responseJson } from "./wire.js";
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
    const body: Record<string, unknown> = {
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
  async event(value, response) {
    const type = wireMember(value, "type");
    if (
      typeof type !== "string" ||
      ![
        "response.created",
        "response.output_text.delta",
        "response.reasoning_summary_text.delta",
        "response.output_item.added",
        "response.function_call_arguments.delta",
        "response.output_item.done",
        ...terminal,
      ].includes(type)
    )
      return;
    const event = responseEvent.parse(value);
    const { output, calls } = response;
    if (event.type === "response.created")
      output.responseId = event.response?.id;
    if (event.type === "response.output_text.delta") {
      invariant(
        typeof event.delta === "string",
        "Invalid Responses text delta",
        502,
      );
      await response.text(event.delta);
    }
    if (event.type === "response.reasoning_summary_text.delta") {
      invariant(
        typeof event.delta === "string",
        "Invalid Responses reasoning delta",
        502,
      );
      await response.thought(event.delta);
    }
    if (
      event.type === "response.output_item.added" &&
      event.item?.type === "function_call"
    ) {
      response.started = true;
      const item = responseCall.parse({
        name: "",
        arguments: "",
        ...event.item,
      });
      calls.set(event.output_index ?? calls.size, {
        id: item.call_id,
        name: item.name,
        json: item.arguments,
      });
    }
    if (event.type === "response.function_call_arguments.delta") {
      const call =
        event.output_index === undefined
          ? undefined
          : calls.get(event.output_index);
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
      invariant(item, "Responses output item is missing", 502);
      if (item.type === "function_call") {
        const call = responseCall.parse(item);
        response.started = true;
        calls.set(event.output_index ?? calls.size, {
          id: call.call_id,
          name: call.name,
          json: call.arguments,
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
        output.errorMessage = errorText(
          wireMember(result.error, "message") || result.error,
        );
      // Some compatible endpoints send only the terminal response object.
      if (!output.content.some((p) => p.type === "text"))
        for (const item of result?.output || [])
          if (item.type === "message")
            for (const p of item.content || [])
              if (p.type === "output_text") {
                invariant(
                  typeof p.text === "string",
                  "Invalid Responses output text",
                  502,
                );
                await response.text(p.text);
              }
      for (const item of result?.output || [])
        if (
          item.type === "function_call" &&
          ![...calls.values()].some((c) => c.id === item.call_id)
        ) {
          const call = responseCall.parse(item);
          calls.set(calls.size, {
            id: call.call_id,
            name: call.name,
            json: call.arguments,
          });
        }
    }
  },
  jsonEvents(input) {
    const value = responseJson.parse(input);
    return [
      {
        type:
          value.status === "incomplete"
            ? "response.incomplete"
            : "response.completed",
        response: value,
      },
    ];
  },
};
