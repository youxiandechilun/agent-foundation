import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Config } from "../../core/config.js";
import { invariant } from "../../core/util.js";
import {
  officeWorkerMessageSchema,
  parseOfficeResult,
  type OfficeJobResults,
  type OfficeOperation,
} from "./worker-results.js";
export class OfficeJobs {
  private active = new Set<Worker>();
  private closed = false;
  constructor(private config: Config) {}
  async execute<Operation extends OfficeOperation>(
    operation: Operation,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OfficeJobResults[Operation]> {
    invariant(!this.closed, "Office plugin is closed", 503);
    signal?.throwIfAborted();
    invariant(
      this.active.size < this.config.office.maxConcurrentJobs,
      "Office processing capacity reached",
      429,
    );
    return new Promise<OfficeJobResults[Operation]>((resolve, reject) => {
      const worker = new Worker(
        new URL("./format-worker.cjs", import.meta.url),
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
              new URL("../../../package.json", import.meta.url),
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
      const finish = (error?: Error, value?: OfficeJobResults[Operation]) => {
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
      worker.once("message", (value: unknown) => {
        try {
          const message = officeWorkerMessageSchema.parse(value);
          if ("error" in message) finish(new Error(message.error));
          else finish(undefined, parseOfficeResult(operation, message.result));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
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
