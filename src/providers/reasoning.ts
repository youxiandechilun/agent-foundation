import type { Route } from "../core/config.js";
import type { ModelRequest } from "../runtime/types.js";
import { invariant } from "../core/util.js";

export function wantsReasoning(route: Route, request: ModelRequest): boolean {
  const effort = request.reasoningEffort ?? route.reasoningEffort;
  return (
    effort !== "none" &&
    Boolean(
      effort ||
      request.reasoningBudgetTokens ||
      route.reasoningBudgetTokens ||
      route.reasoning,
    )
  );
}

/** Translate explicit host settings without claiming every model supports every effort. */
export function applyReasoning(
  body: Record<string, unknown>,
  route: Route,
  request: ModelRequest,
  outputBudget: number,
): void {
  const effort = request.reasoningEffort ?? route.reasoningEffort;
  const budget = request.reasoningBudgetTokens ?? route.reasoningBudgetTokens;
  if (effort && route.supportedReasoningEfforts)
    invariant(
      route.supportedReasoningEfforts.includes(effort),
      `Model route does not support reasoning effort ${effort}`,
      400,
    );
  if (effort === "none") {
    delete body.reasoning;
    delete body.reasoning_effort;
    delete body.thinking;
    if (
      route.adapter === "openai-completions" &&
      route.compat.supportsReasoningEffort !== false
    )
      body.reasoning_effort = "none";
    if (route.adapter === "openai-responses")
      body.reasoning = { effort: "none" };
    if (route.adapter === "anthropic-messages")
      body.thinking = { type: "disabled" };
    return;
  }
  if (!wantsReasoning(route, request)) return;
  if (route.adapter === "openai-responses") {
    const previous =
      typeof body.reasoning === "object" &&
      body.reasoning !== null &&
      !Array.isArray(body.reasoning)
        ? body.reasoning
        : {};
    const configured = {
      summary: "auto",
      effort: "medium",
      ...previous,
      ...(effort ? { effort } : {}),
    };
    body.reasoning = configured;
  } else if (route.adapter === "openai-completions") {
    invariant(
      !effort || route.compat.supportsReasoningEffort !== false,
      "Model route does not support reasoning_effort",
      400,
    );
    if (route.compat.supportsReasoningEffort !== false)
      body.reasoning_effort = effort ?? body.reasoning_effort ?? "medium";
  } else if (route.adapter === "anthropic-messages") {
    if (route.compat.adaptiveThinking === true) {
      invariant(
        !effort || ["low", "medium", "high", "max"].includes(effort),
        "Adaptive thinking accepts low, medium, high or max on this adapter",
        400,
      );
      invariant(
        !budget,
        "Adaptive thinking uses effort instead of a token budget",
        400,
      );
      body.thinking = { type: "adaptive" };
      if (effort) {
        const previous =
          typeof body.output_config === "object" && body.output_config !== null
            ? body.output_config
            : {};
        body.output_config = { ...previous, effort };
      }
    } else {
      invariant(
        !effort,
        "This Anthropic route requires reasoningBudgetTokens; enable compat.adaptiveThinking only for a supporting model",
        400,
      );
      invariant(
        outputBudget >= 1280,
        "Anthropic reasoning requires at least 1280 output tokens",
        400,
      );
      invariant(
        !budget || budget < outputBudget,
        "Thinking token budget must be smaller than maxOutputTokens",
        400,
      );
      if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
      else
        body.thinking ??= {
          type: "enabled",
          budget_tokens: Math.min(2048, outputBudget - 256),
        };
    }
  }
}
