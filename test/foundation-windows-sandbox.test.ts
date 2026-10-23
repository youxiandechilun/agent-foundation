import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  readdir,
  copyFile,
  access,
  mkdir,
  symlink,
} from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { Kernel } from "../src/core/kernel.js";
import { setup, until } from "./support/wire-server.js";
import { CommandRunner, nativeProcess } from "../src/execution/process.js";
import {
  prepareWindowsSandbox,
  recoverWindowsSandboxes,
} from "../src/execution/windows-sandbox.js";

async function sandboxStates(dataDir: string) {
  const root = path.join(dataDir, "sandboxes");
  return Promise.all(
    (await readdir(root)).map(async (id) => ({
      id,
      ...JSON.parse(await readFile(path.join(root, id, "state.json"), "utf8")),
    })),
  );
}
function gone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
async function sddl(file: string) {
  const expression =
    "[System.IO.Directory]::GetAccessControl('" +
    file.replaceAll("'", "''") +
    "').GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)";
  const r = await nativeProcess({
    command: path.join(
      process.env.SystemRoot!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(expression, "utf16le").toString("base64"),
    ],
    cwd: path.dirname(file),
    timeoutMs: 15000,
  });
  assert.equal(r.exitCode, 0, r.stderr);
  return r.stdout.trim();
}

test(
  "Windows AppContainer runs actual Node code with verified lowbox token, project file access, denied sibling data and blocked loopback networking",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    let connected = 0;
    const server = net.createServer((socket) => {
      connected++;
      socket.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const outside = path.join(x.root, "private.txt");
      await writeFile(outside, "private original");
      await writeFile(path.join(x.project.root, "input.txt"), "project input");
      const script = `const fs=require('node:fs'),net=require('node:net');const result={read:fs.readFileSync('input.txt','utf8')};fs.writeFileSync('output.txt','project output');for(const [key,fn] of Object.entries({outsideRead:()=>fs.readFileSync(${JSON.stringify(outside)}),outsideWrite:()=>fs.writeFileSync(${JSON.stringify(outside)},'blocked')})){try{fn();result[key]=false}catch(e){result[key]=e.code}}const socket=net.connect(${(server.address() as any).port},'127.0.0.1');socket.on('error',e=>{result.network=e.code;console.log(JSON.stringify(result));});socket.on('connect',()=>{result.network=false;socket.end();console.log(JSON.stringify(result));});setTimeout(()=>socket.destroy(),2000).unref();`;
      const result = await new CommandRunner(x.config).run(
        {
          command: process.execPath,
          args: ["-e", script],
          cwd: x.project.root,
          timeoutMs: 30000,
        },
        x.project.root,
      );
      assert.equal(result.boundary, "windows-appcontainer");
      assert.equal(result.exitCode, 0, result.stderr);
      const values = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        value = values.find((row) => row.read);
      assert.equal(value.read, "project input");
      assert.match(value.outsideRead, /EPERM|EACCES/);
      assert.match(value.outsideWrite, /EPERM|EACCES/);
      assert.ok(typeof value.network === "string");
      assert.equal(connected, 0);
      assert.equal(await readFile(outside, "utf8"), "private original");
      assert.equal(
        await readFile(path.join(x.project.root, "output.txt"), "utf8"),
        "project output",
      );
      const [id] = await readdir(path.join(x.config.dataDir, "sandboxes")),
        state = JSON.parse(
          await readFile(
            path.join(x.config.dataDir, "sandboxes", id, "state.json"),
            "utf8",
          ),
        );
      assert.equal(state.osSandbox, true);
      assert.equal(state.cleanupConfirmed, true);
      assert.match(state.verifiedPackageSid, /^S-1-15-2-/);
      assert.ok(
        !(await readdir(path.join(x.config.dataDir, "sandboxes", id))).includes(
          "runtime",
        ),
      );
    } finally {
      await x.close();
      server.close();
    }
  },
);
test(
  "legacy Node pipe incompatibility fails explicitly inside the real sandbox while inherited subprocess isolation remains usable",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    try {
      const result = await new CommandRunner(x.config).run(
        {
          command: process.execPath,
          args: [
            "-e",
            "try{const p=require('node:child_process').spawnSync(process.execPath,['-e','process.stdout.write(\"pipe-actual\")'],{encoding:'utf8',timeout:1000});console.log(p.stdout)}catch(e){console.log(e.code)}",
          ],
          cwd: x.project.root,
          timeoutMs: 10000,
        },
        x.project.root,
      );
      const version = process.versions.uv.split(".").map(Number);
      if (version[0] === 1 && version[1] < 53)
        assert.match(result.stdout, /ERR_SANDBOX_RUNTIME_UNSUPPORTED/);
      else assert.match(result.stdout, /pipe-actual/);
    } finally {
      await x.close();
    }
  },
);
test(
  "Windows isolated persistent pipes have actual interactive IO, verified child state and confirmed cleanup",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    try {
      const session = await x.session("code"),
        p = await x.kernel.processes.start(session.id, {
          command: process.execPath,
          args: [
            "-e",
            "console.log('isolated-ready');process.stdin.on('data',b=>console.log('echo:'+b.toString().trim()))",
          ],
          pty: false,
        });
      assert.equal(p.boundary, "windows-appcontainer");
      assert.equal((p as any).osSandbox, true);
      await x.kernel.processes.write(p.id, session.id, "actual input\n");
      await until(async () => {
        const r = await x.kernel.processes.read(p.id, session.id);
        return (
          r.frames
            .map((f: any) => f.text)
            .join("")
            .includes("echo:actual input") || undefined
        );
      });
      const final = await x.kernel.processes.stop(p.id, session.id);
      assert.ok(["stopped", "exited"].includes(final.status));
      const [id] = await readdir(path.join(x.config.dataDir, "sandboxes")),
        state = JSON.parse(
          await readFile(
            path.join(x.config.dataDir, "sandboxes", id, "state.json"),
            "utf8",
          ),
        );
      assert.equal(state.cleanupConfirmed, true);
      assert.ok(
        !(await readdir(path.join(x.config.dataDir, "sandboxes", id))).includes(
          "runtime",
        ),
      );
    } finally {
      await x.close();
    }
  },
);

