import type { Config, Route } from "../core/config.js";
import type { Job, MediaRequest, MediaOutput } from "../contracts.js";
import { Store } from "../storage/store.js";
import { Assets } from "../storage/assets.js";
import { PluginManager } from "../extensions/plugins/manager.js";
import {
  MediaAdapterRegistry,
  imageJsonAdapter,
  videoJobAdapter,
  mappedHttpAdapter,
  type MediaAdapter,
  type AdapterResult,
  type MediaAdapterContext,
} from "./adapters.js";
import { routeHeaders } from "../providers/text.js";
import { checkUnits, requestUnits } from "../runtime/billing.js";
import { readJson } from "../providers/sse.js";
import type { CostLedger } from "../runtime/cost.js";
import {
  id,
  now,
  hash,
  invariant,
  delay,
  errorText,
  abortable,
} from "../core/util.js";

export interface MediaInput {
  projectId: string;
  sessionId?: string;
  runId?: string;
  kind: "image" | "video";
  prompt: string;
  routeId?: string;
  idempotencyKey: string;
  request?: Partial<MediaRequest>;
}
export class Media {
  readonly adapters = new MediaAdapterRegistry();
  private running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  constructor(
    readonly store: Store,
    readonly assets: Assets,
    readonly config: Config,
    readonly plugins?: PluginManager,
    readonly costs?: CostLedger,
  ) {
    [imageJsonAdapter, videoJobAdapter, mappedHttpAdapter].forEach((adapter) =>
      this.adapters.register(adapter),
    );
  }
  create(input: MediaInput) {
    this.store.project(input.projectId);
    const routeId = input.routeId || this.config.defaultRoutes[input.kind];
    invariant(routeId, `No ${input.kind} route configured`);
    const configured = this.config.routes[routeId];
    invariant(
      configured?.enabled && configured.kind === input.kind,
      "Media route absent/disabled",
    );
    const route = structuredClone(configured);
    routeHeaders(route);
    const request: MediaRequest = {
      schemaVersion: 1,
      kind: input.kind,
      operation: input.request?.operation || "generate",
      prompt: input.prompt,
      inputAssets: input.request?.inputAssets || [],
      parameters: input.request?.parameters || {},
    };
    invariant(
      request.prompt.length <= 32000 && request.inputAssets.length <= 16,
      "Media request exceeds limits",
    );
    invariant(
      request.inputAssets.reduce(
        (sum, assetId) =>
          sum + this.assets.owned(assetId, input.projectId).size,
        0,
      ) <= this.config.limits.maxInputAssetBytes,
      "Combined media input assets exceed the byte budget",
      413,
    );
    const requestHash = hash(JSON.stringify({ request, routeId }));
    const previous = this.store
      .list<Job>("jobs", { projectId: input.projectId })
      .find((j) => j.idempotencyKey === input.idempotencyKey);
    if (previous) {
      invariant(
        previous.requestHash === requestHash,
        "Media idempotency key reused with different input",
        409,
      );
      return previous;
    }
    const adapter = this.adapter(route);
    invariant(
      adapter.capabilities.kinds.includes(input.kind) &&
        adapter.capabilities.operations.includes(request.operation),
      "Media operation not supported by adapter",
    );
    const job: Job = {
      routeVersion: hash(JSON.stringify(route)),
      id: id("job"),
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId,
      kind: input.kind,
      routeId,
      prompt: input.prompt,
      request,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.transaction(() => {
      job.costEntryId = this.costs?.reserveMedia(
        routeId,
        route,
        {
          projectId: input.projectId,
          sessionId: input.sessionId,
          runId: input.runId,
          purpose: input.kind,
        },
        requestUnits(request),
      ).id;
      this.store.put("media-route-versions", { id: job.routeVersion!, route });
      this.store.put("jobs", job);
    });
    this.launch(job, route, false);
    return job;
  }
  private adapter(route: Route): MediaAdapter {
    if (route.mediaAdapterId && route.adapter !== "custom-media")
      return this.adapters.get(route.mediaAdapterId);
    if (route.adapter !== "custom-media")
      return this.adapters.get(route.adapter);
    invariant(
      this.plugins && route.mediaAdapterId,
      "Custom media adapter needs an enabled plugin and mediaAdapterId",
    );
    const plugins = this.plugins,
      adapterId = route.mediaAdapterId;
    const definition = plugins.mediaDefinition(adapterId);
    const invoke = async (
      method: string,
      request: unknown,
      ctx: MediaAdapterContext,
    ) =>
      plugins.media(
        adapterId,
        method,
        request,
        {
          baseUrl: ctx.route.baseUrl,
          model: ctx.route.model,
          idempotencyKey: ctx.idempotencyKey,
          parameters: ctx.route.requestDefaults,
          inputs:
            method === "submit"
              ? await Promise.all(
                  ((request as MediaRequest).inputAssets || []).map(
                    async (assetId) => ({
                      assetId,
                      ...(await ctx.input(assetId)),
                    }),
                  ),
                )
              : [],
        },
        ctx.signal,
      );
    return {
      id: adapterId,
      capabilities: definition,
      submit: (request, ctx) => invoke("submit", request, ctx),
      poll: definition.polling
        ? (remoteId, state, ctx) => invoke("poll", { remoteId, state }, ctx)
        : undefined,
      cancel: definition.cancellation
        ? (remoteId, state, ctx) => invoke("cancel", { remoteId, state }, ctx)
        : undefined,
      recover: definition.recovery
        ? (remoteId, state, ctx) => invoke("recover", { remoteId, state }, ctx)
        : undefined,
    };
  }
  private context(
    job: Job,
    route: Route,
    signal: AbortSignal,
  ): MediaAdapterContext {
    return {
      route,
      signal,
      idempotencyKey: job.idempotencyKey,
      input: async (assetId) => {
        const a = this.assets.owned(assetId, job.projectId);
        return {
          name: a.name,
          mime: a.mime,
          base64: (await this.assets.read(assetId, job.projectId)).toString(
            "base64",
          ),
        };
      },
      request: async (pathname, body, method) => {
        invariant(
          !pathname.includes("://") && !pathname.startsWith("//"),
          "Media path must be relative",
        );
        const headers = routeHeaders(route);
        headers["Idempotency-Key"] = job.idempotencyKey;
        const response = await fetch(
          route.baseUrl.replace(/\/$/, "") +
            (pathname ? "/" + pathname.replace(/^\//, "") : ""),
          {
            method: method || (body === undefined ? "GET" : "POST"),
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(route.timeoutMs),
            ]),
            redirect: "error",
          },
        );
        invariant(response.ok, `Media provider HTTP ${response.status}`, 502);
        return readJson(response, this.config.limits.maxUploadBytes * 2);
      },
    };
  }
  private update(job: Job, change: Partial<Job>) {
    const next = this.store.put("jobs", {
      ...job,
      ...change,
      updatedAt: now(),
    });
    if (job.runId)
      this.store.emit(
        job.runId,
        ["completed", "failed", "unknown", "cancelled"].includes(next.status)
          ? "job.settled"
          : "job.progress",
        { job: next },
      );
    return next;
  }
  private launch(job: Job, route: Route, recovering: boolean) {
    const controller = new AbortController();
    const done = this.execute(
      job,
      route,
      AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(route.timeoutMs),
      ]),
      recovering,
    ).finally(() => this.running.delete(job.id));
    this.running.set(job.id, { controller, done });
  }
  private async execute(
    initial: Job,
    route: Route,
    signal: AbortSignal,
    recovering: boolean,
  ) {
    let job = this.update(initial, { status: "running" }),
      submitted = recovering;
    try {
      const adapter = this.adapter(route),
        context = this.context(job, route, signal);
      let result: AdapterResult;
      if (recovering) {
        invariant(
          job.remoteId && adapter.recover,
          "Adapter cannot recover without remote job ID",
        );
        result = await abortable(
          adapter.recover(job.remoteId, job.adapterState, context),
          signal,
        );
      } else {
        if (job.costEntryId && this.costs)
          await this.costs.authorize(job.costEntryId, signal);
        submitted = true;
        result = await abortable(adapter.submit(job.request!, context), signal);
      }
      const deadline = Date.now() + route.timeoutMs;
      while (true) {
        if (job.costEntryId && result.billing)
          this.costs?.settleMedia(
            job.costEntryId,
            result.billing.actualUsd,
            result.billing.reference,
            reportedUnits(result.billing.units, job.kind),
          );
        invariant(
          ["queued", "running", "completed", "failed", "cancelled"].includes(
            result.status,
          ),
          "Adapter returned invalid status",
          502,
        );
        job = this.update(job, {
          remoteId: result.remoteId || job.remoteId,
          progress: result.progress,
          adapterState: result.state || job.adapterState,
        });
        if (["completed", "failed", "cancelled"].includes(result.status)) break;
        invariant(
          job.remoteId && adapter.poll,
          "Asynchronous adapter requires remoteId and poll()",
        );
        invariant(
          Date.now() < deadline,
          "Media polling deadline exceeded; remote effect may still be running",
          504,
        );
        await delay(route.pollIntervalMs, signal);
        result = await abortable(
          adapter.poll(job.remoteId, job.adapterState, context),
          signal,
        );
      }
      if (result.status !== "completed") {
        this.update(job, {
          status: result.status as "failed" | "cancelled",
          error: result.error,
        });
        return;
      }
      invariant(
        result.outputs?.length &&
          result.outputs.length <= 16 &&
          result.outputs.some((output) => output?.type === job.kind),
        "Completed media job has no outputs",
        502,
      );
      const outputs: MediaOutput[] = [],
        assetIds: string[] = [];
      let outputBytes = 0;
      for (const [index, output] of result.outputs.entries()) {
        signal.throwIfAborted();
        invariant(
          output &&
            typeof output === "object" &&
            ["image", "video", "text"].includes(output.type),
          "Invalid media output type",
          502,
        );
        if (output.type === "text")
          invariant(
            typeof output.text === "string" && output.text.trim(),
            "Empty media text output",
            502,
          );
        else
          invariant(
            output.base64 || output.url || output.assetId,
            "Media output has no actual bytes, URL, or owned asset",
            502,
          );
        const normalized = { ...output };
        let bytes: Buffer | undefined;
        if (output.assetId) {
          const owned = this.assets.owned(output.assetId, job.projectId);
          invariant(
            owned.mime.startsWith(output.type + "/"),
            "Media asset MIME does not match its output type",
            502,
          );
          await this.assets.read(owned.id, job.projectId, signal);
          outputBytes += owned.size;
          assetIds.push(owned.id);
        }
        if (output.base64) {
          invariant(
            typeof output.base64 === "string" &&
              output.base64.length <=
                Math.ceil(this.config.limits.maxUploadBytes / 3) * 4,
            "Media base64 is invalid or too large",
            502,
          );
          bytes = Buffer.from(output.base64, "base64");
          invariant(
            bytes.toString("base64") === output.base64,
            "Media base64 is not canonical",
            502,
          );
        } else if (
          output.url &&
          route.allowedOutputHosts.includes(new URL(output.url).host)
        ) {
          const url = new URL(output.url);
          invariant(
            ["http:", "https:"].includes(url.protocol),
            "Invalid media output URL",
          );
          const response = await fetch(url, {
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(route.timeoutMs),
            ]),
            redirect: "error",
          });
          invariant(response.ok, `Media download HTTP ${response.status}`);
          bytes = await readBounded(
            response,
            this.config.limits.maxUploadBytes,
          );
        }
        if (bytes) {
          outputBytes += bytes.length;
          invariant(
            outputBytes <= this.config.limits.maxUploadBytes,
            "Combined media outputs exceed the byte budget",
            502,
          );
          invariant(
            bytes.length > 0 &&
              bytes.length <= this.config.limits.maxUploadBytes,
            "Media output is empty or too large",
          );
          const mime = output.mime || sniff(bytes),
            ext =
              (
                {
                  "image/png": "png",
                  "image/jpeg": "jpg",
                  "image/webp": "webp",
                  "video/mp4": "mp4",
                  "video/webm": "webm",
                } as Record<string, string>
              )[mime] || "bin";
          const asset = await this.assets.create(
            job.projectId,
            `generated-${index}.${ext}`,
            bytes,
            "model",
            mime,
          );
          normalized.assetId = asset.id;
          delete normalized.base64;
          assetIds.push(asset.id);
          if (job.runId)
            this.store.emit(job.runId, "artifact.created", {
              asset,
              download: `/v1/assets/${asset.id}/content`,
            });
        }
        if (normalized.url)
          invariant(
            ["http:", "https:"].includes(new URL(normalized.url).protocol),
            "Invalid media reference URL",
          );
        invariant(
          outputBytes <= this.config.limits.maxUploadBytes,
          "Combined media outputs exceed the byte budget",
          502,
        );
        outputs.push(normalized);
      }
      this.update(job, {
        status: "completed",
        outputs,
        output: { assetIds, outputs },
        progress: 1,
      });
    } catch (error) {
      this.update(job, {
        status: submitted ? "unknown" : signal.aborted ? "cancelled" : "failed",
        error: errorText(error),
      });
    } finally {
      if (job.costEntryId) this.costs?.unknown(job.costEntryId);
    }
  }
  async cancel(jobId: string) {
    this.running.get(jobId)?.controller.abort();
    await this.running.get(jobId)?.done;
    const job = this.store.job(jobId);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    const route = this.jobRoute(job),
      adapter = this.adapter(route);
    if (job.remoteId && adapter.cancel && adapter.capabilities.cancellation) {
      try {
        const context = this.context(
          job,
          route,
          AbortSignal.timeout(route.timeoutMs),
        );
        const response = await abortable(
          adapter.cancel(job.remoteId, job.adapterState, context),
          context.signal,
        );
        if (job.costEntryId && response.billing)
          this.costs?.settleMedia(
            job.costEntryId,
            response.billing.actualUsd,
            response.billing.reference,
            reportedUnits(response.billing.units, job.kind),
          );
        return this.update(job, {
          status: response.status === "cancelled" ? "cancelled" : "unknown",
          error: response.error,
        });
      } catch (error) {
        return this.update(job, { status: "unknown", error: errorText(error) });
      }
    }
    return this.store.job(jobId);
  }
  recover(jobId: string) {
    const job = this.store.job(jobId);
    invariant(
      job.status === "unknown" && job.remoteId,
      "Only unknown jobs with remote IDs can recover",
      409,
    );
    invariant(!this.running.has(jobId), "Job already running", 409);
    this.launch(job, this.jobRoute(job), true);
    return job;
  }
  private jobRoute(job: Job): Route {
    const route = job.routeVersion
      ? this.store.find<{ id: string; route: Route }>(
          "media-route-versions",
          job.routeVersion,
        )?.route
      : this.config.routes[job.routeId];
    invariant(
      route,
      "Original media route is unavailable; do not resubmit the operation",
      409,
    );
    if (job.routeVersion)
      invariant(
        hash(JSON.stringify(route)) === job.routeVersion,
        "Media route snapshot integrity check failed",
        409,
      );
    return route;
  }
  async wait(jobId: string, signal?: AbortSignal) {
    try {
      while (["queued", "running"].includes(this.store.job(jobId).status)) {
        signal?.throwIfAborted();
        await delay(25, signal);
      }
    } catch (error) {
      if (signal?.aborted) void this.cancel(jobId);
      throw error;
    }
    return this.store.job(jobId);
  }
  async close() {
    const running = [...this.running.values()];
    for (const item of running) item.controller.abort();
    await Promise.all(running.map((r) => r.done));
  }
}
function sniff(bytes: Buffer) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216) return "image/jpeg";
  if (bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return "video/webm";
  return "application/octet-stream";
}
export async function readBounded(response: Response, max: number) {
  invariant(
    Number(response.headers.get("content-length") || 0) <= max,
    "Response too large",
    413,
  );
  invariant(response.body, "Response body missing", 502);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      invariant(size <= max, "Response too large", 413);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

const reportedUnits = (units: unknown, kind: "image" | "video") =>
  units === undefined ? undefined : checkUnits(units, kind);
