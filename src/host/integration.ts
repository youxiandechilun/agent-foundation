import type { KernelIntegration, ToolContext } from "../runtime/registry.js";
import type { Kernel } from "../core/kernel.js";
import type { DesktopKernel, DesktopServices } from "./desktop.js";
import type { ApplicationOptions } from "./applications.js";
import { desktopTools } from "./desktop-tools.js";
import { desktopManagement } from "./desktop-api.js";
import { closeResources, invariant } from "../core/util.js";
import { officeManagement } from "./office/api.js";
import {
  browserAccess,
  computerAccess,
  hostApplicationAccess,
  officeAccess,
  applicationCapabilities,
} from "./access.js";
import { requestSignal } from "./request-signal.js";
import { z } from "zod";

/** Shared lifecycle for the selective application packs and the reference desktop integration. */
export function createApplicationIntegration(
  options: ApplicationOptions,
  profile: "applications" | "desktop-reference",
): KernelIntegration {
  const reference = profile === "desktop-reference";
  const enabled = {
    browser: options.browser ?? true,
    computer: options.computer ?? true,
    office: options.office ?? true,
  };
  const features = Object.keys(enabled).filter(
    (k) => enabled[k as keyof typeof enabled],
  );
  let services: Partial<DesktopServices> = {},
    disposed = false;
  return {
    id: reference ? profile : "applications-" + features.join("-"),
    async install(kernel) {
      invariant(features.length > 0, "No application plugins selected");
      const [browser, computer, office, bridge, nodes] = await Promise.all([
        enabled.browser ? import("./browser/manager.js") : undefined,
        enabled.computer ? import("./computer/manager.js") : undefined,
        enabled.office ? import("./office/manager.js") : undefined,
        enabled.browser && !reference
          ? import("./browser/bridge.js")
          : undefined,
        reference ? import("./nodes.js") : undefined,
      ]);
      const created: Partial<DesktopServices> = {};
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
      if (nodes) services.nodes = new nodes.NodeManager(kernel.store);
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
      const tools = await desktopTools(
        context as ToolContext & { kernel: DesktopKernel },
        reference ? undefined : features,
      );
      return reference
        ? tools
        : tools.map((tool) => ({
            ...tool,
            source: {
              kind: "builtin" as const,
              id: "application-" + tool.name.split("_")[0],
            },
          }));
    },
    async authorize(context, tool, args) {
      const browserArgs =
        reference && tool.name === "browser_action" && args.nodeId
          ? args
          : reference &&
              tool.name === "node_call" &&
              String(args.capability || "").startsWith("browser.")
            ? z.record(z.string(), z.unknown()).parse(args.args)
            : undefined;
      if (browserArgs?.url) {
        const { validateBrowserUrl } = await import("./browser/manager.js");
        await validateBrowserUrl(
          String(browserArgs.url),
          context.kernel.config,
        );
      }
      return { ...tool, capabilities: applicationCapabilities(tool, args) };
    },
    async handle(kernel, req, url, json) {
      const request = requestSignal(req);
      try {
        if (reference)
          return await desktopManagement(
            kernel as DesktopKernel,
            req,
            url,
            json,
            request.signal,
          );
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
          const input = bridgeEnvelopeSchema.parse(await json());
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
                bridgeNameSchema.parse(input.name),
              ),
              status: 201,
            };
          if (isAction) {
            const { projectId, ...args } = input;
            const result: unknown = await bridge.action(
              projectId,
              p[3],
              args,
              request.signal,
            );
            if (
              result &&
              typeof result === "object" &&
              "base64" in result &&
              typeof result.base64 === "string" &&
              result.base64
            ) {
              const asset = await kernel.assets.create(
                projectId,
                "user-browser.png",
                Buffer.from(result.base64, "base64"),
                "artifact",
                "image/png",
                request.signal,
              );
              return {
                data: {
                  tabId: "tabId" in result ? result.tabId : undefined,
                  asset,
                },
              };
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
          if (key === "browser")
            browserAccess(
              kernel,
              input.projectId,
              p.length === 2 ? undefined : input,
            );
          else computerAccess(kernel, input.projectId, input);
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
    async handlePublic(_kernel, req, url, json) {
      if (!reference) return;
      const p = url.pathname.split("/").filter(Boolean);
      if (
        p[0] !== "v1" ||
        p[1] !== "nodes" ||
        !p[2] ||
        !["poll", "heartbeat", "result"].includes(p[3])
      )
        return;
      const nodeId = p[2],
        nodes = services.nodes!;
      nodes.verify(
        nodeId,
        req.headers.authorization?.replace(/^Bearer /, "") || "",
      );
      if (p[3] === "poll" && req.method === "GET")
        return { data: { task: nodes.claim(nodeId) || null } };
      if (p[3] === "heartbeat" && req.method === "POST")
        return { data: nodes.heartbeat(nodeId) };
      if (p[3] === "result" && req.method === "POST") {
        const v = await json();
        return {
          data: nodes.complete(nodeId, v.taskId, {
            ok: v.ok,
            result: v.result,
            error: v.error,
          }),
        };
      }
    },
    upgrade(req, socket, head) {
      const nodes = reference ? services.nodes : services.browserBridge?.nodes;
      if (
        !nodes ||
        new URL(req.url || "/", "http://localhost").pathname !==
          "/v1/nodes/channel"
      )
        return false;
      nodes.upgrade(req, socket, head);
      return true;
    },
    async close() {
      disposed = true;
      await closeResources(
        [
          services.browser,
          services.office,
          services.computer,
          services.browserBridge,
          reference ? services.nodes : undefined,
        ],
        "Application cleanup reported errors",
      );
    },
  };
}
const bridgeEnvelopeSchema = z.object({ projectId: z.string() }).passthrough();
const bridgeNameSchema = z
  .string()
  .min(1)
  .max(100)
  .default("browser extension");