test(
  "Windows isolation rejects unsupported PTY and overbroad filesystem or network grants without native effects",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    try {
      const s = await x.session("code");
      await assert.rejects(
        x.kernel.processes.start(s.id, {
          command: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync('escaped.txt','bad')"],
          pty: true,
        }),
        /isolated PTY is unavailable/,
      );
      await assert.rejects(
        access(path.join(x.project.root, "escaped.txt")),
        /ENOENT/,
      );
      const request = {
        command: process.execPath,
        args: ["-e", ""],
        cwd: x.project.root,
        timeoutMs: 1000,
        grants: [{ path: x.root, readOnly: true }],
      };
      await assert.rejects(
        prepareWindowsSandbox(x.config, request),
        /expose kernel state/,
      );
      await assert.rejects(
        prepareWindowsSandbox(x.config, {
          ...request,
          grants: [{ path: path.parse(x.root).root, readOnly: true }],
        }),
        /whole filesystem drive/,
      );
      await assert.rejects(
        prepareWindowsSandbox(x.config, {
          ...request,
          grants: [],
          network: true,
        }),
        /network is disabled/,
      );
      const alias = path.join(x.project.root, "kernel-state-alias");
      await symlink(x.config.dataDir, alias, "junction");
      await assert.rejects(
        prepareWindowsSandbox(
          { ...x.config, dataDir: alias },
          { ...request, grants: [{ path: x.config.dataDir, readOnly: true }] },
        ),
        /expose kernel state/,
      );
      assert.deepEqual(
        await readdir(path.join(x.config.dataDir, "sandboxes")),
        [],
      );
    } finally {
      await x.close();
    }
  },
);

