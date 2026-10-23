import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bindHooks,
  runHookCommand,
  type EngineHooks,
  type RunHooks,
} from "../src/runtime/hooks.js";
import { until } from "./support/wire-server.js";

type HookEvent = keyof RunHooks;
function invoke(hooks: EngineHooks, event: HookEvent, signal: AbortSignal) {
  const call = {
    type: "toolCall" as const,
    id: "call",
    name: "read",
    arguments: {},
  };
  switch (event) {
    case "userPromptSubmit":
      return hooks.userPromptSubmit(
        { role: "user", content: "input", timestamp: 1 },
        signal,
      );
    case "preToolUse":
      return hooks.preToolUse(
        call,
        {
          name: "read",
          description: "read",
          parameters: {},
          execute: async () => ({ content: [] }),
        },
        signal,
      );
    case "postToolUse":
      return hooks.postToolUse(call, { content: [] }, signal);
    case "stop":
      return hooks.stop("done", 0, signal);
  }
}

for (const event of [
  "userPromptSubmit",
  "preToolUse",
  "postToolUse",
  "stop",
] as const)
  for (const failLate of [false, true])
    test(`${event} cancellation skips later hooks after late ${failLate ? "rejection" : "completion"} and preserves active hook cleanup`, async () => {
      let release = () => {};
      const gate = new Promise<void>((resolve, reject) => {
        release = () =>
          failLate ? reject(new Error("late failure")) : resolve();
      });
      let started = 0,
        cleaned = false,
        later = false;
      const first: RunHooks = {
        [event]: async () => {
          started++;
          try {
            await gate;
          } finally {
            cleaned = true;
          }
        },
      };
      const errors: unknown[] = [];
      const hooks = bindHooks(
        {
          runId: "run",
          sessionId: "session",
          projectId: "project",
          projectRoot: ".",
          mode: "code",
          routeId: "text",
        },
        [
          first,
          {
            [event]: () => {
              later = true;
            },
          },
        ],
        (_event, error) => errors.push(error),
      );
      assert.ok(hooks);
      const controller = new AbortController();
      const pending = invoke(hooks, event, controller.signal);
      assert.equal(started, 1);
      const reason = new Error("cancelled fixture");
      controller.abort(reason);
      try {
        await assert.rejects(pending, (error) => error === reason);
        assert.equal(later, false);
        assert.equal(cleaned, false);
      } finally {
        release();
      }
      await setImmediate();
      assert.equal(cleaned, true);
      assert.equal(later, false);
      assert.deepEqual(
        errors,
        [],
        "cancellation is not an observer failure or denial",
      );
      await assert.rejects(
        invoke(hooks, event, controller.signal),
        (error) => error === reason,
      );
      assert.equal(
        started,
        1,
        "an already cancelled hook chain must not start",
      );
    });

test(
  "cancelled command hooks finish only after the real child process has exited",
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "foundation-hook-command-"),
    );
    const script = path.join(directory, "hook.cjs");
    const pidFile = path.join(directory, "hook.pid");
    const controller = new AbortController();
    let pid: number | undefined;
    await writeFile(
      script,
      "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);",
    );
    const operation = runHookCommand(
      {
        command: `${process.platform === "win32" ? "" : "exec "}"${process.execPath}" "${script}" "${pidFile}"`,
      },
      directory,
      {},
      10000,
      controller.signal,
    );
    const rejected = assert.rejects(operation, /Cancelled/);
    try {
      pid = await until(async () => {
        const value = await readFile(pidFile, "utf8").catch(() => undefined);
        return value ? Number(value) : undefined;
      });
      controller.abort();
      await rejected;
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
    } finally {
      controller.abort();
      await rejected;
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
