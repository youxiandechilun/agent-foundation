import type { Config, Route } from "../core/config.js";
import type { Asset, Job, MediaRequest, MediaOutput } from "../contracts.js";
import { Store } from "../storage/store.js";
import { Assets } from "../storage/assets.js";
import { PluginManager } from "../extensions/plugins/manager.js";
import {
  MediaAdapterRegistry,
  imageJsonAdapter,
  videoJobAdapter,
  mappedHttpAdapter,
  parseAdapterResult,
  type MediaAdapter,
  type AdapterResult,
  type MediaAdapterContext,
} from "./adapters.js";
import { routeHeaders } from "../providers/text.js";
import { checkUnits, requestUnits } from "../runtime/billing.js";
import { readJson } from "../providers/sse.js";
import type { CostLedger } from "../runtime/cost.js";
import { Capacity } from "../runtime/capacity.js";
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
interface PendingMedia {
  job: Job;
  route: Route;
  recovering: boolean;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  release: () => void;
  started: boolean;
  calls: Set<Promise<unknown>>;
}
export class Media {
  readonly adapters = new MediaAdapterRegistry();
  private running = new Map<string, PendingMedia>();
  private readonly admission: Capacity;
  private readonly cancellationAdmission: Capacity;
  private readonly cancellations = new Map<string, Promise<Job>>();
  private readonly queue: PendingMedia[] = [];
  private active = 0;
  private closed = false;
  private readonly lifetime = new AbortController();
  private closeCompletion?: Promise<void>;
  constructor(
    readonly store: Store,
    readonly assets: Assets,
    readonly config: Config,
    readonly plugins?: PluginManager,
    readonly costs?: CostLedger,
  ) {
    this.admission = new Capacity(
      config.limits.maxConcurrentMediaJobs + config.limits.maxQueuedMediaJobs,
      config.limits.maxMediaQueueBytes,
    );
    this.cancellationAdmission = new Capacity(
      config.limits.maxConcurrentMediaJobs,
    );
    [imageJsonAdapter, videoJobAdapter, mappedHttpAdapter].forEach((adapter) =>
      this.adapters.register(adapter),
    );
  }
  create(input: MediaInput) {
    invariant(!this.closed, "Media service is closed", 503);
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
    const request: MediaRequest = structuredClone({
      schemaVersion: 1,
      kind: input.kind,
      operation: input.request?.operation || "generate",
      prompt: input.prompt,
      inputAssets: input.request?.inputAssets || [],
      parameters: input.request?.parameters || {},
    });
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
    const previous = this.store.findMediaJob(
      input.projectId,
      input.idempotencyKey,
      requestHash,
    );
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
    const release = this.admission.reserve(
      Buffer.byteLength(JSON.stringify({ job, route })),
    );
    try {
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
        this.store.put("media-route-versions", {
          id: job.routeVersion!,
          route,
        });
        this.store.put("jobs", job);
      });
      this.launch(job, route, false, release);
    } catch (error) {
      release();
      throw error;
    }
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
      parseAdapterResult(
        await plugins.media(
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
        ),
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
          base64: (
            await this.assets.read(assetId, job.projectId, signal)
          ).toString("base64"),
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
  private launch(
    job: Job,
    route: Route,
    recovering: boolean,
    release: () => void,
  ) {
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = {
      job,
      route,
      recovering,
      controller,
      done,
      finish,
      release,
      started: false,
      calls: new Set<Promise<unknown>>(),
    };
    this.running.set(job.id, pending);
    this.queue.push(pending);
    this.pump();
  }
  private pump() {
    while (
      !this.closed &&
      this.active < this.config.limits.maxConcurrentMediaJobs &&
      this.queue.length
    ) {
      const pending = this.queue.shift()!;
      pending.started = true;
      this.active++;
      void this.execute(
        pending.job,
        pending.route,
        AbortSignal.any([
          pending.controller.signal,
          AbortSignal.timeout(pending.route.timeoutMs),
        ]),
        pending.recovering,
        pending.calls,
      )
        .catch(() => undefined)
        .finally(() => {
          pending.finish();
          const release = () => {
            this.active--;
            this.running.delete(pending.job.id);
            pending.release();
            this.pump();
          };
          // A trusted adapter can ignore cancellation. Keep its occupied slot
          // until the actual callback settles, without blocking kernel shutdown.
          if (pending.calls.size)
            void Promise.allSettled([...pending.calls]).then(release);
          else release();
        });
    }
  }
  private cancelPending(pending: PendingMedia) {
    pending.controller.abort();
    if (pending.started) return;
    const index = this.queue.indexOf(pending);
    if (index >= 0) this.queue.splice(index, 1);
    try {
      // A recovery refers to an existing remote operation; cancelling its local
      // queue does not establish that the remote effect has been cancelled.
      this.update(pending.job, {
        status: pending.recovering ? "unknown" : "cancelled",
      });
      if (pending.job.costEntryId && !pending.recovering)
        this.costs?.voidUnsubmitted(
          pending.job.costEntryId,
          "Cancelled before media submission",
        );
    } finally {
      this.running.delete(pending.job.id);
      pending.release();
      pending.finish();
    }
  }
  private async execute(
    initial: Job,
    route: Route,
    signal: AbortSignal,
    recovering: boolean,
    calls: Set<Promise<unknown>>,
  ) {
    let job = this.update(initial, { status: "running" }),
      submitted = recovering;
    try {
      const adapter = this.adapter(route),
        context = this.context(job, route, signal);
      const invoke = <T>(work: Promise<T>) => {
        calls.add(work);
        void work.then(
          () => calls.delete(work),
          () => calls.delete(work),
        );
        return abortable(work, signal);
      };
      let result: AdapterResult;
      if (recovering) {
        invariant(
          job.remoteId && adapter.recover,
          "Adapter cannot recover without remote job ID",
        );
        result = await invoke(
          adapter.recover(job.remoteId, job.adapterState, context),
        );
      } else {
        if (job.costEntryId && this.costs)
          await invoke(this.costs.authorize(job.costEntryId, signal));
        submitted = true;
        signal.throwIfAborted();
        result = await invoke(adapter.submit(job.request!, context));
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
        result = await invoke(
          adapter.poll(job.remoteId, job.adapterState, context),
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
        let produced: Asset | undefined;
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
          produced = await this.downloadOutput(
            job,
            url,
            output.mime,
            index,
            this.config.limits.maxUploadBytes - outputBytes,
            signal,
          );
          outputBytes += produced.size;
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
          produced = await this.assets.create(
            job.projectId,
            `generated-${index}.${ext}`,
            bytes,
            "model",
            mime,
            signal,
          );
        }
        if (produced) {
          normalized.assetId = produced.id;
          delete normalized.base64;
          assetIds.push(produced.id);
          if (job.runId)
            this.store.emit(job.runId, "artifact.created", {
              asset: produced,
              download: `/v1/assets/${produced.id}/content`,
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
  private async downloadOutput(
    job: Job,
    url: URL,
    mime: string | undefined,
    index: number,
    remaining: number,
    signal: AbortSignal,
  ): Promise<Asset> {
    const response = await fetch(url, { signal, redirect: "error" });
    try {
      invariant(response.ok, `Media download HTTP ${response.status}`);
      invariant(response.body, "Media download body missing", 502);
      const header = response.headers.get("content-length"),
        expected = header === null ? undefined : Number(header);
      invariant(
        expected === undefined ||
          (Number.isSafeInteger(expected) &&
            expected > 0 &&
            expected <= remaining),
        "Combined media outputs exceed the byte budget",
        413,
      );
      const reader = response.body.getReader();
      try {
        const parts: Buffer[] = [];
        let size = 0;
        while (size < 12) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          invariant(
            size <= remaining,
            "Combined media outputs exceed the byte budget",
            413,
          );
          parts.push(Buffer.from(next.value));
        }
        invariant(size > 0, "Media output is empty", 502);
        const head = Buffer.concat(parts),
          actualMime = mime || sniff(head);
        async function* chunks() {
          yield head;
          while (true) {
            const next = await reader.read();
            if (next.done) return;
            size += next.value.byteLength;
            invariant(
              size <= remaining,
              "Combined media outputs exceed the byte budget",
              413,
            );
            yield next.value;
          }
        }
        const extension =
          (
            {
              "image/png": "png",
              "image/jpeg": "jpg",
              "image/webp": "webp",
              "video/mp4": "mp4",
              "video/webm": "webm",
            } as Record<string, string>
          )[actualMime] || "bin";
        return await this.assets.createStream(
          job.projectId,
          `generated-${index}.${extension}`,
          chunks(),
          "model",
          actualMime,
          signal,
          expected,
        );
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } finally {
      if (!response.body?.locked)
        await response.body?.cancel().catch(() => undefined);
    }
  }
  cancel(jobId: string): Promise<Job> {
    invariant(!this.closed, "Media service is closed", 503);
    const current = this.cancellations.get(jobId);
    if (current) return current;
    const release = this.cancellationAdmission.reserve();
    const calls = new Set<Promise<unknown>>();
    const done = this.cancelJob(jobId, calls).finally(() => {
      const finish = () => {
        release();
        this.cancellations.delete(jobId);
      };
      if (calls.size) void Promise.allSettled([...calls]).then(finish);
      else finish();
    });
    this.cancellations.set(jobId, done);
    return done;
  }
  private async cancelJob(jobId: string, calls: Set<Promise<unknown>>) {
    const pending = this.running.get(jobId);
    if (pending) {
      this.cancelPending(pending);
      await pending.done;
    }
    const job = this.store.job(jobId);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    const route = this.jobRoute(job),
      adapter = this.adapter(route);
    if (job.remoteId && adapter.cancel && adapter.capabilities.cancellation) {
      try {
        const context = this.context(
          job,
          route,
          AbortSignal.any([
            this.lifetime.signal,
            AbortSignal.timeout(route.timeoutMs),
          ]),
        );
        const work = adapter.cancel(job.remoteId, job.adapterState, context);
        calls.add(work);
        void work.then(
          () => calls.delete(work),
          () => calls.delete(work),
        );
        const response = await abortable(work, context.signal);
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
    invariant(!this.closed, "Media service is closed", 503);
    const job = this.store.job(jobId);
    invariant(
      job.status === "unknown" && job.remoteId,
      "Only unknown jobs with remote IDs can recover",
      409,
    );
    invariant(!this.running.has(jobId), "Job already running", 409);
    invariant(
      !this.cancellations.has(jobId),
      "Job cancellation is still pending",
      409,
    );
    const route = this.jobRoute(job);
    const release = this.admission.reserve(
      Buffer.byteLength(JSON.stringify({ job, route })),
    );
    try {
      const queued = this.update(job, { status: "queued" });
      this.launch(queued, route, true, release);
    } catch (error) {
      release();
      throw error;
    }
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
      if (signal?.aborted && !this.closed)
        void this.cancel(jobId).catch(() => undefined);
      throw error;
    }
    return this.store.job(jobId);
  }
  close() {
    return (this.closeCompletion ??= this.closeOnce());
  }
  private async closeOnce() {
    this.closed = true;
    this.lifetime.abort(new Error("Media service is closing"));
    const running = [...this.running.values()];
    for (const item of running) this.cancelPending(item);
    await Promise.allSettled([
      ...running.map((r) => r.done),
      ...this.cancellations.values(),
    ]);
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
