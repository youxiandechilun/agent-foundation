import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { setup, collect } from "./support/wire-server.js";
import {
  applyCacheBreakpoints,
  retryDelay,
  DEFAULT_RETRY,
} from "../src/providers/text.js";
import { ProviderError, retryAfter } from "../src/providers/sse.js";

const fastRetry = { maxRetries: 2, initialDelayMs: 5, maxDelayMs: 2000 };

test("retry policy: transient-only, bounded, honours Retry-After", () => {
  const transient = new ProviderError("busy", 529);
  assert.equal(
    retryDelay(transient, 0, DEFAULT_RETRY, () => 0.5),
    1000,
  );
  assert.equal(
    retryDelay(transient, 1, DEFAULT_RETRY, () => 0.5),
    2000,
  );
  assert.equal(retryDelay(transient, 2, DEFAULT_RETRY), undefined);
  assert.equal(
    retryDelay(new ProviderError("bad", 400), 0, DEFAULT_RETRY),
    undefined,
  );
  const streamed = new ProviderError("cut", 502, true);
  assert.equal(retryDelay(streamed, 0, DEFAULT_RETRY), undefined);
  const overflow = new ProviderError("long", 503, false, true);
  assert.equal(retryDelay(overflow, 0, DEFAULT_RETRY), undefined);
  assert.equal(
    retryDelay(
      new ProviderError("x", 429, false, false, 1500),
      0,
      DEFAULT_RETRY,
    ),
    1500,
  );
  assert.equal(
    retryDelay(
      new ProviderError("x", 429, false, false, 120_000),
      0,
      DEFAULT_RETRY,
    ),
    undefined,
    "a Retry-After beyond maxDelayMs surfaces instead of stalling",
  );
  assert.equal(retryAfter(new Headers({ "retry-after": "3" })), 3000);
  assert.equal(retryAfter(new Headers({ "retry-after-ms": "250" })), 250);
  assert.equal(
    retryAfter(
      new Headers({ "retry-after": new Date(10_000).toUTCString() }),
      4_000,
    ),
    6000,
  );
  assert.equal(retryAfter(new Headers()), undefined);
});

test("the last route in the chain retries transient failures in place", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? { status: 529, error: { message: "overloaded" } }
      : index === 1
        ? {
            status: 429,
            error: { message: "slow down" },
            headers: { "retry-after-ms": "20" },
          }
        : { text: "recovered" },
  );
  try {
    x.config.routes.text.retry = fastRetry;
    const s = await x.session(),
      r = await x.client.submit(s.id, { text: "hi" }),
      events = await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    assert.equal(x.wire.requests.length, 3);
    const retries = events.filter((e) => e.type === "model.retry");
    assert.deepEqual(
      retries.map((e) => [e.data.attempt, e.data.status]),
      [
        [1, 529],
        [2, 429],
      ],
    );
    assert.equal(retries[1].data.delayMs, 20);
  } finally {
    await x.close();
  }
});

test("retries stop at maxRetries and the run fails with the provider error", async () => {
  const x = await setup(() => ({ status: 503, error: { message: "down" } }));
  try {
    x.config.routes.text.retry = { ...fastRetry, maxRetries: 1 };
    const s = await x.session(),
      r = await x.client.submit(s.id, { text: "hi" });
    const result = await x.kernel.wait(r.runId);
    assert.equal(result.status, "failed");
    assert.equal(x.wire.requests.length, 2);
  } finally {
    await x.close();
  }
});

