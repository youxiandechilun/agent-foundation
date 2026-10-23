import { invariant } from "../core/util.js";

/** FIFO per resource; unrelated resources run independently and failures never poison a lane. */
export class KeyedQueue<K> {
  private readonly pending = new Map<K, Promise<unknown>>();
  private readonly capacity = new Map<K, { count: number; bytes: number }>();

  has(key: K): boolean {
    return this.pending.has(key);
  }

  values(): IterableIterator<Promise<unknown>> {
    return this.pending.values();
  }

  run<T>(
    key: K,
    operation: () => T | Promise<T>,
    limit?: { count: number; bytes: number; size: number },
  ): Promise<T> {
    const capacity = this.capacity.get(key) ?? { count: 0, bytes: 0 };
    if (limit) {
      try {
        invariant(
          capacity.count < limit.count &&
            capacity.bytes + limit.size <= limit.bytes,
          "Pending input capacity reached",
          429,
          "input_capacity",
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }
    capacity.count++;
    capacity.bytes += limit?.size ?? 0;
    this.capacity.set(key, capacity);
    const next = (this.pending.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.pending.set(key, next);
    const release = () => {
      capacity.count--;
      capacity.bytes -= limit?.size ?? 0;
      if (!capacity.count) this.capacity.delete(key);
      if (this.pending.get(key) === next) this.pending.delete(key);
    };
    void next.then(release, release);
    return next;
  }
}
