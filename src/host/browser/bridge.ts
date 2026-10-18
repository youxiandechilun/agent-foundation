import { z } from "zod";
import type { Kernel } from "../../core/kernel.js";
import { NodeManager } from "../nodes.js";
import { hostApplicationAccess } from "../access.js";
import { validateBrowserUrl } from "./network.js";
import { invariant } from "../../core/util.js";

export const bridgeActionSchema = z
  .object({
    action: z.enum([
      "tabs",
      "inspect",
      "navigate",
      "click",
      "double_click",
      "fill",
      "press",
      "scroll",
      "screenshot",
      "reload",
      "back",
      "forward",
      "select",
      "check",
      "uncheck",
      "hover",
      "close_tab",
    ]),
    tabId: z
      .union([z.string().regex(/^\d+$/), z.number().int().positive()])
      .optional(),
    selector: z.string().max(2000).optional(),
    text: z.string().max(100000).optional(),
    key: z.string().max(100).optional(),
    url: z.string().max(16384).optional(),
    x: z.number().finite().min(-100000).max(100000).optional(),
    y: z.number().finite().min(-100000).max(100000).optional(),
    values: z.array(z.string().max(1000)).max(100).optional(),
  })
  .strict();
/** Paired user browser transport. Existing browser traffic remains under the user's browser configuration. */
export class BrowserBridge {
  readonly nodes: NodeManager;
  constructor(private kernel: Kernel) {
    this.nodes = new NodeManager(kernel.store, (node, cap, args) => {
      invariant(
        node.kind === "browser" &&
          node.capabilities.length === 1 &&
          node.capabilities[0] === "browser.control" &&
          (!cap || cap === "browser.control"),
        "Paired node is not a browser bridge",
        403,
      );
      const action = (args as any)?.action;
      hostApplicationAccess(
        kernel,
        node.projectId,
        [
          "node",
          "browser",
          "network",
          ...(action === "screenshot" ? ["files.write" as const] : []),
        ],
        "browser_action",
      );
      invariant(kernel.config.browser.enabled, "Browser bridge disabled", 403);
    });
  }
  pair(projectId: string, name: string) {
    hostApplicationAccess(
      this.kernel,
      projectId,
      ["node", "browser", "network"],
      "browser_action",
    );
    return this.nodes.pair({
      projectId,
      name,
      kind: "browser",
      capabilities: ["browser.control"],
    });
  }
  async action(
    projectId: string,
    nodeId: string,
    input: unknown,
    signal?: AbortSignal,
  ) {
    const args = bridgeActionSchema.parse(input);
    if (args.url) await validateBrowserUrl(args.url, this.kernel.config);
    if (args.action === "tabs") {
      const tabs = (await this.nodes.call(
        projectId,
        nodeId,
        "browser.control",
        args,
        this.kernel.config.browser.timeoutMs,
        signal,
      )) as any[];
      const accepted = [];
      for (const tab of tabs) {
        try {
          await validateBrowserUrl(String(tab.url), this.kernel.config);
          accepted.push(tab);
        } catch {}
      }
      return accepted;
    }
    const context: any = await this.nodes.call(
      projectId,
      nodeId,
      "browser.control",
      { action: "context", tabId: args.tabId },
      this.kernel.config.browser.timeoutMs,
      signal,
    );
    invariant(
      typeof context.url === "string" && Number.isSafeInteger(context.tabId),
      "Browser bridge returned invalid context",
      502,
    );
    await validateBrowserUrl(context.url, this.kernel.config);
    signal?.throwIfAborted();
    return this.nodes.call(
      projectId,
      nodeId,
      "browser.control",
      { ...args, tabId: context.tabId, expectedUrl: context.url },
      this.kernel.config.browser.timeoutMs,
      signal,
    );
  }
  close() {
    this.nodes.close();
  }
}
