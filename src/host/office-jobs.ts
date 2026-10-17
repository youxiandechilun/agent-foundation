import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { invariant } from "../util.js";
export class OfficeJobs {
  private active = new Set<Worker>();
  private closed = false;
  constructor(private config: Config) {}
  async execute<T = any>(
    operation: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    invariant(!this.closed, "Office plugin is closed", 503);
    signal?.throwIfAborted();
    invariant(
      this.active.size < this.config.office.maxConcurrentJobs,
      "Office processing capacity reached",
      429,
    );
    return new Promise<T>((resolve, reject) => {
      const worker = new Worker(
        new URL("./office-format-worker.cjs", import.meta.url),
        {
          env: {
            ...(process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
          },
          workerData: {
            operation,
            args,
            limits: this.config.office,
            requireFrom: fileURLToPath(
              new URL("../../package.json", import.meta.url),
            ),
          },
          resourceLimits: {
            maxOldGenerationSizeMb: this.config.office.maxHeapMb,
            stackSizeMb: 4,
          },
        },
      );
      this.active.add(worker);
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        void worker.terminate().then(
          () => {
            this.active.delete(worker);
            error ? reject(error) : resolve(value!);
          },
          (terminationError) => {
            this.active.delete(worker);
            reject(error || terminationError);
          },
        );
      };
      const abort = () => finish(new Error("Office operation cancelled"));
      const timer = setTimeout(
        () => finish(new Error("Office processing timed out")),
        this.config.office.timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      worker.once("message", (message) =>
        message.error
          ? finish(new Error(message.error))
          : finish(undefined, message.result),
      );
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        if (!settled)
          finish(
            new Error(
              "Office worker exited before returning a result (" + code + ")",
            ),
          );
      });
    });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(
      [...this.active].map((worker) => worker.terminate()),
    );
    this.active.clear();
  }
}