test("Anthropic cache breakpoints copy blocks and stay within four markers", () => {
  const replayed = { type: "text", text: "assistant state" };
  const body = {
    system: "stable instructions",
    tools: [{ name: "a" }, { name: "b" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [replayed] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "1", content: [] },
          { type: "text", text: "" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ],
  };
  const original = structuredClone(body);
  const out = applyCacheBreakpoints(structuredClone(body)) as any;
  const marks = JSON.stringify(out).match(/cache_control/g) || [];
  assert.equal(marks.length, 4);
  assert.deepEqual(out.system, [
    {
      type: "text",
      text: "stable instructions",
      cache_control: { type: "ephemeral" },
    },
  ]);
  assert.ok(out.tools[1].cache_control && !out.tools[0].cache_control);
  assert.ok(out.messages[4].content[0].cache_control);
  assert.ok(
    out.messages[2].content[0].cache_control,
    "empty text is skipped; the tool_result before it is marked",
  );
  assert.equal(out.messages[0].content[0].cache_control, undefined);
  assert.equal((replayed as any).cache_control, undefined);
  assert.deepEqual(body, original);
});

test("Anthropic requests carry cache_control unless the route disables it", async () => {
  const x = await setup(() => ({ text: "cached" }), {
    routes: {
      text: {
        kind: "text",
        adapter: "anthropic-messages",
        model: "m",
        baseUrl: "http://127.0.0.1:1",
        contextWindow: 128000,
      },
    },
  });
  try {
    x.config.routes.text.baseUrl = x.wire.url;
    const s = await x.session("code");
    let r = await x.client.submit(s.id, { text: "one" });
    await x.kernel.wait(r.runId);
    const sent = x.wire.requests[0].body;
    assert.equal(sent.system[0].cache_control.type, "ephemeral");
    assert.ok(sent.tools.at(-1).cache_control);
    assert.ok(sent.messages.at(-1).content.at(-1).cache_control);
    x.config.routes.text.promptCache = false;
    r = await x.client.submit(s.id, { text: "two" });
    await x.kernel.wait(r.runId);
    assert.doesNotMatch(
      JSON.stringify(x.wire.requests[1].body),
      /cache_control/,
    );
  } finally {
    await x.close();
  }
});

test("programmatic hooks deny, rewrite, annotate and continue without granting access", async () => {
  const x = await setup((_body, index) => {
    if (index === 0)
      return {
        calls: [
          { name: "file_write", args: { path: "blocked.txt", content: "x" } },
          { name: "file_write", args: { path: "a.txt", content: "draft" } },
        ],
      };
    if (index === 1) return { text: "first answer" };
    return { text: "final answer after stop feedback" };
  });
  try {
    const seen: string[] = [];
    x.kernel.addHooks({
      userPromptSubmit: (_ctx, input) => {
        seen.push(`prompt:${input.text}`);
        return input.text.includes("forbidden")
          ? { block: "policy says no" }
          : { additionalContext: "branch=main" };
      },
      preToolUse: (ctx, call) => {
        assert.equal(ctx.mode, "code");
        if (call.arguments.path === "blocked.txt")
          return { deny: "writes to blocked.txt are not allowed" };
        return { updatedInput: { ...call.arguments, content: "rewritten" } };
      },
      postToolUse: (_ctx, call) => ({
        additionalContext: `lint ok for ${call.arguments.path}`,
      }),
      stop: (_ctx, input) =>
        input.continuations === 0 ? { continue: "run the tests" } : undefined,
    });
    const s = await x.session("code");
    const r = await x.client.submit(s.id, { text: "write files" }),
      events = await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    const root = x.config.workspaceRoots[0];
    await assert.rejects(stat(path.join(root, "blocked.txt")));
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "rewritten");
    assert.match(
      JSON.stringify(x.wire.requests[0].body.messages.at(-1)),
      /hook_context.*branch=main/,
    );
    const second = JSON.stringify(x.wire.requests[1].body.messages);
    assert.match(second, /Denied by PreToolUse hook: writes to blocked.txt/);
    assert.match(second, /lint ok for a.txt/);
    assert.equal(x.wire.requests.length, 3);
    assert.match(
      JSON.stringify(x.wire.requests[2].body.messages.at(-1)),
      /hook_feedback.*run the tests/,
    );
    assert.ok(events.some((e) => e.type === "hook.denied"));
    assert.ok(events.some((e) => e.type === "tool.input.updated"));
    assert.equal(events.filter((e) => e.type === "hook.continued").length, 1);
    const blocked = await x.client.submit(s.id, { text: "forbidden ask" });
    const outcome = await x.kernel.wait(blocked.runId);
    assert.equal(outcome.status, "failed");
    assert.match(String(outcome.error), /policy says no/);
    assert.equal(
      x.kernel.store.get<any>("inbox", blocked.inputId).status,
      "rejected",
    );
    assert.equal(
      x.wire.requests.length,
      3,
      "blocked input never reached the model",
    );
    assert.ok(seen.includes("prompt:forbidden ask"));
  } finally {
    await x.close();
  }
});