test(
  "Windows isolated source plugins perform actual project writes, deny private reads and cannot modify reviewed source",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
      extensions: { executionBoundary: "windows-appcontainer" },
    });
    try {
      const outside = path.join(x.root, "private.txt");
      await writeFile(outside, "private");
      const p = await x.kernel.plugins.install(
        {
          schemaVersion: 1,
          id: "sandbox",
          name: "sandbox",
          version: "1.0.0",
          entry: "index.mjs",
          tools: [
            {
              name: "run",
              description: "real isolation probe",
              parameters: { type: "object" },
              capabilities: ["files.read", "files.write"],
            },
          ],
        },
        {
          "index.mjs": `import {readFile,writeFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import path from 'node:path';export async function execute(n,a,c){await writeFile(path.join(c.projectRoot,'plugin-effect.txt'),'actual isolated plugin');const result={};for(const [key,fn] of Object.entries({outside:()=>readFile(${JSON.stringify(outside)}),self:()=>writeFile(fileURLToPath(import.meta.url),'bad')})){try{await fn();result[key]=false}catch(e){result[key]=e.code}}return result;}`,
        },
      );
      x.kernel.plugins.enable(p.id, true, p.hash);
      const [tool] = x.kernel.plugins.tools(x.project.id, x.project.root),
        s = await x.session("code");
      assert.notEqual(
        x.kernel.permissions.evaluate(
          x.kernel.store.session(s.id),
          "text",
          tool,
        ).effect,
        "deny",
      );
      const result: any = await tool.execute("actual", {});
      const value = JSON.parse(result.content[0].text);
      assert.match(value.outside, /EPERM|EACCES/);
      assert.match(value.self, /EPERM|EACCES/);
      assert.equal(
        await readFile(path.join(x.project.root, "plugin-effect.txt"), "utf8"),
        "actual isolated plugin",
      );
      assert.equal(await readFile(outside, "utf8"), "private");
      assert.equal(
        x.kernel.plugins.list()[0].executionBoundary,
        "windows-appcontainer",
      );
      assert.deepEqual(
        await readdir(path.join(x.config.dataDir, "plugin-invocations")),
        [],
      );
      for (const id of await readdir(path.join(x.config.dataDir, "sandboxes")))
        assert.equal(
          JSON.parse(
            await readFile(
              path.join(x.config.dataDir, "sandboxes", id, "state.json"),
              "utf8",
            ),
          ).cleanupConfirmed,
          true,
        );
    } finally {
      await x.close();
    }
  },
);

test(
  "Windows isolated MCP stdio completes actual protocol calls, read-only filesystem denial, scoped roots and explicit secret forwarding",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
      extensions: { executionBoundary: "windows-appcontainer" },
    });
    const previous = process.env.FOUNDATION_TEST_EXPLICIT,
      unrelated = process.env.UNRELATED_SANDBOX_SECRET;
    process.env.FOUNDATION_TEST_EXPLICIT = "sandbox-test-explicit-value";
    process.env.UNRELATED_SANDBOX_SECRET = "must-not-leak";
    try {
      const outside = path.join(x.root, "private.txt"),
        script = path.join(x.project.root, "server.mjs");
      await writeFile(outside, "private");
      await writeFile(path.join(x.project.root, "input.txt"), "MCP input");
      await copyFile(
        fileURLToPath(new URL("./support/sandbox-mcp.mjs", import.meta.url)),
        script,
      );
      x.kernel.mcp.install({
        id: "sandbox",
        name: "sandbox MCP",
        transport: "stdio",
        protocol: "legacy",
        command: process.execPath,
        args: [script, x.project.root, outside],
        envRefs: { EXPLICIT_SANDBOX_SECRET: "FOUNDATION_TEST_EXPLICIT" },
        isolation: {
          boundary: "windows-appcontainer",
          workspaceRoot: x.project.root,
          readOnly: true,
        },
        clientFeatures: {
          roots: [{ uri: pathToFileURL(x.project.root).href }],
        },
      });
      await x.kernel.mcp.connect("sandbox");
      const [tool] = await x.kernel.mcp.tools(),
        r: any = await tool.execute("actual", {}),
        value = JSON.parse(r.content[0].text);
      assert.equal(value.read, "MCP input");
      assert.match(value.write, /EPERM|EACCES/);
      assert.match(value.outsideRead, /EPERM|EACCES/);
      assert.match(value.outsideWrite, /EPERM|EACCES/);
      assert.match(value.selfWrite, /EPERM|EACCES/);
      assert.equal(value.secret, "sandbox-test-explicit-value");
      assert.equal(value.unrelated, undefined);
      assert.equal(
        value.roots.result.roots[0].uri,
        pathToFileURL(x.project.root).href,
      );
      assert.equal(
        x.kernel.mcp.list()[0].isolationEnforcement,
        "appcontainer-configured",
      );
      const [id] = await readdir(path.join(x.config.dataDir, "sandboxes")),
        directory = path.join(x.config.dataDir, "sandboxes", id);
      await assert.rejects(
        access(path.join(directory, "request.json")),
        /ENOENT/,
      );
      assert.ok(
        !(
          await readFile(path.join(directory, "manifest.json"), "utf8")
        ).includes(process.env.FOUNDATION_TEST_EXPLICIT!),
      );
      await x.kernel.mcp.disconnect("sandbox");
      assert.equal(
        JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"))
          .cleanupConfirmed,
        true,
      );
      assert.equal(await readFile(outside, "utf8"), "private");
    } finally {
      if (previous === undefined) delete process.env.FOUNDATION_TEST_EXPLICIT;
      else process.env.FOUNDATION_TEST_EXPLICIT = previous;
      if (unrelated === undefined) delete process.env.UNRELATED_SANDBOX_SECRET;
      else process.env.UNRELATED_SANDBOX_SECRET = unrelated;
      await x.close();
    }
  },
);

