import type { ToolDefinition } from "./types.js";
import { invariant } from "../core/util.js";

type Lock = { key: string; access: "read" | "write" };
type Waiter = {
  locks: Lock[];
  signal?: AbortSignal;
  abort: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
};
/** Count declarations, including duplicate keys, so each acquisition releases only its locks. */
class LockIndex {
  private readers = new Map<string, number>();
  private writers = new Map<string, number>();
  private readCount = 0;
  private writeCount = 0;

  conflicts(locks: readonly Lock[]): boolean {
    return locks.some(({ key, access }) => {
      if (key === "*")
        return (
          this.writeCount > 0 || (access === "write" && this.readCount > 0)
        );
      return (
        this.writers.has("*") ||
        this.writers.has(key) ||
        (access === "write" && (this.readers.has("*") || this.readers.has(key)))
      );
    });
  }

  update(locks: readonly Lock[], change: 1 | -1): void {
    for (const { key, access } of locks) {
      const counts = access === "read" ? this.readers : this.writers;
      const count = (counts.get(key) ?? 0) + change;
      if (count) counts.set(key, count);
      else counts.delete(key);
      if (access === "read") this.readCount += change;
      else this.writeCount += change;
    }
  }
}
/** One instance per kernel: bounds execution and arbitrates conflicts across runs. */
export class ToolScheduler {
  private active = new LockIndex();
  private activeCount = 0;
  private queue = new Set<Waiter>();
  constructor(readonly limit = 4) {
    invariant(
      Number.isInteger(limit) && limit >= 1 && limit <= 64,
      "Invalid tool concurrency",
    );
  }
  acquire(
    tool: ToolDefinition | undefined,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<() => void> {
    signal?.throwIfAborted();
    const declarations: Lock[] = tool?.scheduling?.parallelSafe
      ? tool.scheduling.resources?.(args) || []
      : [{ key: "*", access: "write" }];
    invariant(
      declarations.length <= 100 &&
        declarations.every(
          (l) =>
            typeof l.key === "string" &&
            l.key.length > 0 &&
            l.key.length <= 4000 &&
            ["read", "write"].includes(l.access),
        ),
      "Invalid tool locks",
    );
    // A tool may reuse or mutate its declaration array after returning it.
    const locks = declarations.map(({ key, access }) => ({ key, access }));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        locks,
        signal,
        resolve,
        reject,
        abort: () => {
          this.queue.delete(waiter);
          reject(signal?.reason || new Error("Cancelled"));
          this.drain();
        },
      };
      this.queue.add(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.drain();
    });
  }
  private drain() {
    const blocked = new LockIndex();
    for (const w of this.queue) {
      if (this.activeCount >= this.limit) break;
      if (this.active.conflicts(w.locks) || blocked.conflicts(w.locks)) {
        blocked.update(w.locks, 1);
        continue;
      }
      this.queue.delete(w);
      w.signal?.removeEventListener("abort", w.abort);
      this.active.update(w.locks, 1);
      this.activeCount++;
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        this.active.update(w.locks, -1);
        this.activeCount--;
        this.drain();
      });
    }
  }
  get state() {
    return {
      active: this.activeCount,
      queued: this.queue.size,
      limit: this.limit,
    };
  }
}
