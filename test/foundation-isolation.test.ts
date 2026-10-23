import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  access,
  writeFile,
  symlink,
  mkdir,
  realpath,
} from "node:fs/promises";
import net from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { setup, collect, until } from "./support/wire-server.js";
import {
  prepareCommand,
  processEnvironment,
  CommandRunner,
} from "../src/execution/process.js";
import { parseConfig } from "../src/core/config.js";
import { AppError, registerSecret } from "../src/core/util.js";

test("container commands use non-root bounded isolation and cannot inject Docker flags or escape the workspace", async () => {
  const x = await setup(undefined, {
    execution: { boundary: "docker", requireIsolation: true },
  });
  try {
    const r = await prepareCommand(
      x.config,
      {
        command: "node",
        args: ["--privileged", "user argument"],
        cwd: x.project.root,
        timeoutMs: 1000,
      },
      x.project.root,
      true,
    );
    assert.equal(r.command, "docker");
    assert.ok(r.args.includes("--read-only"));
    assert.ok(r.args.includes("65534:65534"));
    assert.ok(r.args.includes("no-new-privileges"));
    assert.ok(r.args.includes("none"));
    assert.ok(r.args.includes("--tty"));
    assert.ok(
      r.args.indexOf("--privileged") >
        r.args.indexOf(x.config.execution.dockerImage),
    );
    assert.equal(r.env.NODE_OPTIONS, undefined);
    assert.ok(
      !r.args.includes("--privileged", 0) || r.args.at(-2) === "--privileged",
    );
    await assert.rejects(
      () =>
        prepareCommand(
          x.config,
          {
            command: "node",
            args: [],
            cwd: path.dirname(x.project.root),
            timeoutMs: 1000,
          },
          x.project.root,
        ),
      /escapes|outside|relative|unsafe/i,
    );
    assert.throws(
      () =>
        parseConfig({
          ...x.config,
          execution: { ...x.config.execution, boundary: "native" },
        }),
      /Required isolation/,
    );
    assert.throws(
      () =>
        parseConfig({
          ...x.config,
          execution: { ...x.config.execution, dockerUser: "000:000" },
        }),
      /Required isolation/,
    );
    assert.throws(
      () =>
        parseConfig({
          ...x.config,
          execution: { ...x.config.execution, dockerUser: "0:0" },
        }),
      /Required isolation/,
    );
  } finally {
    await x.close();
  }
});

test("required isolation rejects native plugin and MCP stdio execution before launching any source", async () => {
  const x = await setup(undefined, {
    execution: { boundary: "docker", requireIsolation: true },
  });
  try {
    x.kernel.mcp.install({
      id: "blocked",
      name: "blocked",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "throw Error('must never execute')"],
    });
    await assert.rejects(
      () => x.kernel.mcp.connect("blocked"),
      /isolated host/,
    );
    const s = await x.session("code");
    const p = await x.kernel.plugins.install(
      {
        schemaVersion: 1,
        id: "blocked_plugin",
        name: "blocked",
        version: "1.0.0",
        entry: "index.mjs",
        tools: [
          {
            name: "probe",
            description: "probe",
            parameters: { type: "object" },
          },
        ],
      },
      {
        "index.mjs":
          "export async function execute(){throw Error('must not run')}",
      },
    );
    x.kernel.plugins.enable(p.id, true, p.hash);
    const tools = x.kernel.plugins.tools(x.project.id, x.project.root);
    const decision = x.kernel.permissions.evaluate(
      x.kernel.store.session(s.id),
      "text",
      tools[0],
    );
    assert.equal(decision.effect, "deny");
    await assert.rejects(
      () => tools[0].execute("call", {}),
      (error: any) =>
        error.code === "isolation_required" && error.status === 403,
    );
  } finally {
    await x.close();
  }
});

