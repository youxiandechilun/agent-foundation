/** FIFO per resource; unrelated resources run independently and failures never poison a lane. */
export class KeyedQueue<K> {
  private readonly pending = new Map<K, Promise<unknown>>();

  has(key: K): boolean {
    return this.pending.has(key);
  }

  values(): IterableIterator<Promise<unknown>> {
    return this.pending.values();
  }

  run<T>(key: K, operation: () => T | Promise<T>): Promise<T> {
    const next = (this.pending.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.pending.set(key, next);
    const release = () => {
      if (this.pending.get(key) === next) this.pending.delete(key);
    };
    void next.then(release, release);
    return next;
  }
}