test(
  "Windows sandbox timeout and cancellation terminate actual descendant processes and revoke project ACLs",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    const original = await sddl(x.project.root);
    try {
      for (const mode of ["timeout", "cancel"]) {
        const ac = new AbortController(),
          pidFile = path.join(x.project.root, mode + "-pids.json");
        const script = `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));console.log('actual-tree-ready');setInterval(()=>{},1000);`;
        const pending = new CommandRunner(x.config).run(
          {
            command: process.execPath,
            args: ["-e", script],
            cwd: x.project.root,
            timeoutMs: mode === "timeout" ? 1500 : 15000,
          },
          x.project.root,
          ac.signal,
        );
        const rejected = assert.rejects(
          pending,
          mode === "timeout" ? /timed out/ : /cancelled/,
        );
        const pids: number[] = await until(() =>
          readFile(pidFile, "utf8")
            .then(JSON.parse)
            .catch(() => undefined),
        );
        if (mode === "cancel") ac.abort();
        await rejected;
        await until(() => pids.every(gone) || undefined);
        assert.ok(pids.every(gone));
        assert.equal(await sddl(x.project.root), original);
      }
      for (const state of await sandboxStates(x.config.dataDir))
        assert.equal(state.cleanupConfirmed, true);
    } finally {
      await x.close();
    }
  },
);

test(
  "Windows sandbox recovery preserves live owners, cleans a killed launcher's actual job and resumes through kernel startup",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    let resumed: Kernel | undefined,
      child: ReturnType<typeof spawn> | undefined;
    const original = await sddl(x.project.root);
    try {
      const prepared = await prepareWindowsSandbox(x.config, {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        cwd: x.project.root,
        timeoutMs: 15000,
        grants: [{ path: x.project.root, readOnly: false }],
      });
      child = spawn(prepared.command, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        stdio: "ignore",
        windowsHide: true,
      });
      const state = await until(() =>
        readFile(prepared.sandbox!.state, "utf8")
          .then(JSON.parse)
          .then((s) => (s.osSandbox ? s : undefined))
          .catch(() => undefined),
      );
      const live = await recoverWindowsSandboxes(x.config);
      assert.equal(live[0].preservedLiveOwner, true);
      assert.equal(live[0].confirmed, false);
      assert.equal(gone(state.pid), false);
      const closed = once(child, "close");
      child.kill();
      await closed;
      await until(() => gone(state.pid) || undefined);
      assert.notEqual(await sddl(x.project.root), original);
      await x.close();
      resumed = new Kernel(x.config);
      await resumed.init();
      assert.equal(resumed.sandboxRecovery[0].confirmed, true);
      assert.equal(
        JSON.parse(await readFile(prepared.sandbox!.state, "utf8"))
          .cleanupConfirmed,
        true,
      );
      await assert.rejects(
        access(path.join(path.dirname(prepared.sandbox!.state), "runtime")),
        /ENOENT/,
      );
      assert.equal(await sddl(x.project.root), original);
      const cleanup = await nativeProcess({
        ...prepared.cleanup!,
        cwd: prepared.cwd,
        timeoutMs: 15000,
      });
      assert.equal(cleanup.exitCode, 0, cleanup.stderr);
    } finally {
      child?.kill();
      await resumed?.close();
      await x.close();
    }
  },
);

