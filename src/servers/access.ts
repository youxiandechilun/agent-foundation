import type { Store } from "../storage/store.js";
import { invariant } from "../core/util.js";
import { KeyedQueue } from "../runtime/keyed-queue.js";

interface Lease {
  controller: AbortController;
  done: Promise<void>;
  release: () => void;
}
/** Shared by managers on one Store: changing trust or credentials cancels and drains existing operations. */
class ServerAccess {
  private active = new Map<string, Set<Lease>>();
  private changing = new Set<string>();
  private mutations = new KeyedQueue<string>();
  acquire(serverId: string): Lease {
    invariant(
      !this.changing.has(serverId),
      "Server configuration is changing; try again after the update",
      409,
      "server_changing",
    );
    const controller = new AbortController();
    let complete: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const entries = this.active.get(serverId) ?? new Set<Lease>();
    const lease: Lease = {
      controller,
      done,
      release: () => {
        entries.delete(lease);
        if (!entries.size) this.active.delete(serverId);
        complete();
      },
    };
    entries.add(lease);
    this.active.set(serverId, entries);
    return lease;
  }
  change<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    return this.mutations.run(serverId, async () => {
      this.changing.add(serverId);
      try {
        const leases = [...(this.active.get(serverId) ?? [])];
        for (const lease of leases)
          lease.controller.abort(
            new Error("Server trust, scope or credentials changed"),
          );
        await Promise.all(leases.map((lease) => lease.done));
        return await operation();
      } finally {
        this.changing.delete(serverId);
      }
    });
  }
}
const coordinators = new WeakMap<Store, ServerAccess>();
export function serverAccess(store: Store): ServerAccess {
  let coordinator = coordinators.get(store);
  if (!coordinator) {
    coordinator = new ServerAccess();
    coordinators.set(store, coordinator);
  }
  return coordinator;
}
