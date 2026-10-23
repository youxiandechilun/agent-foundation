import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  access,
  readdir,
  writeFile,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "./support/wire-server.js";
import {
  prepareExtensionHost,
  reviewedWorkspace,
} from "../src/execution/extension-host.js";
import { CommandRunner } from "../src/execution/process.js";
import { spawn } from "node:child_process";
import { observePlugin } from "../src/extensions/plugins/invocation.js";
import { until } from "./support/wire-server.js";
const peer = fileURLToPath(
  new URL("./support/adversarial-mcp.mjs", import.meta.url),
);
test("plugin worker transports share bounded settlement and terminate after reply, error, timeout and cancellation", async () => {
  const x = await setup();
  const worker = fileURLToPath(
    new URL("../src/extensions/plugins/worker.mjs", import.meta.url),
  );
  try {
    for (const isolated of [false, true]) {
      for (const scenario of [
        "success",
        "error",
        "timeout",
        "cancel",
        "output",
        "result",
        "exit",
      ] as const) {
        const code = {
          success: "return {text:'真实中文 🧠'}",
          error: "throw Error('worker failure')",
          timeout: "return new Promise(()=>setInterval(()=>{},1000))",
          cancel: "return new Promise(()=>setInterval(()=>{},1000))",
          output:
            "process.stderr.write('x'.repeat(260000)); return new Promise(()=>setInterval(()=>{},1000))",
          result: "return '🧠'.repeat(600)",
          exit: "process.exit(7)",
        }[scenario];
        const source = `export async function execute(){${code}}`;
        const entry = path.join(x.project.root, "observer-plugin.mjs");
        await writeFile(entry, source);
        const child = spawn(process.execPath, [worker, entry], {
          cwd: x.project.root,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: isolated
            ? ["pipe", "pipe", "pipe"]
            : ["pipe", "pipe", "pipe", "ipc"],
        });
        const controller = new AbortController();
        const invocation = observePlugin(
          child,
          {
            operation: "tool",
            payload: { name: "run", args: {}, context: {} },
            ...(isolated
              ? {
                  nonce: "observer-test",
                  entry: "observer-plugin.mjs",
                  root: x.project.root,
                }
              : {}),
          },
          { "observer-plugin.mjs": source },
          scenario === "timeout" ? 200 : 5000,
          1024,
          controller.signal,
        );
        if (scenario === "cancel") controller.abort();
        if (scenario === "success")
          assert.deepEqual(await invocation, { text: "真实中文 🧠" });
        else
          await assert.rejects(
            invocation,
            {
              error: /worker failure/,
              timeout: /timed out/,
              cancel: /cancelled/,
              output: /output limit/,
              result: /result too large/,
              exit: /exited before result \(7\)/,
            }[scenario],
          );
        await until(() => child.exitCode !== null || child.signalCode !== null);
      }
    }
  } finally {
    await x.close();
  }
});
test("Docker remains optional for actual native plugin and stdio MCP execution", async () => {
  const x = await setup();
  try {
    assert.equal(x.config.execution.boundary, "native");
    assert.equal(x.config.extensions.executionBoundary, "native");
    const p = await x.kernel.plugins.install(
      {
        schemaVersion: 1,
        id: "native",
        name: "native",
        version: "1.0.0",
        entry: "index.mjs",
        tools: [
          {
            name: "run",
            description: "real filesystem effect",
            parameters: { type: "object" },
            capabilities: ["files.write"],
          },
        ],
      },
      {
        "index.mjs":
          "import {writeFile} from 'node:fs/promises';import path from 'node:path';export async function execute(name,args,ctx){await writeFile(path.join(ctx.projectRoot,'native-plugin.txt'),'real native output');return {saved:true};}",
      },
    );
    x.kernel.plugins.enable(p.id, true, p.hash);
    const [tool] = x.kernel.plugins.tools(x.project.id, x.project.root);
    await tool.execute("call", {});
    assert.equal(
      await readFile(path.join(x.project.root, "native-plugin.txt"), "utf8"),
      "real native output",
    );
    x.kernel.mcp.install({
      id: "native",
      name: "native stdio",
      transport: "stdio",
      command: process.execPath,
      args: [peer, x.project.root],
    });
    await x.kernel.mcp.connect("native");
    assert.equal((await x.kernel.mcp.catalog("native")).length, 1);
  } finally {
    await x.close();
  }
});
test("native plugin snapshots accept a configured data directory alias", async () => {
  const x = await setup();
  try {
    const alias = path.join(x.root, "data-alias");
    await symlink(x.config.dataDir, alias, "junction");
    x.config.dataDir = alias;
    const plugin = await x.kernel.plugins.install(
      {
        schemaVersion: 1,
        id: "alias",
        name: "alias",
        version: "1.0.0",
        entry: "index.mjs",
        tools: [
          {
            name: "read",
            description: "alias snapshot",
            parameters: { type: "object" },
            capabilities: ["files.read"],
          },
        ],
      },
      {
        "index.mjs":
          "export function execute(){ return { value: 'verified-alias' }; }",
      },
    );
    x.kernel.plugins.enable(plugin.id, true, plugin.hash);
    const result = await x.kernel.plugins
      .tools(x.project.id, x.project.root)[0]
      .execute("alias", {});
    assert.deepEqual(result.content, [
      { type: "text", text: JSON.stringify({ value: "verified-alias" }) },
    ]);
    assert.deepEqual(await readdir(path.join(alias, "plugin-invocations")), []);
  } finally {
    await x.close();
  }
});