test(
  "Windows process cancellation during sandbox preparation cleans staged runtime and never launches requested code",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    const ac = new AbortController();
    const watcher = watch(
      x.config.dataDir,
      { recursive: true },
      (_event, file) => {
        if (String(file).includes("sandboxes"))
          ac.abort(new Error("cancel during actual preparation"));
      },
    );
    try {
      const s = await x.session("code");
      await assert.rejects(
        x.kernel.processes.start(
          s.id,
          {
            command: process.execPath,
            args: [
              "-e",
              "require('node:fs').writeFileSync('cancel-escaped.txt','bad')",
            ],
          },
          ac.signal,
        ),
        /cancel during actual preparation/,
      );
      assert.equal(ac.signal.aborted, true);
      await assert.rejects(
        access(path.join(x.project.root, "cancel-escaped.txt")),
        /ENOENT/,
      );
      const states = await sandboxStates(x.config.dataDir);
      assert.equal(states.length, 1);
      assert.equal(states[0].cleanupConfirmed, true);
      assert.equal(states[0].osSandbox, undefined);
      assert.equal(x.kernel.store.list("processes").length, 0);
    } finally {
      watcher.close();
      await x.close();
    }
  },
);

test(
  "Windows sandbox cannot traverse a project junction into private host data and preserves the private ACL",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    try {
      const privateRoot = path.join(x.root, "private-junction-target");
      await mkdir(privateRoot);
      await writeFile(
        path.join(privateRoot, "private.txt"),
        "private junction target",
      );
      const original = await sddl(privateRoot);
      await symlink(
        privateRoot,
        path.join(x.project.root, "outside-link"),
        "junction",
      );
      const r = await new CommandRunner(x.config).run(
        {
          command: process.execPath,
          args: [
            "-e",
            "try{require('node:fs').readFileSync('outside-link/private.txt');console.log('escaped')}catch(e){console.log(e.code)}",
          ],
          cwd: x.project.root,
          timeoutMs: 10000,
        },
        x.project.root,
      );
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /EPERM|EACCES/);
      assert.equal(await sddl(privateRoot), original);
      assert.equal(
        await readFile(path.join(privateRoot, "private.txt"), "utf8"),
        "private junction target",
      );
    } finally {
      await x.close();
    }
  },
);

test(
  "Windows sandbox persistent process survives kernel restart with one launch and can still be explicitly stopped",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: {
        boundary: "windows-appcontainer",
        requireIsolation: true,
        processShutdown: "preserve",
      },
    });
    let resumed: Kernel | undefined,
      processId: string | undefined,
      sessionId: string | undefined;
    try {
      const s = await x.session("code");
      sessionId = s.id;
      const p = await x.kernel.processes.start(s.id, {
        command: process.execPath,
        args: [
          "-e",
          "console.log('once');process.stdin.on('data',b=>console.log('restart:'+b));setInterval(()=>{},1000)",
        ],
      });
      processId = p.id;
      await x.api.close();
      resumed = new Kernel(x.config);
      await resumed.init();
      assert.equal(resumed.sandboxRecovery[0].preservedLiveOwner, true);
      assert.equal((await resumed.processes.status(p.id, s.id)).pid, p.pid);
      await resumed.processes.write(p.id, s.id, "continued\n");
      const text = await until(async () => {
        const r = await resumed!.processes.read(p.id, s.id);
        const t = r.frames.map((f: any) => f.text).join("");
        return t.includes("restart:continued") ? t : undefined;
      });
      assert.equal(text.match(/once/g)?.length, 1);
      const stopped = await resumed.processes.stop(p.id, s.id);
      assert.ok(["stopped", "exited"].includes(stopped.status));
      for (const state of await sandboxStates(x.config.dataDir))
        assert.equal(state.cleanupConfirmed, true);
    } finally {
      if (resumed && processId && sessionId)
        await resumed.processes
          .stop(processId, sessionId)
          .catch(() => undefined);
      await resumed?.close();
      await x.close();
    }
  },
);

