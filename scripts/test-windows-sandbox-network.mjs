// Explicit, optional external-network validation. Sends no model request or credentials.
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseConfig, CommandRunner, VERSION } from "../dist/index.js";
const report = {
  version: VERSION,
  checkedAt: new Date().toISOString(),
  status: "not-run",
  endpoint: "1.1.1.1:443",
  tests: [],
  reason: undefined,
};
const dial = () =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish({ connected: true }));
    socket.once("error", (e) => finish({ connected: false, error: e.code }));
    socket.once("timeout", () =>
      finish({ connected: false, error: "timeout" }),
    );
  });
const code = `const net=require('node:net');const socket=net.connect({host:'1.1.1.1',port:443,timeout:3000});let done=false;const finish=value=>{if(done)return;done=true;socket.destroy();console.log(JSON.stringify(value))};socket.once('connect',()=>finish({connected:true}));socket.once('error',e=>finish({connected:false,error:e.code}));socket.once('timeout',()=>finish({connected:false,error:'timeout'}));`;
try {
  assert.equal(
    process.platform,
    "win32",
    "This explicit probe requires Windows",
  );
  report.host = await dial();
  if (!report.host.connected) {
    report.status = "environment-unavailable";
    report.reason = "Host cannot reach the public TCP control endpoint";
    process.exitCode = 2;
  } else {
    await mkdir(path.resolve(".agent-data-tests"), { recursive: true });
    const root = await mkdtemp(
        path.resolve(".agent-data-tests/windows-network-"),
      ),
      workspace = path.join(root, "project");
    await mkdir(workspace);
    const config = parseConfig({
      dataDir: path.join(root, "data"),
      workspaceRoots: [workspace],
      routes: {
        unused: {
          kind: "text",
          adapter: "openai-completions",
          model: "unused-no-model-request",
          baseUrl: "http://127.0.0.1:1",
        },
      },
      defaultRoutes: { chat: "unused", code: "unused", office: "unused" },
      permissions: { network: "allow" },
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    for (const network of ["none", "internet"]) {
      config.execution.windowsSandbox.network = network;
      const runner = new CommandRunner(config);
      try {
        const result = await runner.run(
          {
            command: process.execPath,
            args: ["-e", code],
            cwd: workspace,
            timeoutMs: 15000,
          },
          workspace,
        );
        assert.equal(result.exitCode, 0, result.stderr);
        const connection = JSON.parse(result.stdout.trim());
        assert.equal(
          connection.connected,
          network === "internet",
          JSON.stringify({ network, connection }),
        );
        report.tests.push({
          network,
          osSandbox: result.boundary === "windows-appcontainer",
          ...connection,
        });
      } finally {
        await runner.close();
      }
    }
    const sandboxRoot = path.join(config.dataDir, "sandboxes");
    for (const id of await readdir(sandboxRoot))
      assert.equal(
        JSON.parse(
          await readFile(path.join(sandboxRoot, id, "state.json"), "utf8"),
        ).cleanupConfirmed,
        true,
      );
    report.status = "passed-real-public-network";
    report.cleanupConfirmed = true;
  }
} catch (error) {
  report.status = "failed";
  report.reason = error.message;
  process.exitCode = 1;
}
await mkdir(path.resolve("verification"), { recursive: true });
await writeFile(
  path.resolve("verification/windows-sandbox-network.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
