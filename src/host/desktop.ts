/** Optional reference integration. Never imported by the default core entry point. */
import { BrowserManager, validateBrowserUrl } from "./browser/manager.js";
import { ComputerController } from "./computer/manager.js";
import { NodeManager } from "./nodes.js";
import { Office } from "./office/manager.js";
import type { Kernel } from "../core/kernel.js";
import type { KernelIntegration } from "../runtime/registry.js";
import type { Capability } from "../runtime/types.js";
import { desktopTools } from "./desktop-tools.js";
import { desktopManagement } from "./desktop-api.js";
import { officeExtractor } from "./office/extractor.js";
import { hostApplicationAccess } from "./access.js";

export interface DesktopServices {
  browser: BrowserManager;
  computer: ComputerController;
  nodes: NodeManager;
  office: Office;
  browserBridge?: import("./browser/bridge.js").BrowserBridge;
}
export type DesktopKernel = Kernel & DesktopServices;
export function desktopIntegration(): KernelIntegration {
  let services: DesktopServices | undefined;
  return {
    id: "desktop-reference",
    install(kernel) {
      services = {
        browser: new BrowserManager(
          kernel.config,
          kernel.store,
          kernel.assets,
          (projectId, action) =>
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
            ),
        ),
        computer: new ComputerController(
          kernel.config,
          kernel.assets,
          (projectId, action) =>
            hostApplicationAccess(
              kernel,
              projectId,
              [
                "computer",
                ...(action.action === "screenshot"
                  ? ["files.write" as const]
                  : []),
              ],
              "computer_action",
            ),
        ),
        nodes: new NodeManager(kernel.store),
        office: new Office(
          kernel.assets,
          kernel.config,
          (projectId, write, toolName) =>
            hostApplicationAccess(
              kernel,
              projectId,
              [write ? "files.write" : "files.read"],
              toolName || "office_action",
            ),
        ),
      };
      Object.assign(kernel, services);
      kernel.assets.extractors.register(
        officeExtractor(kernel.assets, services.office),
      );
    },
    tools: (context) =>
      desktopTools({ ...context, kernel: context.kernel as DesktopKernel }),
    async authorize(context, tool, args) {
      const capabilities: Capability[] = [...(tool.capabilities || [])];
      if (tool.name === "browser_action" && args.nodeId)
        capabilities.push("node");
      if (tool.name === "browser_open" || tool.name === "browser_action")
        capabilities.push("network");
      if (tool.name === "browser_action" && args.action === "upload")
        capabilities.push("files.read");
      if (
        tool.name === "browser_action" &&
        ["download", "screenshot"].includes(String(args.action))
      )
        capabilities.push("files.write");
      if (tool.name === "computer_action" && args.action === "screenshot")
        capabilities.push("files.write");
      if (tool.name === "node_call") {
        const cap = String(args.capability || "");
        if (cap.startsWith("browser.")) capabilities.push("browser");
        if (cap.startsWith("computer.")) capabilities.push("computer");
        if (cap.startsWith("exec.")) capabilities.push("exec");
      }
      const browserArgs =
        tool.name === "browser_action" && args.nodeId
          ? args
          : tool.name === "node_call" &&
              String(args.capability || "").startsWith("browser.")
            ? (args.args as Record<string, unknown>)
            : undefined;
      if (browserArgs?.url)
        await validateBrowserUrl(
          String(browserArgs.url),
          context.kernel.config,
        );
      return { ...tool, capabilities: [...new Set(capabilities)] };
    },
    handle: (kernel, req, url, json) =>
      desktopManagement(kernel as DesktopKernel, req, url, json),
    async handlePublic(_kernel, req, url, json) {
      const p = url.pathname.split("/").filter(Boolean);
      if (
        p[0] !== "v1" ||
        p[1] !== "nodes" ||
        !p[2] ||
        !["poll", "heartbeat", "result"].includes(p[3])
      )
        return;
      const nodeId = p[2],
        token = req.headers.authorization?.replace(/^Bearer /, "") || "";
      services!.nodes.verify(nodeId, token);
      if (p[3] === "poll" && req.method === "GET")
        return { data: { task: services!.nodes.claim(nodeId) || null } };
      if (p[3] === "heartbeat" && req.method === "POST")
        return { data: services!.nodes.heartbeat(nodeId) };
      if (p[3] === "result" && req.method === "POST") {
        const v = await json();
        return {
          data: services!.nodes.complete(nodeId, v.taskId, {
            ok: v.ok,
            result: v.result,
            error: v.error,
          }),
        };
      }
    },
    upgrade(req, socket, head) {
      if (
        new URL(req.url || "/", "http://localhost").pathname !==
        "/v1/nodes/channel"
      )
        return false;
      services!.nodes.upgrade(req, socket, head);
      return true;
    },
    settled: (runId) => services?.computer.release(runId),
    async close() {
      await services?.browser.close();
      await services?.office.close();
      await services?.computer.close();
      services?.nodes.close();
    },
  };
}
