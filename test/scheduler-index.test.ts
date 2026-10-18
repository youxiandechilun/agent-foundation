import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolScheduler } from "../src/runtime/scheduler.js";
import type { ToolDefinition } from "../src/runtime/types.js";

type Lock = { key: string; access: "read" | "write" };
const locked = (locks: Lock[]): ToolDefinition => ({
  name: "indexed_lock",
  description: "test resource locks",
  parameters: { type: "object" },
  scheduling: { parallelSafe: true, resources: () => locks },
  execute: async () => ({ content: [] }),
});

test("reusing a declaration array cannot undercount active tools or release another reader's locks", async () => {
  const scheduler = new ToolScheduler(3);
  const shared = locked([{ key: "document", access: "read" }]);
  const first = await scheduler.acquire(shared, {});
  const second = await scheduler.acquire(shared, {});
  assert.equal(scheduler.state.active, 2);
  const writer = scheduler.acquire(
    locked([{ key: "document", access: "write" }]),
    {},
  );
  first();
  first();
  assert.deepEqual(scheduler.state, { active: 1, queued: 1, limit: 3 });
  second();
  const releaseWriter = await writer;
  releaseWriter();
  assert.deepEqual(scheduler.state, { active: 0, queued: 0, limit: 3 });
});

test("empty reused lock arrays still consume one slot per tool", async () => {
  const scheduler = new ToolScheduler(2);
  const tool = locked([]);
  const first = await scheduler.acquire(tool, {});
  const second = await scheduler.acquire(tool, {});
  const third = scheduler.acquire(tool, {});
  assert.deepEqual(scheduler.state, { active: 2, queued: 1, limit: 2 });
  first();
  const releaseThird = await third;
  second();
  releaseThird();
  assert.equal(scheduler.state.active, 0);
});

test("mutating a returned declaration cannot change active or queued resources", async () => {
  const scheduler = new ToolScheduler(3);
  const original: Lock[] = [{ key: "document", access: "read" }];
  const queued: Lock[] = [{ key: "document", access: "write" }];
  const first = await scheduler.acquire(locked(original), {});
  const writer = scheduler.acquire(locked(queued), {});
  original[0].key = "different";
  queued[0].key = "different";
  const reader = scheduler.acquire(
    locked([{ key: "document", access: "read" }]),
    {},
  );
  assert.deepEqual(scheduler.state, { active: 1, queued: 2, limit: 3 });
  first();
  const releaseWriter = await writer;
  assert.equal(scheduler.state.queued, 1);
  releaseWriter();
  (await reader)();
  assert.equal(scheduler.state.active, 0);
});

test("indexed arbitration matches pairwise read/write and wildcard semantics", async () => {
  const cases: Lock[][] = [
    [],
    ...["*", "a", "b"].flatMap((key): Lock[][] => [
      [{ key, access: "read" }],
      [{ key, access: "write" }],
    ]),
    [
      { key: "a", access: "read" },
      { key: "a", access: "write" },
    ],
    [
      { key: "a", access: "read" },
      { key: "a", access: "read" },
    ],
    [
      { key: "a", access: "write" },
      { key: "b", access: "read" },
    ],
  ];
  for (const first of cases)
    for (const second of cases) {
      const scheduler = new ToolScheduler(2);
      const releaseFirst = await scheduler.acquire(locked(first), {});
      const controller = new AbortController();
      const next = scheduler.acquire(locked(second), {}, controller.signal);
      const conflict = first.some((a) =>
        second.some(
          (b) =>
            (a.key === "*" || b.key === "*" || a.key === b.key) &&
            (a.access === "write" || b.access === "write"),
        ),
      );
      assert.equal(
        scheduler.state.queued,
        Number(conflict),
        JSON.stringify({ first, second }),
      );
      if (conflict) {
        controller.abort(new Error("cancel indexed waiter"));
        await assert.rejects(next, /cancel indexed waiter/);
      } else (await next)();
      releaseFirst();
      assert.deepEqual(scheduler.state, { active: 0, queued: 0, limit: 2 });
    }
});

test("conflicting readers respect an earlier writer while unrelated resources bypass it", async () => {
  const scheduler = new ToolScheduler(4);
  const read = await scheduler.acquire(
    locked([{ key: "a", access: "read" }]),
    {},
  );
  const controller = new AbortController();
  const writer = scheduler.acquire(
    locked([{ key: "a", access: "write" }]),
    {},
    controller.signal,
  );
  const laterReader = scheduler.acquire(
    locked([{ key: "a", access: "read" }]),
    {},
  );
  const unrelated = await scheduler.acquire(
    locked([{ key: "b", access: "write" }]),
    {},
  );
  assert.deepEqual(scheduler.state, { active: 2, queued: 2, limit: 4 });
  controller.abort(new Error("writer cancelled"));
  await assert.rejects(writer, /writer cancelled/);
  const releaseLaterReader = await laterReader;
  assert.deepEqual(scheduler.state, { active: 3, queued: 0, limit: 4 });
  unrelated();
  releaseLaterReader();
  read();
  assert.equal(scheduler.state.active, 0);
});
