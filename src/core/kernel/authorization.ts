import type { Message, ToolDefinition } from "../../runtime/types.js";
import type { ToolContext } from "../../runtime/registry.js";
import type { Session } from "../../contracts.js";
import type { Permissions } from "../permissions.js";
import { abortable, deepFreeze, invariant } from "../util.js";

type ToolRisk = NonNullable<ToolDefinition["risk"]>;
const riskRanks: Record<ToolRisk, number> = {
  read: 0,
  network: 1,
  write: 2,
  execute: 3,
  control: 4,
};

export function isToolRisk(risk: unknown): risk is ToolRisk {
  return typeof risk === "string" && Object.hasOwn(riskRanks, risk);
}

/** Authorization hooks can add capabilities and increase risk, never reduce them. */
export function mergeToolConstraints(
  current: ToolDefinition,
  next: ToolDefinition,
  risk = current.risk,
): Pick<ToolDefinition, "risk" | "capabilities"> {
  return {
    risk:
      next.risk && riskRanks[next.risk] > riskRanks[risk || "execute"]
        ? next.risk
        : risk,
    capabilities: [
      ...new Set([
        ...(current.capabilities || []),
        ...(next.capabilities || []),
      ]),
    ],
  };
}

function modelPolicyTool(
  { routeId }: ToolContext,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): ToolDefinition {
  const capabilities = new Set(tool.capabilities);
  for (const capability of tool.constrain?.(args, { routeId }) || [])
    capabilities.add(capability);
  return { ...tool, capabilities: [...capabilities] };
}

/** Resolve both call origins through the same immutable, monotonic hook boundary. */
export async function resolveToolPolicy(
  context: ToolContext,
  tool: ToolDefinition,
  args: unknown,
  signal: AbortSignal,
  origin: "model" | "control" = "model",
  retain?: (operation: Promise<unknown>) => void,
): Promise<ToolDefinition> {
  signal.throwIfAborted();
  invariant(isToolArguments(args), "Tool arguments must be an object");
  let policy = origin === "model" ? modelPolicyTool(context, tool, args) : tool;
  let frozenArgs: Record<string, unknown> | undefined;
  for (const integration of context.kernel.integrations) {
    if (!integration.authorize) continue;
    signal.throwIfAborted();
    frozenArgs ??= deepFreeze(structuredClone(args));
    const operation = Promise.resolve(
      integration.authorize(
        { ...context, signal },
        deepFreeze({
          ...policy,
          capabilities: [...(policy.capabilities || [])],
        }),
        frozenArgs,
      ),
    );
    retain?.(operation);
    const next = await abortable(operation, signal);
    if (!next) continue;
    invariant(
      next.name === tool.name,
      origin === "control"
        ? "Invalid control authorization hook"
        : "Invalid authorization hook declaration",
      403,
    );
    invariant(
      !next.risk || isToolRisk(next.risk),
      origin === "control"
        ? "Invalid control risk"
        : "Invalid authorization hook declaration",
      403,
    );
    policy = {
      ...(origin === "model" ? { ...policy, ...next } : tool),
      name: tool.name,
      source: tool.source,
      parameters: tool.parameters,
      execute: tool.execute,
      ...mergeToolConstraints(
        policy,
        next,
        origin === "model" ? policy.risk || "execute" : policy.risk,
      ),
    };
  }
  return policy;
}

function isToolArguments(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}

/** Cache only within one request: permissions can change before the next model step. */
export function filterModelContext(
  permissions: Pick<Permissions, "evaluate">,
  session: Session,
  routeId: string,
  messages: Message[],
  tools: ToolDefinition[],
): Message[] {
  let memoryAllowed: boolean | undefined;
  const allowed = (tool: ToolDefinition) =>
    permissions.evaluate(session, session.routeId, tool).effect === "allow" &&
    (routeId === session.routeId ||
      permissions.evaluate(session, routeId, tool).effect === "allow");
  return messages.filter(
    (message) =>
      message.role !== "system" ||
      !message.requiredCapabilities?.length ||
      message.requiredCapabilities.every((capability) => {
        if (capability !== "memory.read") return false;
        memoryAllowed ??= tools.some(
          (tool) => tool.capabilities?.includes("memory.read") && allowed(tool),
        );
        return memoryAllowed;
      }),
  );
}
