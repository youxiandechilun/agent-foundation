import type { MediaRequest, MediaOutput } from "../contracts.js";
import type { Route } from "../config.js";
import { invariant } from "../util.js";

export interface AdapterResult {
  /** Optional trusted adapter report, translated from the vendor's billing response. */
  billing?: { actualUsd: number; reference: string };
  remoteId?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress?: number;
  outputs?: MediaOutput[];
  error?: string;
  state?: Record<string, unknown>;
}
export interface MediaAdapterContext {
  route: Route;
  idempotencyKey: string;
  signal: AbortSignal;
  request: (path: string, body?: unknown, method?: string) => Promise<any>;
  input: (
    assetId: string,
  ) => Promise<{ mime: string; base64: string; name: string }>;
}
/** All vendor-specific behavior belongs here. Kernel and jobs only consume these canonical contracts. */
export interface MediaAdapter {
  id: string;
  capabilities: {
    kinds: ("image" | "video")[];
    operations: MediaRequest["operation"][];
    cancellation: boolean;
    recovery: boolean;
  };
  submit(
    request: MediaRequest,
    context: MediaAdapterContext,
  ): Promise<AdapterResult>;
  poll?(
    remoteId: string,
    state: Record<string, unknown> | undefined,
    context: MediaAdapterContext,
  ): Promise<AdapterResult>;
  cancel?(
    remoteId: string,
    state: Record<string, unknown> | undefined,
    context: MediaAdapterContext,
  ): Promise<AdapterResult>;
  recover?(
    remoteId: string,
    state: Record<string, unknown> | undefined,
    context: MediaAdapterContext,
  ): Promise<AdapterResult>;
}
export class MediaAdapterRegistry {
  private adapters = new Map<string, MediaAdapter>();
  register(adapter: MediaAdapter) {
    invariant(
      typeof adapter.submit === "function" &&
        (!adapter.capabilities.cancellation ||
          typeof adapter.cancel === "function") &&
        (!adapter.capabilities.recovery ||
          typeof adapter.recover === "function"),
      "Media capabilities require their declared methods",
    );
    invariant(
      !this.adapters.has(adapter.id),
      `Duplicate media adapter ${adapter.id}`,
    );
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string) {
    const adapter = this.adapters.get(id);
    invariant(adapter, `Unknown media adapter ${id}`, 503);
    return adapter;
  }
  list() {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      ...a.capabilities,
    }));
  }
}
const outputList = (value: any, kind: "image" | "video"): MediaOutput[] => {
  if (!value) return [];
  const array = Array.isArray(value) ? value : [value];
  return array.map((item) =>
    typeof item === "string"
      ? { type: kind, url: item }
      : {
          type: item.type || kind,
          mime: item.mime || item.mime_type,
          url: item.url,
          base64: item.base64 || item.b64_json,
          text: item.text,
        },
  );
};
export const imageJsonAdapter: MediaAdapter = {
  id: "image-json",
  capabilities: {
    kinds: ["image"],
    operations: ["generate", "edit", "variation"],
    cancellation: false,
    recovery: false,
  },
  async submit(request, context) {
    const inputs = await Promise.all(
      request.inputAssets.map((id) => context.input(id)),
    );
    const data = await context.request(context.route.submitPath, {
      ...context.route.requestDefaults,
      ...request.parameters,
      model: context.route.model,
      prompt: request.prompt,
      ...(inputs.length
        ? { images: inputs.map((i) => `data:${i.mime};base64,${i.base64}`) }
        : {}),
    });
    invariant(
      Array.isArray(data.data) &&
        data.data.length > 0 &&
        data.data.length <= 16,
      "Image adapter expected data[1..16]",
      502,
    );
    return { status: "completed", outputs: outputList(data.data, "image") };
  },
};
export const videoJobAdapter: MediaAdapter = {
  id: "video-job",
  capabilities: {
    kinds: ["video"],
    operations: ["generate", "edit"],
    cancellation: true,
    recovery: true,
  },
  async submit(request, context) {
    const inputs = await Promise.all(
      request.inputAssets.map((id) => context.input(id)),
    );
    const data = await context.request(context.route.submitPath, {
      ...context.route.requestDefaults,
      ...request.parameters,
      model: context.route.model,
      prompt: request.prompt,
      ...(inputs.length ? { inputs } : {}),
    });
    return normalize(data, "video");
  },
  async poll(id, state, context) {
    return normalize(
      await context.request(
        context.route.pollPath.replace("{id}", encodeURIComponent(id)),
      ),
      "video",
    );
  },
  async recover(id, state, context) {
    return this.poll!(id, state, context);
  },
  async cancel(id, state, context) {
    invariant(
      context.route.cancelPath,
      "Provider cancel path is not configured",
      501,
    );
    return normalize(
      await context.request(
        context.route.cancelPath.replace("{id}", encodeURIComponent(id)),
        {},
        "POST",
      ),
      "video",
    );
  },
};
function normalize(data: any, kind: "image" | "video"): AdapterResult {
  invariant(
    ["queued", "running", "completed", "failed", "cancelled"].includes(
      data.status,
    ),
    "Media provider status is unknown",
    502,
  );
  invariant(
    data.status === "completed" ||
      data.status === "failed" ||
      typeof data.id === "string",
    "Asynchronous media provider did not return an id",
    502,
  );
  return {
    remoteId: data.id,
    status: data.status,
    progress: data.progress,
    outputs: outputList(data.output || data.outputs, kind),
    error: data.error?.message || data.error,
  };
}
export const getPath = (object: any, pointer: string) =>
  pointer
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => value?.[key], object);
function template(
  value: unknown,
  request: MediaRequest,
  route: Route,
): unknown {
  const lookup = { ...request, model: route.model };
  if (typeof value === "string") {
    const match = value.match(/^\{\{([\w.]+)\}\}$/);
    if (match) return getPath(lookup, match[1]);
    return value.replace(/\{\{([\w.]+)\}\}/g, (_, p) =>
      String(getPath(lookup, p) ?? ""),
    );
  }
  if (Array.isArray(value))
    return value.map((v) => template(v, request, route));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, template(v, request, route)]),
    );
  return value;
}
export const mappedHttpAdapter: MediaAdapter = {
  id: "media-http",
  capabilities: {
    kinds: ["image", "video"],
    operations: ["generate", "edit", "variation"],
    cancellation: true,
    recovery: true,
  },
  async submit(request, context) {
    const mapping = context.route.mapping;
    invariant(
      mapping?.requestTemplate,
      "media-http requires mapping.requestTemplate",
    );
    const body = template(mapping.requestTemplate, request, context.route);
    const data = await context.request(context.route.submitPath, body);
    return mapped(data, context.route, request.kind);
  },
  async poll(id, state, context) {
    return mapped(
      await context.request(
        context.route.pollPath.replace("{id}", encodeURIComponent(id)),
      ),
      context.route,
      context.route.kind as "image" | "video",
    );
  },
  async recover(id, state, context) {
    return this.poll!(id, state, context);
  },
  async cancel(id, state, context) {
    invariant(context.route.cancelPath, "Cancel path missing", 501);
    return mapped(
      await context.request(
        context.route.cancelPath.replace("{id}", encodeURIComponent(id)),
        {},
        "POST",
      ),
      context.route,
      context.route.kind as "image" | "video",
    );
  },
};
function mapped(
  data: unknown,
  route: Route,
  kind: "image" | "video",
): AdapterResult {
  const m = route.mapping!,
    raw = String(getPath(data, m.status));
  const status = m.statuses[raw] || raw;
  return normalize(
    {
      id: getPath(data, m.id),
      status,
      progress: getPath(data, m.progress),
      output: getPath(data, m.outputs),
    },
    kind,
  );
}
