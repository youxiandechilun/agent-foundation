import { test } from "node:test";
import assert from "node:assert/strict";
import { RunLifecycle } from "../src/core/kernel/lifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("input lanes isolate sessions, recover after failure and retain the latest queued owner", async () => {
  const lifecycle = new RunLifecycle();
  const firstGate = deferred(),
    secondGate = deferred(),
    secondStarted = deferred();
  const order: string[] = [];
  const first = lifecycle.enqueue("a", async () => {
    order.push("first");
    await firstGate.promise;
    throw new Error("invalid input");
  });
  const firstFailure = assert.rejects(first, /invalid input/);
  const second = lifecycle.enqueue("a", async () => {
    order.push("second");
    secondStarted.resolve();
    await secondGate.promise;
    return "accepted";
  });
  const independent = lifecycle.enqueue("b", async () => "independent");
  assert.equal(await independent, "independent");
  assert.deepEqual(order, ["first"]);
  assert.equal(lifecycle.isBusy("b"), false);
  assert.equal(lifecycle.isBusy("a"), true);
  firstGate.resolve();
  await firstFailure;
  await secondStarted.promise;
  assert.equal(lifecycle.isBusy("a"), true);
  secondGate.resolve();
  assert.equal(await second, "accepted");
  assert.equal(lifecycle.isBusy("a"), false);
  assert.deepEqual(order, ["first", "second"]);
});

test("preparation transfers its single capacity slot to the live run without double counting", () => {
  const lifecycle = new RunLifecycle();
  const preparation = lifecycle.prepare("a");
  assert.equal(lifecycle.occupiedRunCount, 1);
  assert.equal(lifecycle.current("a"), undefined);
  assert.equal(lifecycle.isBusy("a"), true);
  const live = lifecycle.start("a", "run-1");
  assert.equal(lifecycle.occupiedRunCount, 1);
  preparation.release();
  assert.equal(lifecycle.current("a"), live);
  const steering = lifecycle.prepare("a");
  assert.equal(lifecycle.occupiedRunCount, 1);
  steering.release();
  assert.equal(lifecycle.current("a"), live);
  lifecycle.finish("a", live);
  assert.equal(lifecycle.occupiedRunCount, 0);
  const failed = lifecycle.prepare("b");
  failed.release();
  assert.equal(lifecycle.isBusy("b"), false);
});

test("late preparation and run finalizers cannot remove newer owners", () => {
  const lifecycle = new RunLifecycle();
  const oldPreparation = lifecycle.prepare("a");
  oldPreparation.release();
  const currentPreparation = lifecycle.prepare("a");
  oldPreparation.release();
  assert.equal(lifecycle.occupiedRunCount, 1);
  const oldRun = lifecycle.start("a", "old");
  lifecycle.finish("a", oldRun);
  const currentRun = lifecycle.start("a", "current");
  lifecycle.finish("a", oldRun);
  currentPreparation.release();
  assert.equal(lifecycle.current("a"), currentRun);
});

test("shutdown aborts runs and preparations before waiting on slow process control settlement", async () => {
  const lifecycle = new RunLifecycle();
  const controlGate = deferred(),
    runGate = deferred(),
    inputGate = deferred();
  const control = {
    controller: new AbortController(),
    done: controlGate.promise,
  };
  lifecycle.trackControl("control", control);
  const live = lifecycle.start("a", "run");
  live.done = runGate.promise;
  const preparation = lifecycle.prepare("b");
  const input = lifecycle.enqueue("b", () => inputGate.promise);
  let settled = false;
  const closing = lifecycle.drain().then(() => {
    settled = true;
  });
  assert.equal(lifecycle.closing, true);
  assert.equal(control.controller.signal.aborted, true);
  assert.equal(live.controller.signal.aborted, true);
  assert.equal(live.cancelled, true);
  assert.equal(preparation.controller.signal.aborted, true);
  assert.match(
    String(preparation.controller.signal.reason),
    /input preparation/,
  );
  assert.equal(settled, false);
  controlGate.resolve();
  runGate.resolve();
  await Promise.resolve();
  assert.equal(settled, false, "input lane must also settle");
  inputGate.resolve();
  await input;
  await closing;
  preparation.release();
  lifecycle.finish("a", live);
  lifecycle.finishControl("control");
  assert.equal(lifecycle.controlCount, 0);
  assert.equal(lifecycle.occupiedRunCount, 0);
});
