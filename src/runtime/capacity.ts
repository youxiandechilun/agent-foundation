import { invariant } from "../core/util.js";

/** Synchronous admission before async work; reservations always have one owner. */
export class Capacity {
  private count = 0;
  private bytes = 0;
  constructor(
    readonly maxCount: number,
    readonly maxBytes = Infinity,
  ) {}
  reserve(bytes = 0): () => void {
    invariant(
      Number.isSafeInteger(bytes) && bytes >= 0,
      "Invalid capacity reservation",
    );
    invariant(
      this.count < this.maxCount && this.bytes + bytes <= this.maxBytes,
      "Resource capacity reached",
      429,
      "resource_capacity",
    );
    this.count++;
    this.bytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count--;
      this.bytes -= bytes;
    };
  }
}
