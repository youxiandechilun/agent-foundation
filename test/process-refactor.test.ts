import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { nativeProcess } from "../src/execution/process.js";
import { terminateProcessTree } from "../src/execution/lifecycle.js";

const command = (source: string, timeoutMs = 5000) => ({
  command: process.execPath,
  args: ["-e", source],
  cwd: process.cwd(),
  timeoutMs,
});

test("concurrent process tree cleanup shares one operation and stops the child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const closed = once(child, "close");
  await once(child, "spawn");
  const first = terminateProcessTree(child);
  assert.equal(terminateProcessTree(child), first);
  await first;
  await closed;
  assert.equal(terminateProcessTree(child), first);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("command cancellation stops output delivery and the running process", async () => {
  const controller = new AbortController();
  let callbacks = 0;
  const invocation = nativeProcess(
    command(
      "console.log(process.pid);setInterval(()=>process.stdout.write('next'),1)",
    ),
    controller.signal,
    () => {
      callbacks++;
      controller.abort();
    },
  );
  await assert.rejects(invocation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Command cancelled/);
    assert.ok("stdout" in error && typeof error.stdout === "string");
    const pid = Number(error.stdout.split("\n", 1)[0]);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0));
    return true;
  });
  assert.equal(callbacks, 1);
});

test("an output observer failure rejects the command after terminating its process", async () => {
  const observerError = Object.freeze(new Error("observer failed"));
  await assert.rejects(
    nativeProcess(
      command("console.log(process.pid);setInterval(()=>{},1000)"),
      undefined,
      () => {
        throw observerError;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, observerError);
      assert.ok("stdout" in error && typeof error.stdout === "string");
      const pid = Number(error.stdout.trim());
      assert.throws(() => process.kill(pid, 0));
      return true;
    },
  );
});

test("command output limits retain bounded output and terminate a flooding process", async () => {
  await assert.rejects(
    nativeProcess({
      ...command("setInterval(()=>process.stdout.write('x'.repeat(10000)),1)"),
      maxOutputBytes: 1024,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /output limit exceeded/);
      assert.ok("stdout" in error && typeof error.stdout === "string");
      assert.ok(Buffer.byteLength(error.stdout) <= 1024);
      return true;
    },
  );
});

test("command timeout terminates execution and pre-cancelled commands never start", async () => {
  await assert.rejects(
    nativeProcess(command("setInterval(()=>{},1000)", 100)),
    /Command timed out/,
  );
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  assert.throws(
    () => nativeProcess(command("process.exit(0)"), controller.signal),
    /already cancelled/,
  );
});

test("cancellation during abort listener registration is observed immediately", async () => {
  const controller = new AbortController();
  const attach = controller.signal.addEventListener.bind(controller.signal);
  Object.defineProperty(controller.signal, "addEventListener", {
    value: (...args: Parameters<AbortSignal["addEventListener"]>) => {
      controller.abort();
      attach(...args);
    },
  });
  await assert.rejects(
    nativeProcess(command("setInterval(()=>{},1000)", 1000), controller.signal),
    /Command cancelled/,
  );
});

test("successful commands preserve split UTF-8 output, streams and exit status", async () => {
  const output: string[] = [];
  const result = await nativeProcess(
    command(
      "const b=Buffer.from('中🧠');let i=0;const t=setInterval(()=>{if(i<b.length)process.stdout.write(b.subarray(i,++i));else{clearInterval(t);process.stderr.write('错误');process.exitCode=7}},5)",
    ),
    undefined,
    (value) => output.push(value),
  );
  assert.deepEqual(result, {
    exitCode: 7,
    stdout: "中🧠",
    stderr: "错误",
    boundary: "native",
  });
  assert.equal(output.join(""), "中🧠错误");
});