test(
  "Windows sandbox automatically terminates and cleans the actual job when its nonpersistent owner crashes",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    let owner: ReturnType<typeof spawn> | undefined;
    try {
      const prepared = await prepareWindowsSandbox(x.config, {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        cwd: x.project.root,
        timeoutMs: 15000,
        grants: [{ path: x.project.root, readOnly: true }],
      });
      owner = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("./support/sandbox-owner.mjs", import.meta.url),
          ),
          prepared.command,
          JSON.stringify(prepared.args),
          prepared.cwd,
        ],
        { cwd: x.project.root, windowsHide: true, stdio: "ignore" },
      );
      const state = await until(() =>
        readFile(prepared.sandbox!.state, "utf8")
          .then(JSON.parse)
          .then((s) => (s.osSandbox ? s : undefined))
          .catch(() => undefined),
      );
      assert.equal(state.ownerPid, owner.pid);
      const closed = once(owner, "close");
      owner.kill();
      await closed;
      const final = await until(() =>
        readFile(prepared.sandbox!.state, "utf8")
          .then(JSON.parse)
          .then((s) => (s.cleanupConfirmed ? s : undefined))
          .catch(() => undefined),
      );
      assert.match(final.error, /owner exited/);
      assert.equal(gone(state.pid), true);
      await assert.rejects(
        access(path.join(path.dirname(prepared.sandbox!.state), "runtime")),
        /ENOENT/,
      );
    } finally {
      owner?.kill();
      await x.close();
    }
  },
);

test(
  "Windows sandbox job enforces the configured process limit against real inherited and detached child launches",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: {
        boundary: "windows-appcontainer",
        requireIsolation: true,
        pidsLimit: 8,
      },
    });
    try {
      const script =
        "const cp=require('node:child_process');const children=[],errors=[];Promise.all(Array.from({length:15},(_,i)=>new Promise(resolve=>{try{const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',detached:i%2===0});c.once('spawn',()=>{children.push(c.pid);resolve()});c.once('error',e=>{errors.push(e.code);resolve()})}catch(e){errors.push(e.code);resolve()}}))).then(()=>{console.log(JSON.stringify({children,errors}));process.exit(0)});";
      const r = await x.kernel.commands.run(
        {
          command: process.execPath,
          args: ["-e", script],
          cwd: x.project.root,
          timeoutMs: 15000,
        },
        x.project.root,
      );
      assert.equal(r.exitCode, 0, r.stderr);
      const value = JSON.parse(r.stdout.trim());
      assert.ok(
        value.children.length > 0 && value.children.length <= 7,
        JSON.stringify(value),
      );
      assert.ok(value.errors.length >= 8, JSON.stringify(value));
      await until(() => value.children.every(gone) || undefined);
      assert.equal(
        (await sandboxStates(x.config.dataDir))[0].cleanupConfirmed,
        true,
      );
    } finally {
      await x.close();
    }
  },
);

