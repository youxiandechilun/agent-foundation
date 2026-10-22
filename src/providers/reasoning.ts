import type { Route } from "../core/config.js";
import type { ModelRequest } from "../runtime/types.js";
import { invariant } from "../core/util.js";
import { wantsReasoning } from "./protocol.js";
import { findTextProtocol } from "./registry.js";

export { wantsReasoning } from "./protocol.js";

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
  const protocol = findTextProtocol(route.adapter);
  if (effort === "none") {
    delete body.reasoning;
    delete body.reasoning_effort;
    delete body.thinking;
    protocol?.disableReasoning?.(body, route);
    return;
  }
  if (!wantsReasoning(route, request)) return;
  protocol?.enableReasoning?.(body, route, { effort, budget, outputBudget });
}
