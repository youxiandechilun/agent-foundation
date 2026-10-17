import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, until } from "./support/wire-server.js";
import { Kernel } from "../src/kernel.js";

async function output(x: any, pid: string, sid: string, pattern: RegExp) {
  return until(async () => {
    const r = await x.kernel.processes.read(pid, sid);
    return pattern.test(r.frames.map((f: any) => f.text).join(""))
      ? r
      : undefined;
  }, 15000);
}
test("persistent pipe processes accept input across calls, preserve cursors and enforce session ownership", async () => {
  const x = await setup();
  try {
    const s = await x.session("code"),
      other = await x.session("code");
    const p = await x.kernel.processes.start(s.id, {
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('ready\\n');require('node:readline').createInterface({input:process.stdin}).on('line',s=>{console.log('echo:'+s);if(s==='quit')process.exit(0)})",
      ],
    });
    await output(x, p.id, s.id, /ready/);
    const first = await x.kernel.processes.read(p.id, s.id);
    await assert.rejects(
      () => x.kernel.processes.write(p.id, other.id, "forbidden\n"),
      /another session/,
    );
    await x.kernel.processes.write(p.id, s.id, "真实中文 🧠\n");
    const next = await output(x, p.id, s.id, /echo:真实中文 🧠/);
    assert.ok(next.cursor > first.cursor);
    const after = await x.kernel.processes.read(p.id, s.id, first.cursor);
    assert.ok(after.frames.every((f: any) => f.seq > first.cursor));
    assert.ok(
      !after.frames
        .map((f: any) => f.text)
        .join("")
        .includes("ready"),
    );
    await x.kernel.processes.write(p.id, s.id, "quit\n");
    await until(async () => {
      const r = await x.kernel.processes.status(p.id, s.id);
      return r.status === "exited" ? r : undefined;
    });
    await assert.rejects(
      () => x.kernel.processes.write(p.id, s.id, "late\n"),
      /not running|ECONNREFUSED/,
    );
  } finally {
    await x.close();
  }
});

test("real PTY exposes a terminal, accepts raw input and applies window resizing", async () => {
  const x = await setup();
  try {
    const s = await x.session("code");
    const script =
      "console.log(JSON.stringify({tty:!!process.stdin.isTTY,cols:process.stdout.columns,rows:process.stdout.rows}));process.stdin.setRawMode(true);process.stdin.resume();process.stdout.on('resize',()=>console.log('size:'+process.stdout.columns+'x'+process.stdout.rows));process.stdin.on('data',b=>{console.log('input:'+b.toString());if(b.toString().includes('quit'))process.exit(0)})";
    const p = await x.kernel.processes.start(s.id, {
      command: process.execPath,
      args: ["-e", script],
      pty: true,
      cols: 91,
      rows: 27,
    });
    const ready = await output(x, p.id, s.id, /"tty":true/);
    assert.match(ready.frames.map((f: any) => f.text).join(""), /"cols":91/);
    await x.kernel.processes.resize(p.id, s.id, 113, 41);
    await output(x, p.id, s.id, /size:113x41/);
    await x.kernel.processes.write(p.id, s.id, "terminal-input");
    await output(x, p.id, s.id, /input:terminal-input/);
    await x.kernel.processes.write(p.id, s.id, "quit");
    const final = await until(async () => {
      const r = await x.kernel.processes.status(p.id, s.id);
      return r.status === "exited" ? r : undefined;
    });
    assert.equal(final.exitCode, 0);
  } finally {
    await x.close();
  }
});

test("process brokers reconnect after kernel restart without rerunning commands", async () => {
  const x = await setup(undefined, {
    execution: { processShutdown: "preserve" },
  });
  let resumed: Kernel | undefined;
  try {
    const s = await x.session("code");
    const p = await x.kernel.processes.start(s.id, {
      command: process.execPath,
      args: [
        "-e",
        "console.log('once');process.stdin.on('data',b=>console.log('continued:'+b.toString()));setInterval(()=>{},1000)",
      ],
    });
    await output(x, p.id, s.id, /once/);
    await x.api.close();
    resumed = new Kernel(x.config);
    await resumed.init();
    assert.equal(
      (await resumed.processes.status(p.id, s.id)).status,
      "running",
    );
    await resumed.processes.write(p.id, s.id, "after-restart");
    const r = await until(async () => {
      const r = await resumed!.processes.read(p.id, s.id);
      return r.frames
        .map((f: any) => f.text)
        .join("")
        .includes("continued:after-restart")
        ? r
        : undefined;
    });
    assert.equal(
      r.frames
        .map((f: any) => f.text)
        .join("")
        .match(/once/g)?.length,
      1,
    );
    await resumed.processes.stop(p.id, s.id);
  } finally {
    await resumed?.close();
    await x.wire.close();
  }
});

test("persistent processes enforce lifetime, output retention and global process capacity", async () => {
  const x = await setup(undefined, {
    execution: {
      maxProcesses: 1,
      processBufferBytes: 16384,
      processLifetimeMs: 1500,
    },
  });
  try {
    const s = await x.session("code");
    const p = await x.kernel.processes.start(s.id, {
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(30000));setInterval(()=>console.log('tail'),100)",
      ],
    });
    await assert.rejects(
      () =>
        x.kernel.processes.start(s.id, {
          command: process.execPath,
          args: ["-e", ""],
        }),
      /capacity/,
    );
    const r = await until(async () => {
      const r = await x.kernel.processes.read(p.id, s.id);
      return r.truncated ? r : undefined;
    });
    assert.ok(r.cursor > 0);
    assert.ok(
      Buffer.byteLength(r.frames.map((f: any) => f.text).join("")) <= 16384,
    );
    const final = await until(async () => {
      const r = await x.kernel.processes.status(p.id, s.id);
      return r.status === "stopped" ? r : undefined;
    });
    assert.equal(final.error, "lifetime-limit");
  } finally {
    await x.close();
  }
});

test("stopping a managed process terminates its actual child tree", async () => {
  const x = await setup();
  let childPid: number | undefined;
  try {
    const s = await x.session("code");
    const script =
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log('child:'+c.pid);setInterval(()=>{},1000)";
    const p = await x.kernel.processes.start(s.id, {
      command: process.execPath,
      args: ["-e", script],
    });
    const ready = await output(x, p.id, s.id, /child:\d+/);
    childPid = Number(
      ready.frames
        .map((f: any) => f.text)
        .join("")
        .match(/child:(\d+)/)![1],
    );
    process.kill(childPid, 0);
    await x.kernel.processes.stop(p.id, s.id);
    await until(() => {
      try {
        process.kill(childPid!, 0);
        return undefined;
      } catch {
        return true;
      }
    });
  } finally {
    if (childPid)
      try {
        process.kill(childPid);
      } catch {}
    await x.close();
  }
});

test("cancelled process startup cannot leave a running managed process", async () => {
  const x = await setup();
  try {
    const s = await x.session("code"),
      c = new AbortController();
    const pending = x.kernel.processes.start(
      s.id,
      {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        pty: true,
      },
      c.signal,
    );
    setTimeout(() => c.abort(Error("cancel-process-start")), 20);
    await assert.rejects(() => pending, /cancel-process-start/);
    assert.ok(
      (await x.kernel.processes.list(s.id)).every(
        (p) => !["starting", "running"].includes(p.status),
      ),
    );
  } finally {
    await x.close();
  }
});
