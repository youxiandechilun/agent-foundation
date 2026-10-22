import { errorText, invariant } from "../../core/util.js";
import { wireMember } from "../../core/wire.js";
import { responseEvent, responseCall, responseJson } from "./wire.js";
import { functionTools, responsesInput } from "../serialize.js";
import type { TextProtocol } from "../protocol.js";
import {
  nativeWebSearchEnabled,
  responsesOutputText,
} from "../responses-search.js";

const terminal = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

export const openaiResponses: TextProtocol = {
  id: "openai-responses",
  url: (base) => base + "/responses",
  body({ request, route, routeId, budget }) {
    const search = nativeWebSearchEnabled(route, request);
    const body: Record<string, unknown> = {
      ...route.requestDefaults,
      model: route.model,
      input: responsesInput(request.messages, routeId),
      stream: true,
      store: false,
      max_output_tokens: budget,
      include: [
        "reasoning.encrypted_content",
        ...(search ? ["web_search_call.action.sources"] : []),
      ],
    };
    const tools: Record<string, unknown>[] = functionTools(request.tools).map(
      (t) => ({
        type: t.type,
        ...t.function,
      }),
    );
    if (search) tools.push({ type: "web_search" });
    if (tools.length) body.tools = tools;
    else delete body.tools;
    if (search) body.tool_choice ??= "auto";
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
    if (response.webSearch.observe(value)) {
      response.started = true;
      invariant(
        response.nativeWebSearch,
        "Provider returned native web search without request authorization",
        502,
      );
    }
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
      if (
        response.nativeWebSearch ||
        ["reasoning", "compaction", "web_search_call"].includes(item.type)
      )
        response.responseItems.set(
          event.output_index ?? response.responseItems.size,
          item,
        );
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
      const terminalText = responsesOutputText(result?.output);
      if (terminalText !== undefined) {
        const received = output.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
        invariant(
          terminalText.startsWith(received),
          "Responses terminal text differs from streamed text",
          502,
        );
        await response.text(terminalText.slice(received.length));
      }
      const indices = new Map(
        [...calls].map(([index, call]) => [call.id, index]),
      );
      for (const [index, item] of (result?.output || []).entries()) {
        if (
          response.nativeWebSearch ||
          ["reasoning", "compaction", "web_search_call"].includes(item.type)
        )
          response.responseItems.set(index, item);
        if (item.type === "function_call") {
          const callIndex =
            typeof item.call_id === "string"
              ? (indices.get(item.call_id) ?? index)
              : index;
          const previous = calls.get(callIndex);
          const call = responseCall.parse({
            name: previous?.name ?? "",
            arguments: previous?.json ?? "",
            ...item,
          });
          invariant(
            !previous || previous.id === call.call_id,
            "Conflicting Responses tool call index",
            502,
          );
          calls.set(callIndex, {
            id: call.call_id,
            name: call.name,
            json: call.arguments,
          });
          indices.set(call.call_id, callIndex);
        }
      }
    }
  },
  jsonEvents(input) {
    const value = responseJson.parse(input);
    return [
      {
        type: `response.${value.status || "completed"}`,
        response: value,
      },
    ];
  },
  finalize(response) {
    response.retainResponsesState();
  },
};