test("hook-rewritten arguments are re-validated and still pass permission policy", async () => {
  const x = await setup(
    (_body, index) =>
      index % 2 === 0
        ? {
            calls: [
              { name: "file_write", args: { path: "a.txt", content: "1" } },
            ],
          }
        : { text: "done" },
    { permissions: { "files.write": "deny" } },
  );
  try {
    let invalid = true;
    x.kernel.addHooks({
      preToolUse: (_ctx, call) =>
        invalid
          ? ((invalid = false), { updatedInput: { path: 42 } as any })
          : { updatedInput: call.arguments },
    });
    const s = await x.session("code");
    let r = await x.client.submit(s.id, { text: "go" });
    await x.kernel.wait(r.runId);
    assert.match(
      JSON.stringify(x.wire.requests[1].body.messages),
      /PreToolUse hook produced invalid arguments/,
    );
    r = await x.client.submit(s.id, { text: "again" });
    await x.kernel.wait(r.runId);
    assert.equal(x.wire.requests.length, 4);
    assert.match(
      JSON.stringify(x.wire.requests[3].body.messages.at(-1)),
      /"isError":true|is_error|denied/i,
    );
    await assert.rejects(stat(path.join(x.config.workspaceRoots[0], "a.txt")));
  } finally {
    await x.close();
  }
});

test("config command hooks follow the exit-code/JSON protocol", async () => {
  const x = await setup((_body, index) =>
    index === 0
      ? {
          calls: [
            { name: "file_write", args: { path: "secret.env", content: "k" } },
            { name: "file_write", args: { path: "ok.txt", content: "fine" } },
          ],
        }
      : { text: index === 1 ? "first stop" : "second stop" },
  );
  try {
    const root = x.config.workspaceRoots[0],
      script = path.join(x.root, "hook.mjs");
    await writeFile(
      script,
      `let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{
const e=JSON.parse(raw);
if(e.hook_event_name==="PreToolUse"&&e.tool_input.path.endsWith(".env")){process.stderr.write("no env files");process.exit(2)}
if(e.hook_event_name==="PostToolUse"){process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:"post:"+e.tool_input.path}}));return}
if(e.hook_event_name==="Stop"&&!e.stop_hook_active){process.stdout.write(JSON.stringify({decision:"block",reason:"verify first"}));return}
if(e.hook_event_name==="UserPromptSubmit"){process.stdout.write("cwd="+(e.cwd===process.cwd()));return}
});`,
    );
    const command = `"${process.execPath}" "${script}"`;
    Object.assign(x.config.hooks, {
      UserPromptSubmit: [{ command }],
      PreToolUse: [{ matcher: "file_write|file_patch", command }],
      PostToolUse: [{ matcher: "file_.*", command }],
      Stop: [{ command }],
    });
    const s = await x.session("code");
    const r = await x.client.submit(s.id, { text: "go" });
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    await assert.rejects(stat(path.join(root, "secret.env")));
    assert.equal(await readFile(path.join(root, "ok.txt"), "utf8"), "fine");
    assert.match(
      JSON.stringify(x.wire.requests[0].body.messages.at(-1)),
      /cwd=true/,
    );
    const second = JSON.stringify(x.wire.requests[1].body.messages);
    assert.match(second, /no env files/);
    assert.match(second, /post:ok.txt/);
    assert.equal(x.wire.requests.length, 3);
    assert.match(
      JSON.stringify(x.wire.requests[2].body.messages.at(-1)),
      /verify first/,
    );
  } finally {
    await x.close();
  }
});

test("a crashing observer hook is reported but a crashing PreToolUse hook fails closed", async () => {
  const x = await setup((_body, index) =>
    index % 2 === 0
      ? {
          calls: [
            { name: "file_write", args: { path: "a.txt", content: "1" } },
          ],
        }
      : { text: "done" },
  );
  try {
    x.kernel.addHooks({
      postToolUse: () => {
        throw new Error("observer down");
      },
    });
    const remove = x.kernel.addHooks({
      preToolUse: () => {
        throw new Error("guard down");
      },
    });
    const s = await x.session("code");
    let r = await x.client.submit(s.id, { text: "go" }),
      events = await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    assert.match(
      JSON.stringify(x.wire.requests[1].body.messages),
      /PreToolUse hook failed: guard down/,
    );
    await assert.rejects(stat(path.join(x.config.workspaceRoots[0], "a.txt")));
    remove();
    r = await x.client.submit(s.id, { text: "again" });
    events = await collect(x.client, r.runId);
    assert.equal((await x.kernel.wait(r.runId)).status, "completed");
    assert.ok(
      events.some(
        (e) => e.type === "hook.failed" && e.data.event === "PostToolUse",
      ),
    );
  } finally {
    await x.close();
  }
});