test("process HTTP actions require approval, respect plan restrictions and publish real results", async () => {
  const x = await setup();
  try {
    const s = await x.session("code");
    await x.client.request("PATCH", `/v1/sessions/${s.id}`, {
      autonomy: "assist",
    });
    const action = await x.client.processAction(s.id, "start", {
      command: process.execPath,
      args: [
        "-e",
        "console.log('http-process-started');process.stdin.on('data',()=>process.exit(0))",
      ],
    });
    const events = collect(x.client, action.runId);
    const approval = await until(() =>
      x.kernel.store
        .list<any>("approvals")
        .find((a) => a.runId === action.runId && a.status === "pending"),
    );
    assert.equal(x.kernel.store.list("processes").length, 0);
    x.kernel.permissions.resolve(approval.id, true);
    const history = await events;
    assert.equal((await x.kernel.wait(action.runId)).status, "completed");
    const record = (
      history.find((e) => e.type === "process.action.completed")!.data
        .result as any
    ).details;
    assert.equal(record.status, "running");
    await x.client.request("PATCH", `/v1/sessions/${s.id}`, {
      autonomy: "plan",
    });
    const forbidden = await x.client.processAction(s.id, "write", {
      processId: record.id,
      text: "exit",
    });
    await collect(x.client, forbidden.runId);
    assert.equal((await x.kernel.wait(forbidden.runId)).status, "failed");
    assert.equal(
      (await x.kernel.processes.status(record.id, s.id)).status,
      "running",
    );
    await x.kernel.processes.stop(record.id, s.id);
  } finally {
    await x.close();
  }
});

test("managed output redacts known secrets split across writes before durable journal persistence", async () => {
  const x = await setup();
  const secret = "private-process-secret-123456789";
  registerSecret(secret);
  try {
    const s = await x.session("code"),
      script = `process.stdout.write(${JSON.stringify(secret.slice(0, 12))});setTimeout(()=>{process.stdout.write(${JSON.stringify(secret.slice(12))});setTimeout(()=>process.exit(0),60)},60)`;
    const p = await x.kernel.processes.start(s.id, {
      command: process.execPath,
      args: ["-e", script],
    });
    await until(async () => {
      const p1 = await x.kernel.processes.status(p.id, s.id);
      return p1.status === "exited" ? p1 : undefined;
    });
    const journal = await readFile(
      path.join(x.config.dataDir, "processes", p.id, "output.json"),
      "utf8",
    );
    assert.ok(!journal.includes(secret));
    assert.ok(!journal.includes(secret.slice(0, 12)));
    assert.match(journal, /REDACTED/);
    await assert.rejects(() =>
      access(path.join(x.config.dataDir, "processes", p.id, "request.json")),
    );
    assert.equal(processEnvironment().NODE_OPTIONS, undefined);
  } finally {
    await x.close();
  }
});

test("command preparation resolves configured root aliases and still rejects nested junction escapes", async () => {
  const x = await setup();
  try {
    const alias = path.join(x.root, "project-alias");
    await symlink(x.project.root, alias, "junction");
    const request = {
      command: process.execPath,
      args: ["-e", "process.stdout.write('alias-ready')"],
      cwd: alias,
      timeoutMs: 5000,
    };
    const prepared = await prepareCommand(x.config, request, alias);
    assert.equal(prepared.cwd, await realpath(x.project.root));
    const result = await new CommandRunner(x.config).run(request, alias);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "alias-ready");
    const outside = path.join(x.root, "outside-alias-root");
    await mkdir(outside);
    await symlink(
      outside,
      path.join(x.project.root, "nested-link"),
      "junction",
    );
    await assert.rejects(
      prepareCommand(
        x.config,
        { ...request, cwd: path.join(alias, "nested-link") },
        alias,
      ),
      /Symlinks and junctions/,
    );
  } finally {
    await x.close();
  }
});

