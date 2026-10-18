import type { Kernel } from "../core/kernel.js";
import type { Capability } from "../runtime/types.js";
import type { PolicyRule } from "../contracts.js";
import { invariant } from "../core/util.js";

/** The authenticated operator API still obeys host and project deny policies. */
export function hostApplicationAccess(
  kernel: Kernel,
  projectId: string,
  capabilities: Capability[],
  toolName: string,
) {
  kernel.store.project(projectId);
  const policies = capabilities.length
    ? kernel.store.list<PolicyRule>("policies")
    : [];
  const pluginId = "application-" + toolName.split("_")[0];
  for (const capability of capabilities) {
    invariant(
      kernel.config.permissions[capability] !== "deny",
      "Application capability denied: " + capability,
      403,
      "permission_denied",
    );
    for (const rule of policies)
      if (
        rule.effect === "deny" &&
        rule.capabilities?.includes(capability) &&
        (!rule.projectId || rule.projectId === projectId) &&
        !rule.routeId &&
        !rule.mode &&
        (!rule.pluginId || rule.pluginId === pluginId) &&
        (!rule.tools || rule.tools.includes(toolName)) &&
        (!rule.expiresAt || Date.parse(rule.expiresAt) > Date.now())
      )
        invariant(
          false,
          "Application action denied by project policy",
          403,
          "permission_denied",
        );
  }
}
export function browserAccess(
  kernel: Kernel,
  projectId: string,
  action?: { action?: string },
) {
  hostApplicationAccess(
    kernel,
    projectId,
    [
      "browser",
      "network",
      ...(action?.action === "upload" ? ["files.read" as const] : []),
      ...(["screenshot", "download"].includes(action?.action || "")
        ? ["files.write" as const]
        : []),
    ],
    action ? "browser_action" : "browser_open",
  );
}
export function computerAccess(
  kernel: Kernel,
  projectId: string,
  action: { action?: string },
) {
  hostApplicationAccess(
    kernel,
    projectId,
    [
      "computer",
      ...(action.action === "screenshot" ? ["files.write" as const] : []),
    ],
    "computer_action",
  );
}
export function officeAccess(
  kernel: Kernel,
  projectId: string,
  write: boolean,
  toolName?: string,
) {
  hostApplicationAccess(
    kernel,
    projectId,
    [write ? "files.write" : "files.read"],
    toolName || "office_action",
  );
}
