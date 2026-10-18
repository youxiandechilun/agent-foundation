import type { ExecutionEngine } from "../../runtime/engine.js";
import { KeyedQueue } from "../../runtime/keyed-queue.js";

export interface LiveRun {
  controller: AbortController;
  runId: string;
  engine?: ExecutionEngine;
  done: Promise<void>;
  cancelled: boolean;
}

interface InputPreparation {
  controller: AbortController;
}

interface ProcessControl {
  controller: AbortController;
  done: Promise<void>;
}

/** Owns admission, per-session input ordering and cancellation of in-flight work. */
export class RunLifecycle {
  private readonly slots = new Map<string, LiveRun | InputPreparation>();
  private readonly lanes = new KeyedQueue<string>();
  private readonly preparations = new Map<string, InputPreparation>();
  private readonly controls = new Map<string, ProcessControl>();
  closing = false;

  get occupiedRunCount(): number {
    return this.slots.size;
  }

  get controlCount(): number {
    return this.controls.size;
  }

  current(sessionId: string): LiveRun | undefined {
    const slot = this.slots.get(sessionId);
    return slot && "runId" in slot ? slot : undefined;
  }

  isBusy(sessionId: string): boolean {
    return this.slots.has(sessionId) || this.lanes.has(sessionId);
  }

  enqueue<T>(sessionId: string, submit: () => Promise<T>): Promise<T> {
    return this.lanes.run(sessionId, submit);
  }

  prepare(sessionId: string): {
    controller: AbortController;
    release: () => void;
  } {
    const preparation: InputPreparation = {
      controller: new AbortController(),
    };
    this.preparations.set(sessionId, preparation);
    if (!this.slots.has(sessionId)) this.slots.set(sessionId, preparation);
    return {
      controller: preparation.controller,
      release: () => {
        if (this.preparations.get(sessionId) === preparation)
          this.preparations.delete(sessionId);
        if (this.slots.get(sessionId) === preparation)
          this.slots.delete(sessionId);
      },
    };
  }

  start(sessionId: string, runId: string): LiveRun {
    const live: LiveRun = {
      runId,
      done: Promise.resolve(),
      cancelled: false,
      controller: new AbortController(),
    };
    this.slots.set(sessionId, live);
    return live;
  }

  finish(sessionId: string, live: LiveRun): void {
    if (this.slots.get(sessionId) === live) this.slots.delete(sessionId);
  }

  cancel(live: LiveRun): void {
    live.cancelled = true;
    live.controller.abort(new Error("cancelled"));
    live.engine?.abort();
  }

  control(runId: string): ProcessControl | undefined {
    return this.controls.get(runId);
  }

  trackControl(runId: string, control: ProcessControl): void {
    this.controls.set(runId, control);
  }

  finishControl(runId: string): void {
    this.controls.delete(runId);
  }

  async drain(): Promise<void> {
    this.closing = true;
    const controls = [...this.controls.values()];
    const lives = [...this.slots.values()].filter(
      (slot): slot is LiveRun => "runId" in slot,
    );
    for (const control of controls)
      control.controller.abort(new Error("cancelled"));
    for (const preparation of this.preparations.values())
      preparation.controller.abort(
        new Error("Kernel shutting down during input preparation"),
      );
    for (const live of lives) this.cancel(live);
    await Promise.allSettled([
      ...controls.map((control) => control.done),
      ...this.lanes.values(),
      ...lives.map((live) => live.done),
    ]);
  }
}
