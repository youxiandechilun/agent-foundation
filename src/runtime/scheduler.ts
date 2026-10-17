import type { ToolDefinition } from "./types.js";
import { invariant } from "../util.js";

type Lock = { key: string; access: "read" | "write" };
type Waiter = {
  locks: Lock[];
  signal?: AbortSignal;
  abort: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
};
/** One instance per kernel: bounds execution and arbitrates conflicts across runs. */
export class ToolScheduler {
  private active = new Set<Lock[]>();
  private queue: Waiter[] = [];
  constructor(readonly limit = 4) {
    invariant(
      Number.isInteger(limit) && limit >= 1 && limit <= 64,
      "Invalid tool concurrency",
    );
  }
  private conflicts(a: Lock[], b: Lock[]) {
    return a.some((x) =>
      b.some(
        (y) =>
          (x.key === "*" || y.key === "*" || x.key === y.key) &&
          (x.access === "write" || y.access === "write"),
      ),
    );
  }
  acquire(
    tool: ToolDefinition | undefined,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<() => void> {
    signal?.throwIfAborted();
    const locks: Lock[] = tool?.scheduling?.parallelSafe
      ? tool.scheduling.resources?.(args) || []
      : [{ key: "*", access: "write" }];
    invariant(
      locks.length <= 100 &&
        locks.every(
          (l) =>
            typeof l.key === "string" &&
            l.key.length > 0 &&
            l.key.length <= 4000 &&
            ["read", "write"].includes(l.access),
        ),
      "Invalid tool locks",
    );
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        locks,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal?.reason || new Error("Cancelled"));
          this.drain();
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.drain();
    });
  }
  private drain() {
    for (let i = 0; i < this.queue.length && this.active.size < this.limit;) {
      const w = this.queue[i];
      if (
        [...this.active].some((a) => this.conflicts(a, w.locks)) ||
        this.queue.slice(0, i).some((a) => this.conflicts(a.locks, w.locks))
      ) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      w.signal?.removeEventListener("abort", w.abort);
      this.active.add(w.locks);
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        this.active.delete(w.locks);
        this.drain();
      });
    }
  }
  get state() {
    return {
      active: this.active.size,
      queued: this.queue.length,
      limit: this.limit,
    };
  }
}