test("extension host generates restrictive mounts and container limits without placing credentials in argv", async () => {
  const x = await setup(undefined, {
    extensions: { executionBoundary: "docker" },
  });
  let host: Awaited<ReturnType<typeof prepareExtensionHost>> | undefined;
  try {
    host = await prepareExtensionHost(x.config, {
      command: "node",
      args: ["/plugin/index.mjs", "--privileged"],
      cwd: x.project.root,
      mounts: [
        { source: x.project.root, target: "/workspace", readOnly: true },
      ],
      workdir: "/workspace",
      env: { API_TOKEN: "isolated-fixture-token" },
      network: false,
    });
    assert.equal(host.command, "docker");
    assert.ok(host.args.includes("--pull=never"));
    assert.ok(host.args.includes("--read-only"));
    assert.ok(host.args.includes("no-new-privileges"));
    assert.ok(host.args.includes("65534:65534"));
    assert.ok(host.args.includes("none"));
    assert.ok(host.args.some((a) => a.endsWith("target=/workspace,readonly")));
    assert.ok(
      host.args.indexOf("--privileged") >
        host.args.indexOf(x.config.execution.dockerImage),
    );
    assert.ok(!host.args.join(" ").includes("isolated-fixture-token"));
    assert.equal(host.env.API_TOKEN, undefined);
    const envFile = host.args[host.args.indexOf("--env-file") + 1];
    assert.equal(
      await readFile(envFile, "utf8"),
      "API_TOKEN=isolated-fixture-token",
    );
    await host.cleanup();
    await assert.rejects(access(envFile), /ENOENT/);
    await host.cleanup();
  } finally {
    await host?.cleanup();
    await x.close();
  }
});
test("extension isolation rejects out-of-root mounts, disabled network and unsafe container policy", async () => {
  const x = await setup(undefined, {
    extensions: { executionBoundary: "docker" },
  });
  const request = {
    command: "node",
    args: [],
    cwd: x.project.root,
    mounts: [{ source: x.project.root, target: "/workspace", readOnly: true }],
    workdir: "/workspace",
    env: {},
    network: false,
  };
  try {
    await assert.rejects(reviewedWorkspace(x.config, x.root), /outside/);
    await assert.rejects(
      prepareExtensionHost(x.config, { ...request, network: true }),
      /network/,
    );
    await assert.rejects(
      prepareExtensionHost(x.config, {
        ...request,
        mounts: [
          {
            source: x.project.root,
            target: "/var/run/docker.sock",
            readOnly: false,
          },
        ],
      }),
      /mount/,
    );
    await assert.rejects(
      prepareExtensionHost(
        {
          ...x.config,
          execution: { ...x.config.execution, dockerUser: "0:0" },
        },
        request,
      ),
      /non-root/,
    );
    await assert.rejects(
      prepareExtensionHost(
        {
          ...x.config,
          execution: { ...x.config.execution, readOnlyRoot: false },
        },
        request,
      ),
      /read-only/,
    );
    await assert.rejects(
      prepareExtensionHost(x.config, {
        ...request,
        env: { KEY: "line1\nline2" },
      }),
      /single-line/,
    );
    x.kernel.mcp.install({
      id: "out",
      name: "out",
      transport: "stdio",
      command: "node",
      isolation: { boundary: "docker", workspaceRoot: x.root },
    });
    await assert.rejects(x.kernel.mcp.connect("out"), /outside/);
  } finally {
    await x.close();
  }
});
test("isolated plugin and MCP stdio fail closed and clean staging when Docker is unavailable", async () => {
  const x = await setup(undefined, {
    extensions: { executionBoundary: "docker" },
    execution: { boundary: "docker", requireIsolation: true },
  });
  try {
    let available = false;
    try {
      await new CommandRunner(x.config).probe(x.project.root);
      available = true;
    } catch {}
    const p = await x.kernel.plugins.install(
      {
        schemaVersion: 1,
        id: "isolated",
        name: "isolated",
        version: "1.0.0",
        entry: "index.mjs",
        tools: [
          {
            name: "run",
            description: "probe",
            parameters: { type: "object" },
            capabilities: ["files.write"],
          },
        ],
      },
      {
        "index.mjs":
          "import {writeFile} from 'node:fs/promises';import path from 'node:path';export async function execute(n,a,c){await writeFile(path.join(c.projectRoot,'isolated-effect.txt'),'container only');return 'done';}",
      },
    );
    x.kernel.plugins.enable(p.id, true, p.hash);
    const s = await x.session("code"),
      [tool] = x.kernel.plugins.tools(x.project.id, x.project.root);
    assert.notEqual(
      x.kernel.permissions.evaluate(x.kernel.store.session(s.id), "text", tool)
        .effect,
      "deny",
    );
    if (!available) {
      await assert.rejects(tool.execute("call", {}));
      await assert.rejects(
        access(path.join(x.project.root, "isolated-effect.txt")),
        /ENOENT/,
      );
      await writeFile(
        path.join(x.project.root, "server.mjs"),
        "import {writeFile} from 'node:fs/promises';await writeFile('/workspace/stdio-escaped.txt','bad');",
      );
      x.kernel.mcp.install({
        id: "isolated",
        name: "isolated MCP",
        transport: "stdio",
        command: "node",
        args: ["/workspace/server.mjs"],
        isolation: {
          boundary: "docker",
          workspaceRoot: x.project.root,
          readOnly: false,
        },
      });
      await assert.rejects(x.kernel.mcp.connect("isolated"));
      await assert.rejects(
        access(path.join(x.project.root, "stdio-escaped.txt")),
        /ENOENT/,
      );
      assert.deepEqual(
        await readdir(path.join(x.config.dataDir, "isolation-env")),
        [],
      );
      assert.deepEqual(
        await readdir(path.join(x.config.dataDir, "plugin-invocations")),
        [],
      );
    } else
      assert.equal(
        (await new CommandRunner(x.config).probe(x.project.root)).boundary,
        "docker",
      );
  } finally {
    await x.close();
  }
});