test("an unavailable Docker backend fails closed without running the command on the host", async () => {
  const x = await setup(undefined, {
    execution: { boundary: "docker", requireIsolation: true },
  });
  const previousPath = process.env.PATH;
  const previousMixedPath = process.env.Path;
  try {
    // Make the missing-CLI case deterministic even when the host has Docker installed.
    process.env.PATH = x.project.root;
    if (process.platform === "win32") process.env.Path = x.project.root;
    const runner = new CommandRunner(x.config);
    await assert.rejects(() => runner.probe(x.project.root), /ENOENT/);
    const marker = "must-not-exist.txt";
    await assert.rejects(() =>
      runner.run(
        {
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync('${marker}','escaped')`,
          ],
          cwd: x.project.root,
          timeoutMs: 2000,
        },
        x.project.root,
      ),
    );
    await assert.rejects(() => access(path.join(x.project.root, marker)));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMixedPath === undefined) delete process.env.Path;
    else process.env.Path = previousMixedPath;
    await x.close();
  }
});

test("process RPC authenticates replies, hides its control secret and rejects replayed requests", async () => {
  const x = await setup();
  let request: any;
  let reply = '{"ok":true,"result":{"acceptedBytes":999}}\n';
  const fake = net.createServer((socket) => {
    socket.once("data", (data) => {
      request = JSON.parse(data.toString().trim());
      socket.end(reply);
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  let stateFile: string | undefined, original: string | undefined;
  try {
    const s = await x.session("code"),
      p = await x.kernel.processes.start(s.id, {
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.on('data',b=>console.log('received:'+b.toString()));setInterval(()=>{},1000)",
        ],
      });
    stateFile = path.join(x.config.dataDir, "processes", p.id, "state.json");
    original = await readFile(stateFile, "utf8");
    await writeFile(
      stateFile,
      JSON.stringify({
        ...JSON.parse(original),
        port: (fake.address() as any).port,
      }),
    );
    for (const forged of [
      '{"ok":true,"result":{"acceptedBytes":999}}',
      '{"payload":"{}"}',
      '{"payload":false,"proof":"invalid"}',
      JSON.stringify({ payload: "{}", proof: "0".repeat(64) }),
      "{invalid-json",
    ]) {
      reply = forged + "\n";
      await assert.rejects(
        () => x.kernel.processes.write(p.id, s.id, "must reject"),
        (error: unknown) =>
          error instanceof AppError &&
          error.status === 403 &&
          error.message === "Process peer authentication failed",
      );
    }
    const auth = JSON.parse(
      await readFile(
        path.join(x.config.dataDir, "processes", p.id, "auth.json"),
        "utf8",
      ),
    );
    assert.ok(!JSON.stringify(request).includes(auth.token));
    assert.equal(request.token, undefined);
    assert.equal(request.proof.length, 64);
    await writeFile(stateFile, original);
    const port = JSON.parse(original).port;
    original = undefined;
    const payload = {
      op: "write",
      data: Buffer.from("once\n").toString("base64"),
      nonce: randomBytes(16).toString("hex"),
      issuedAt: Date.now(),
    };
    const wire =
      JSON.stringify({
        ...payload,
        proof: createHmac("sha256", auth.token)
          .update(JSON.stringify(payload))
          .digest("hex"),
      }) + "\n";
    const send = () =>
      new Promise<any>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(wire));
        let content = "";
        socket.on("data", (d) => (content += d.toString()));
        socket.on("end", () => resolve(JSON.parse(content)));
        socket.on("error", reject);
      });
    assert.equal(JSON.parse((await send()).payload).ok, true);
    assert.equal((await send()).ok, false);
    const received = await until(async () => {
      const r = await x.kernel.processes.read(p.id, s.id);
      return r.frames
        .map((f: any) => f.text)
        .join("")
        .includes("received:once")
        ? r
        : undefined;
    });
    assert.equal(
      received.frames
        .map((f: any) => f.text)
        .join("")
        .match(/received:once/g)?.length,
      1,
    );
    await x.kernel.processes.stop(p.id, s.id);
  } finally {
    if (stateFile && original) await writeFile(stateFile, original);
    await x.close();
    await new Promise<void>((r) => fake.close(() => r()));
  }
});
