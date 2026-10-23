import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Kernel } from "../core/kernel.js";
import type { Project, Session } from "../contracts.js";
import type { ToolDefinition } from "./types.js";
import { CAPABILITIES } from "./types.js";
import { invariant, abortable } from "../core/util.js";
import type { RunHooks } from "./hooks.js";

export interface ToolContext {
  signal?: AbortSignal;
  kernel: Kernel;
  runId: string;
  session: Session;
  routeId: string;
}
/** Optional extension surface: query/use services without depending on the full Kernel. */
export interface KernelServices {
  readonly projects: { get(projectId: string): Project };
  readonly assets: Pick<
    Kernel["assets"],
    "owned" | "read" | "create" | "createStream" | "openVerified"
  >;
  readonly memory: Pick<Kernel["memory"], "get" | "retrieve" | "propose">;
  readonly permissions: Pick<Kernel["permissions"], "evaluate">;
}
export interface ServiceToolContext extends Omit<ToolContext, "kernel"> {
  services: KernelServices;
}
export type ServiceToolFactory = (
  context: ServiceToolContext,
) => ToolDefinition[] | Promise<ToolDefinition[]>;

const serviceFacades = new WeakMap<Kernel, KernelServices>();
function servicesFor(kernel: Kernel): KernelServices {
  let services = serviceFacades.get(kernel);
  if (!services) {
    services = Object.freeze({
      projects: Object.freeze({ get: kernel.store.project.bind(kernel.store) }),
      assets: Object.freeze({
        owned: kernel.assets.owned.bind(kernel.assets),
        read: kernel.assets.read.bind(kernel.assets),
        create: kernel.assets.create.bind(kernel.assets),
        createStream: kernel.assets.createStream.bind(kernel.assets),
        openVerified: kernel.assets.openVerified.bind(kernel.assets),
      }),
      memory: Object.freeze({
        get: kernel.memory.get.bind(kernel.memory),
        retrieve: kernel.memory.retrieve.bind(kernel.memory),
        propose: kernel.memory.propose.bind(kernel.memory),
      }),
      permissions: Object.freeze({
        evaluate: kernel.permissions.evaluate.bind(kernel.permissions),
      }),
    });
    serviceFacades.set(kernel, services);
  }
  return services;
}
export interface IntegrationResponse {
  data: unknown;
  status?: number;
}
export interface KernelIntegration {
  id: string;
  /** Bounded by extensions.timeoutMs; observe signal to stop initialization I/O. */
  install?: (kernel: Kernel, signal?: AbortSignal) => void | Promise<void>;
  tools?: (
    context: ToolContext,
  ) => ToolDefinition[] | Promise<ToolDefinition[]>;
  /** Alternative to tools, with an injectable, narrow context for extension tests. */
  serviceTools?: ServiceToolFactory;
  authorize?: (
    context: ToolContext,
    tool: ToolDefinition,
    args: Record<string, unknown>,
  ) => ToolDefinition | void | Promise<ToolDefinition | void>;
  handle?: (
    kernel: Kernel,
    req: IncomingMessage,
    url: URL,
    json: () => Promise<unknown>,
  ) => Promise<IntegrationResponse | undefined>;
  handlePublic?: (
    kernel: Kernel,
    req: IncomingMessage,
    url: URL,
    json: () => Promise<unknown>,
  ) => Promise<IntegrationResponse | undefined>;
  upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  settled?: (runId: string, signal?: AbortSignal) => void | Promise<void>;
  /** Lifecycle hooks applied to every run, after config command hooks. */
  hooks?: RunHooks;
  close?: (kernel?: Kernel) => void | Promise<void>;
}
/** Source-level extension registry. Unregistration revokes previously resolved tool closures. */
export class ToolRegistry {
  private entries = new Map<
    string,
    { generation: symbol; factory: NonNullable<KernelIntegration["tools"]> }
  >();
  register(id: string, factory: NonNullable<KernelIntegration["tools"]>) {
    invariant(
      /^[a-zA-Z0-9._-]+$/.test(id) && !this.entries.has(id),
      "Duplicate or invalid tool pack ID",
    );
    const entry = { generation: Symbol(id), factory };
    this.entries.set(id, entry);
    return () => this.entries.get(id) === entry && this.entries.delete(id);
  }
  registerServices(id: string, factory: ServiceToolFactory) {
    return this.register(id, ({ kernel, ...context }) =>
      factory({ ...context, services: servicesFor(kernel) }),
    );
  }
  list() {
    return [...this.entries.keys()];
  }
  async resolve(context: ToolContext) {
    const output: ToolDefinition[] = [],
      names = new Set<string>();
    for (const [id, entry] of this.entries) {
      const pending = Promise.resolve(entry.factory(context));
      const tools = context.signal
        ? await abortable(pending, context.signal)
        : await pending;
      for (const tool of tools) {
        const risk = tool.risk || "execute";
        invariant(
          ["read", "write", "execute", "network", "control"].includes(risk),
          "Unknown registered risk",
        );
        invariant(
          (tool.capabilities || []).every((cap) => CAPABILITIES.includes(cap)),
          "Unknown registered capability",
        );
        invariant(
          /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) && !names.has(tool.name),
          `Duplicate or invalid registered tool ${tool.name}`,
        );
        names.add(tool.name);
        output.push({
          ...tool,
          risk,
          capabilities: tool.capabilities?.length
            ? [...tool.capabilities]
            : risk === "execute"
              ? ["exec"]
              : risk === "write"
                ? ["files.write"]
                : risk === "network"
                  ? ["network"]
                  : risk === "control"
                    ? ["computer"]
                    : [],
          execute: async (...args) => {
            invariant(
              this.entries.get(id)?.generation === entry.generation,
              "Tool pack was removed or replaced",
              403,
            );
            return tool.execute(...args);
          },
        });
      }
    }
    return output;
  }
}
