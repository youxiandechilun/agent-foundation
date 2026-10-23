import type { KernelIntegration, ToolContext } from "../runtime/registry.js";
import type { Kernel } from "../core/kernel.js";
import type { DesktopKernel, DesktopServices } from "./desktop.js";
import type { ApplicationOptions } from "./applications.js";
import { desktopTools } from "./desktop-tools.js";
import { desktopManagement } from "./desktop-api.js";
import { closeResources, invariant } from "../core/util.js";
import { wireObject } from "../core/wire.js";
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
  let owner: Kernel | undefined;
  let installation: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let unregisterExtractor: (() => unknown) | undefined;
  const requireOwner = (kernel: Kernel) => {
    invariant(!disposed, "Application plugins have closed", 503);
    invariant(
      owner === kernel,
      "Application plugins belong to another kernel",
      409,
    );
  };
  return {
    id: reference ? profile : "applications-" + features.join("-"),
    async install(kernel) {
      invariant(!disposed, "Application plugins have closed", 503);
      invariant(
        !owner || owner === kernel,
        "An application integration instance belongs to one kernel",
        409,
      );
      if (installation) return installation;
      owner = kernel;
      installation = (async () => {
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
        requireOwner(kernel);
        const serviceNames = [
          ...features,
          ...(reference || enabled.browser ? ["nodes"] : []),
          ...(enabled.browser && !reference ? ["browserBridge"] : []),
        ];
        invariant(
          serviceNames.every((name) => !(name in kernel)),
          "Application service is already installed on this kernel",
          409,
        );
        const created: Partial<DesktopServices> = {};
        // Keep partially created services reachable if construction or extractor
        // registration fails, so Kernel.close can release them.
        services = created;
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
        if (nodes) services.nodes = new nodes.NodeManager(kernel.store);
        if (bridge) {
          const browserBridge = new bridge.BrowserBridge(kernel);
          Object.assign(services, {
            browserBridge,
            nodes: browserBridge.nodes,
          });
        }
        Object.assign(kernel, services);
        if (office) {
          const { officeExtractor } = await import("./office/extractor.js");
          requireOwner(kernel);
          unregisterExtractor = kernel.assets.extractors.register(
            officeExtractor(kernel.assets, services.office),
          );
        }
      })();
      return installation;
    },
    async tools(context) {
      requireOwner(context.kernel);
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
      requireOwner(context.kernel);
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
      requireOwner(kernel);
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
            const result = await bridge.action(
              projectId,
              p[3],
              args,
              request.signal,
            );
            const image = wireObject(result);
            if (typeof image?.base64 === "string" && image.base64) {
              const asset = await kernel.assets.create(
                projectId,
                "user-browser.png",
                Buffer.from(image.base64, "base64"),
                "artifact",
                "image/png",
                request.signal,
              );
              return {
                data: {
                  tabId: image.tabId,
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
        const input =
          req.method === "GET"
            ? {}
            : z.record(z.string(), z.unknown()).parse(await json());
        if (
          req.method !== "GET" &&
          req.method !== "DELETE" &&
          typeof input.projectId === "string"
        ) {
          const action =
            typeof input.action === "string" ? { action: input.action } : {};
          if (key === "browser")
            browserAccess(
              kernel,
              input.projectId,
              p.length === 2 ? undefined : action,
            );
          else computerAccess(kernel, input.projectId, action);
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
    async handlePublic(kernel, req, url, json) {
      requireOwner(kernel);
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
        const v = nodeResultSchema.parse(await json());
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
    async close(kernel?: Kernel) {
      // A different Kernel may be unwinding a rejected shared installation.
      if (kernel && owner && kernel !== owner) return;
      if (closing) return closing;
      disposed = true;
      closing = (async () => {
        await installation?.catch(() => undefined);
        unregisterExtractor?.();
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
      })();
      return closing;
    },
  };
}
const bridgeEnvelopeSchema = z.object({ projectId: z.string() }).passthrough();
const bridgeNameSchema = z
  .string()
  .min(1)
  .max(100)
  .default("browser extension");
const nodeResultSchema = z.object({
  taskId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
