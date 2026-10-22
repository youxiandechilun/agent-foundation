import type { KernelIntegration, ToolContext } from "../runtime/registry.js";
import type { Capability } from "../runtime/types.js";
import type { Kernel } from "../core/kernel.js";
import type { DesktopKernel } from "./desktop.js";
import { desktopTools } from "./desktop-tools.js";
import { desktopManagement } from "./desktop-api.js";
import { invariant } from "../core/util.js";
import { officeManagement } from "./office/api.js";
import {
  applicationCapabilities,
  browserAccess,
  computerAccess,
  hostApplicationAccess,
  officeAccess,
} from "./access.js";
import { requestSignal } from "./request-signal.js";
export { browserCapabilities, hostApplicationAccess } from "./access.js";

export interface ApplicationOptions {
  browser?: boolean;
  computer?: boolean;
  office?: boolean;
}
/** Individually enabled source application packs; importing this entry does not load optional engines. */
export function applicationIntegration(
  options: ApplicationOptions = {},
): KernelIntegration {
  const enabled = {
    browser: options.browser ?? true,
    computer: options.computer ?? true,
    office: options.office ?? true,
  };
  const features = Object.keys(enabled).filter(
    (k) => enabled[k as keyof typeof enabled],
  );
  let services: Partial<DesktopKernel> = {},
    disposed = false;
  return {
    id: "applications-" + features.join("-"),
    async install(kernel) {
      invariant(features.length > 0, "No application plugins selected");
      const [browser, computer, office, bridge] = await Promise.all([
        enabled.browser ? import("./browser/manager.js") : undefined,
        enabled.computer ? import("./computer/manager.js") : undefined,
        enabled.office ? import("./office/manager.js") : undefined,
        enabled.browser ? import("./browser/bridge.js") : undefined,
      ]);
      const created: Partial<DesktopKernel> = {};
      if (browser)
        created.browser = new browser.BrowserManager(
          kernel.config,
          kernel.store,
          kernel.assets,
          (projectId, action) => browserAccess(kernel, projectId, action),
        );
      if (computer)
        created.computer = new computer.ComputerController(
          kernel.config,
          kernel.assets,
          (projectId, action) => computerAccess(kernel, projectId, action),
        );
      if (office)
        created.office = new office.Office(
          kernel.assets,
          kernel.config,
          (projectId, write, toolName) =>
            officeAccess(kernel, projectId, write, toolName),
        );
      services = created;
      if (bridge) {
        const browserBridge = new bridge.BrowserBridge(kernel);
        Object.assign(services, { browserBridge, nodes: browserBridge.nodes });
      }
      Object.assign(kernel, services);
      if (office) {
        const { officeExtractor } = await import("./office/extractor.js");
        kernel.assets.extractors.register(
          officeExtractor(kernel.assets, services.office),
        );
      }
    },
    async tools(context) {
      invariant(!disposed, "Application plugins have closed", 503);
      return (
        await desktopTools(
          context as ToolContext & { kernel: DesktopKernel },
          features,
        )
      ).map((tool) => ({
        ...tool,
        source: {
          kind: "builtin" as const,
          id: "application-" + tool.name.split("_")[0],
        },
      }));
    },
    authorize(_context, tool, args) {
      return { ...tool, capabilities: applicationCapabilities(tool, args) };
    },
    async handle(kernel, req, url, json) {
      const request = requestSignal(req);
      try {
        const key = url.pathname.split("/")[2];
        if (url.pathname === "/v1/applications" && req.method === "GET")
          return { data: { enabled: features, sourceOwned: true, ui: false } };
        if (!features.includes(key)) return;
        const p = url.pathname.split("/").filter(Boolean);
        if (key === "browser" && p[2] === "bridge") {
          const bridge = services.browserBridge!;
          if (req.method === "GET" && p.length === 3)
            return {
              data: {
                nodes: bridge.nodes.list(
                  url.searchParams.get("projectId") || undefined,
                ),
                networkEnforcement: "reviewed-actions-only",
              },
            };
          const isPair =
            req.method === "POST" && p.length === 4 && p[3] === "pair";
          const isRevoke = req.method === "DELETE" && p.length === 4;
          const isAction =
            req.method === "POST" && p.length === 5 && p[4] === "action";
          if (!isPair && !isRevoke && !isAction) return;
          const input = zBridgeEnvelope(await json());
          if (isRevoke) {
            invariant(
              bridge.nodes.list(input.projectId).some((n) => n.id === p[3]),
              "Browser bridge belongs to another project",
              403,
            );
            bridge.nodes.revoke(p[3]);
            return { data: { revoked: true } };
          }
          hostApplicationAccess(
            kernel,
            input.projectId,
            ["node", "browser", "network"],
            "browser_action",
          );
          if (isPair)
            return {
              data: bridge.pair(
                input.projectId,
                zString(input.name, "browser extension"),
              ),
              status: 201,
            };
          if (isAction) {
            const { projectId, ...args } = input;
            const result: any = await bridge.action(
              projectId,
              p[3],
              args,
              request.signal,
            );
            if (result?.base64) {
              const asset = await kernel.assets.create(
                projectId,
                "user-browser.png",
                Buffer.from(result.base64, "base64"),
                "artifact",
                "image/png",
                request.signal,
              );
              return { data: { tabId: result.tabId, asset } };
            }
            return { data: result };
          }
          return;
        }
        if (key === "office")
          return await officeManagement(
            kernel as Kernel & { office: import("./office/manager.js").Office },
            req,
            url,
            json,
            request.signal,
          );
        const input = req.method === "GET" ? {} : await json();
        if (
          req.method !== "GET" &&
          req.method !== "DELETE" &&
          input?.projectId
        ) {
          const caps: Capability[] =
            key === "browser"
              ? [
                  "browser",
                  "network",
                  ...(input.action === "upload" ? ["files.read" as const] : []),
                  ...(["download", "screenshot"].includes(input.action)
                    ? ["files.write" as const]
                    : []),
                ]
              : key === "computer"
                ? [
                    "computer",
                    ...(input.action === "screenshot"
                      ? ["files.write" as const]
                      : []),
                  ]
                : ["files.read"];
          hostApplicationAccess(
            kernel,
            input.projectId,
            caps,
            key === "browser"
              ? p.length === 2
                ? "browser_open"
                : "browser_action"
              : "computer_action",
          );
        }
        return await desktopManagement(
          kernel as DesktopKernel,
          req,
          url,
          async () => input,
          request.signal,
        );
      } finally {
        request.dispose();
      }
    },
    settled: (runId) => services.computer?.release(runId),
    upgrade(req, socket, head) {
      if (
        !services.browserBridge ||
        new URL(req.url || "/", "http://localhost").pathname !==
          "/v1/nodes/channel"
      )
        return false;
      services.browserBridge.nodes.upgrade(req, socket, head);
      return true;
    },
    async close() {
      disposed = true;
      await services.browser?.close();
      await services.office?.close();
      await services.computer?.close();
      services.browserBridge?.close();
    },
  };
}
export const browserIntegration = () =>
  applicationIntegration({ browser: true, computer: false, office: false });
export const computerIntegration = () =>
  applicationIntegration({ browser: false, computer: true, office: false });
export const officeIntegration = () =>
  applicationIntegration({ browser: false, computer: false, office: true });

import { z } from "zod";
const zBridgeEnvelope = (input: unknown) =>
  z.object({ projectId: z.string() }).passthrough().parse(input);
const zString = (input: unknown, fallback: string) =>
  z.string().min(1).max(100).default(fallback).parse(input);
