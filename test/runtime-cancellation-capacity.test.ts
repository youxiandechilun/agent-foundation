import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ToolEffect } from "../src/contracts.js";
import { ExecutionEngine } from "../src/runtime/engine.js";
import { ToolScheduler } from "../src/runtime/scheduler.js";
import {
  emptyUsage,
  type AssistantMessage,
  type ToolDefinition,
  type ToolResult,
} from "../src/runtime/types.js";
import { Store } from "../src/storage/store.js";
import { until } from "./support/wire-server.js";

const result: ToolResult = { content: [{ type: "text", text: "done" }] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function engine(
  store: Store,
  scheduler: ToolScheduler,
  runId: string,
  execute: ToolDefinition["execute"],
  resource?: string,
) {
  let requests = 0;
  return new ExecutionEngine({
    runId,
    routeId: "text",
    instructions: "test",
    history: [],
    tools: [
      {
        name: "host_operation",
        description: "test host operation",
        parameters: { type: "object" },
        risk: "write",
        scheduling: resource
          ? {
              parallelSafe: true,
              resources: () => [{ key: resource, access: "write" }],
            }
          : undefined,
        execute,
      },
    ],
    scheduler,
    provider: {
      async complete(): Promise<AssistantMessage> {
        const first = requests++ === 0;
        return {
          role: "assistant",
          content: first
            ? [
                {
                  type: "toolCall",
                  id: "call_host_operation",
                  name: "host_operation",
                  arguments: {},
                },
              ]
            : [{ type: "text", text: "done" }],
          model: "test",
          provider: "text",
          stopReason: first ? "toolUse" : "stop",
          timestamp: 1,
          usage: emptyUsage(),
        };
      },
    },
    maxSteps: 2,
    maxToolCalls: 1,
    timeoutMs: 5000,
    store,
    publish() {},
    checkpoint() {},
    prepare: async (messages) => messages,
  });
}

const input = { role: "user" as const, content: "test", timestamp: 1 };

for (const resourceLocks of [false, true]) {
  for (const lateFailure of [false, true]) {
    test(
      `cancelled tools retain ${resourceLocks ? "resource locks" : "execution capacity"} until late ${lateFailure ? "rejection" : "completion"}`,
      { timeout: 10000 },
      async (t) => {
        const directory = await mkdtemp(
          path.join(tmpdir(), "foundation-operation-lease-"),
        );
        const store = new Store(directory);
        const scheduler = new ToolScheduler(resourceLocks ? 2 : 1);
        const pending = deferred<ToolResult>();
        const entered = deferred<void>();
        const resource = resourceLocks ? "same-resource" : undefined;
        let active = 0,
          peak = 0,
          started = 0;
        const first = engine(
          store,
          scheduler,
          "run_first",
          async () => {
            started++;
            active++;
            peak = Math.max(peak, active);
            entered.resolve();
            try {
              return await pending.promise;
            } finally {
              active--;
            }
          },
          resource,
        );
        const second = engine(
          store,
          scheduler,
          "run_second",
          async () => {
            started++;
            active++;
            peak = Math.max(peak, active);
            active--;
            return result;
          },
          resource,
        );
        t.after(async () => {
          first.abort();
          second.abort();
          pending.resolve(result);
          await until(() => scheduler.state.active === 0 || undefined);
          store.close();
          await rm(directory, { recursive: true, force: true });
        });
        const firstRun = first.run(input);
        await entered.promise;
        first.abort();
        assert.equal((await firstRun).status, "cancelled");
        assert.equal(active, 1);
        assert.equal(scheduler.state.active, 1);
        assert.equal(
          store.get<ToolEffect>("effects", "run_first:call_host_operation")
            .status,
          "unknown",
        );

        const secondRun = second.run(input);
        await until(() => scheduler.state.queued === 1 || undefined);
        assert.equal(started, 1);
        if (resourceLocks) {
          const independent = engine(
            store,
            scheduler,
            "run_independent",
            async () => result,
            "different-resource",
          );
          assert.equal((await independent.run(input)).status, "completed");
          assert.equal(scheduler.state.active, 1);
          assert.equal(started, 1);
        }

        if (lateFailure) pending.reject(new Error("late host failure"));
        else pending.resolve(result);
        assert.equal((await secondRun).status, "completed");
        assert.equal(started, 2);
        assert.equal(peak, 1);
        assert.equal(active, 0);
        assert.equal(
          store.get<ToolEffect>("effects", "run_first:call_host_operation")
            .status,
          "unknown",
        );
        assert.deepEqual(scheduler.state, {
          active: 0,
          queued: 0,
          limit: resourceLocks ? 2 : 1,
        });
      },
    );
  }
}