test(
  "kernel shutdown drains actual isolated commands and source plugin cleanup before releasing the single-user kernel",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
      extensions: { executionBoundary: "windows-appcontainer" },
    });
    const original = await sddl(x.project.root);
    try {
      const commandPid = path.join(x.project.root, "closing-command.pid"),
        pluginPid = path.join(x.project.root, "closing-plugin.pid");
      const command = x.kernel.commands.run(
        {
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(commandPid)},String(process.pid));setInterval(()=>{},1000)`,
          ],
          cwd: x.project.root,
          timeoutMs: 20000,
        },
        x.project.root,
      );
      const commandRejected = assert.rejects(command, /cancelled/);
      const p = await x.kernel.plugins.install(
        {
          schemaVersion: 1,
          id: "close",
          name: "close",
          version: "1.0.0",
          entry: "index.mjs",
          tools: [
            {
              name: "run",
              description: "owned lifecycle fixture",
              parameters: { type: "object" },
              capabilities: ["files.write"],
            },
          ],
        },
        {
          "index.mjs": `import {writeFile} from 'node:fs/promises';export async function execute(){await writeFile(${JSON.stringify(pluginPid)},String(process.pid));await new Promise(()=>setInterval(()=>{},1000));}`,
        },
      );
      x.kernel.plugins.enable(p.id, true, p.hash);
      const plugin = x.kernel.plugins
        .tools(x.project.id, x.project.root)[0]
        .execute("close", {});
      const pluginRejected = assert.rejects(plugin, /cancelled/);
      const pids = await Promise.all(
        [commandPid, pluginPid].map((file) =>
          until(() =>
            readFile(file, "utf8")
              .then(Number)
              .catch(() => undefined),
          ),
        ),
      );
      await x.api.close();
      await Promise.all([commandRejected, pluginRejected]);
      assert.ok(pids.every(gone));
      assert.equal(await sddl(x.project.root), original);
      const states = await sandboxStates(x.config.dataDir);
      assert.equal(states.length, 2);
      assert.ok(states.every((s) => s.cleanupConfirmed));
      assert.deepEqual(
        await readdir(path.join(x.config.dataDir, "plugin-invocations")),
        [],
      );
      const next = new Kernel(x.config);
      try {
        await next.init();
      } finally {
        await next.close();
      }
    } finally {
      await x.close();
    }
  },
);

test(
  "Windows execution probe and capability API report actual isolation and the explicit unsupported PTY boundary",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    try {
      const caps: any = await x.client.request("GET", "/v1/capabilities");
      assert.equal(
        caps.executionSupport.selectedBoundary,
        "windows-appcontainer",
      );
      assert.equal(caps.executionSupport.windowsAppContainer.pty, false);
      assert.equal(caps.executionSupport.requiresRuntimeProbe, true);
      const probe: any = await x.client.request(
        "POST",
        "/v1/execution/probe",
        {},
      );
      assert.equal(probe.available, true);
      assert.equal(probe.osSandbox, true);
      assert.equal(probe.pty, false);
      assert.equal(probe.persistentPipes, true);
      assert.equal(
        (await sandboxStates(x.config.dataDir))[0].cleanupConfirmed,
        true,
      );
    } finally {
      await x.close();
    }
  },
);

test(
  "persistent broker revokes actual sandbox grants after the isolated launcher is killed without a stop request",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: { boundary: "windows-appcontainer", requireIsolation: true },
    });
    const original = await sddl(x.project.root);
    try {
      const session = await x.session("code");
      const p = await x.kernel.processes.start(session.id, {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
      });
      const [before] = await sandboxStates(x.config.dataDir);
      assert.equal(before.osSandbox, true);
      assert.equal(gone(p.pid!), false);
      process.kill(before.helperPid);
      const terminal = await until(async () => {
        const state = await x.kernel.processes.status(p.id, session.id);
        return ["exited", "failed", "stopped"].includes(state.status)
          ? state
          : undefined;
      });
      assert.notEqual(terminal.status, "unknown");
      assert.equal(gone(p.pid!), true);
      assert.equal(
        (await sandboxStates(x.config.dataDir))[0].cleanupConfirmed,
        true,
      );
      assert.equal(await sddl(x.project.root), original);
    } finally {
      await x.close();
    }
  },
);

test(
  "Windows sandbox read-only policy is enforced by the OS and child processes retain the same file isolation",
  { skip: process.platform !== "win32" },
  async () => {
    const x = await setup(undefined, {
      execution: {
        boundary: "windows-appcontainer",
        requireIsolation: true,
        workspaceReadOnly: true,
      },
    });
    try {
      const outside = path.join(x.root, "private.txt");
      await writeFile(outside, "private");
      await writeFile(path.join(x.project.root, "input.txt"), "source");
      const child = `try{require('node:fs').readFileSync(${JSON.stringify(outside)});process.stdout.write(JSON.stringify({child:'escaped'})+'\\n')}catch(e){process.stdout.write(JSON.stringify({child:e.code})+'\\n')}`;
      const script = `const fs=require('node:fs');let write;try{fs.writeFileSync('blocked.txt','denied');write=false}catch(e){write=e.code}const child=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','inherit','inherit'],timeout:3000});console.log(JSON.stringify({read:fs.readFileSync('input.txt','utf8'),write,child:child.stdout,childError:child.stderr,spawnError:child.error?.code,status:child.status}));`;
      const result = await new CommandRunner(x.config).run(
          {
            command: process.execPath,
            args: ["-e", script],
            cwd: x.project.root,
            timeoutMs: 30000,
          },
          x.project.root,
        ),
        values = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        value = values.find((row) => row.read),
        childValue = values.find((row) => row.child);
      assert.equal(value.read, "source");
      assert.match(value.write, /EPERM|EACCES/);
      assert.ok(childValue, JSON.stringify({ values, result }));
      assert.match(childValue.child, /EPERM|EACCES/, result.stderr);
    } finally {
      await x.close();
    }
  },
);
