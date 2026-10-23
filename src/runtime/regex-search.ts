import { Worker } from "node:worker_threads";
import { AppError, invariant } from "../core/util.js";

/** One worker per search. A regexp cannot block the host's cancellation or timers. */
export class RegexSearch {
  private readonly worker: Worker;
  private pending?: {
    resolve: (matches: number[]) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private stopped?: Error;
  private termination?: Promise<number>;
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly abort = () =>
    this.stop(this.signal?.reason ?? new Error("Search cancelled"));

  constructor(
    pattern: string,
    ignoreCase = false,
    private readonly signal?: AbortSignal,
    private readonly matchTimeoutMs = 1000,
    totalTimeoutMs = 30000,
  ) {
    signal?.throwIfAborted();
    this.worker = new Worker(new URL("./regex-worker.js", import.meta.url), {
      workerData: { pattern, ignoreCase },
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
      },
    });
    this.worker.on("message", (matches: number[]) => {
      const pending = this.pending;
      if (!pending) return;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(matches);
    });
    this.worker.on("error", (error) => this.stop(error));
    this.worker.on("exit", () => {
      if (!this.stopped)
        this.stop(new Error("Search worker stopped unexpectedly"));
    });
    this.deadline = setTimeout(
      () =>
        this.stop(
          new AppError(408, "search_timeout", "Regex search timed out"),
        ),
      totalTimeoutMs,
    ).unref();
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  /** Also call with an empty list before traversal to validate the pattern. */
  async match(lines: string[], limit = 200): Promise<number[]> {
    this.signal?.throwIfAborted();
    if (this.stopped) throw this.stopped;
    invariant(!this.pending, "Regex search already has a pending batch");
    return new Promise<number[]>((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        timer: setTimeout(
          () =>
            this.stop(
              new AppError(408, "search_timeout", "Regex matching timed out"),
            ),
          this.matchTimeoutMs,
        ).unref(),
      };
      try {
        this.worker.postMessage({ lines, limit });
      } catch (error) {
        this.stop(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private stop(error: Error) {
    if (this.stopped) return;
    this.stopped = error;
    clearTimeout(this.deadline);
    this.signal?.removeEventListener("abort", this.abort);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    this.termination = this.worker.terminate();
    void this.termination.catch(() => undefined);
  }

  async close() {
    this.stop(new Error("Regex search closed"));
    await this.termination;
  }
}
