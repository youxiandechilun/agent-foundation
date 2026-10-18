/** Optional reference integration. Never imported by the default core entry point. */
import type { BrowserManager } from "./browser/manager.js";
import type { ComputerController } from "./computer/manager.js";
import type { NodeManager } from "./nodes.js";
import type { Office } from "./office/manager.js";
import type { Kernel } from "../core/kernel.js";
import type { KernelIntegration } from "../runtime/registry.js";
import { createApplicationIntegration } from "./integration.js";

export interface DesktopServices {
  browser: BrowserManager;
  computer: ComputerController;
  nodes: NodeManager;
  office: Office;
  browserBridge?: import("./browser/bridge.js").BrowserBridge;
}
export type DesktopKernel = Kernel & DesktopServices;
export function desktopIntegration(): KernelIntegration {
  return createApplicationIntegration({}, "desktop-reference");
}
