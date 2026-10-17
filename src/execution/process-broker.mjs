// A private, reconnectable process owner. Core control uses authenticated loopback RPC.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { timingSafeEqual, createHmac } from "node:crypto";

const configFile = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
fs.unlinkSync(configFile);
const directory = path.dirname(configFile);
const stateFile = path.join(directory, "state.json");
const logFile = path.join(directory, "output.json");
const save = (file, value) => {
  fs.writeFileSync(file + ".tmp", JSON.stringify(value), { mode: 0o600 });
  // Windows readers/antivirus may briefly deny replacement. Preserve the old atomic snapshot and retry.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(file + ".tmp", file);
      return;
    } catch (e) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(e.code) || attempt >= 30)
        throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
};
let state = {
  id: cfg.id,
  status: "starting",
  pid: undefined,
  brokerPid: process.pid,
  backend: cfg.pty ? "pty" : "pipes",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
let frames = [],
  seq = 0,
  buffered = 0,
  outputBytes = 0,
  stopping = false,
  settled = false,
  helperText = "";
let cleanupPromise;
const waiters = new Set();
process.on("uncaughtException", (e) => {
  fs.appendFileSync(
    path.join(directory, "broker-error.log"),
    String(e.stack || e) + "\n",
  );
  try {
    state.status = "failed";
    state.error = String(e.message || e);
    persist();
  } catch {}
  try {
    killTree();
  } catch {}
  process.exitCode = 1;
  server.close();
});
const decoders = {
  stdout: new StringDecoder("utf8"),
  stderr: new StringDecoder("utf8"),
};
const tails = { stdout: "", stderr: "" };
function scrub(text, stream, final = false) {
  let value = tails[stream] + text;
  for (const secret of cfg.secrets || [])
    if (secret) value = value.split(secret).join("[REDACTED]");
  let keep = 0;
  for (const secret of cfg.secrets || []) {
    for (
      let size = Math.min(secret.length - 1, value.length);
      size > keep;
      size--
    )
      if (value.endsWith(secret.slice(0, size))) {
        keep = size;
        break;
      }
  }
  tails[stream] = keep ? value.slice(-keep) : "";
  const visible = keep ? value.slice(0, -keep) : value;
  if (final) {
    tails[stream] = "";
    return visible + (keep ? "[REDACTED-PARTIAL]" : "");
  }
  return visible;
}
function persist() {
  state.updatedAt = new Date().toISOString();
  save(stateFile, state);
}
function wake() {
  for (const fn of [...waiters]) fn();
}
function output(data, stream) {
  const text = scrub(decoders[stream].write(data), stream);
  outputBytes += data.length;
  if (outputBytes > cfg.maxTotalOutputBytes) {
    stop("output-limit");
    return;
  }
  if (text) {
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 4096);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const part = text.slice(start, end);
      start = end;
      frames.push({ seq: ++seq, stream, text: part });
      buffered += Buffer.byteLength(part);
      while (buffered > cfg.maxBufferBytes && frames.length > 1)
        buffered -= Buffer.byteLength(frames.shift().text);
    }
    save(logFile, {
      frames,
      cursor: seq,
      firstCursor: frames[0]?.seq || seq + 1,
    });
    wake();
  }
}
async function finish(code, error) {
  if (settled) return;
  settled = true;
  clearTimeout(lifetime);
  // Natural helper failure must also revoke the OS grants; no orphaned runtime
  // can be called a completed process just because no stop request was sent.
  if (cfg.sandbox && cfg.cleanup && !cleanupPromise)
    cleanupPromise = cleanupExecution();
  const cleanup = await cleanupPromise;
  if (cfg.sandbox) {
    try {
      const sandbox = JSON.parse(fs.readFileSync(cfg.sandbox.state, "utf8"));
      if (
        sandbox.osSandbox !== true ||
        sandbox.cleanupConfirmed !== true ||
        sandbox.error
      )
        error ||= sandbox.error || "OS sandbox launch or cleanup unconfirmed";
      else state.osSandbox = true;
    } catch (e) {
      error ||= "OS sandbox state unavailable: " + e.message;
    }
  }
  for (const stream of ["stdout", "stderr"]) {
    const tail = scrub(decoders[stream].end(), stream, true);
    if (tail) {
      frames.push({ seq: ++seq, stream, text: tail });
    }
  }
  let retained = frames.reduce((n, f) => n + Buffer.byteLength(f.text), 0);
  while (retained > cfg.maxBufferBytes && frames.length > 1)
    retained -= Buffer.byteLength(frames.shift().text);
  save(logFile, {
    frames,
    cursor: seq,
    firstCursor: frames[0]?.seq || seq + 1,
  });
  state = {
    ...state,
    status:
      cleanup && !cleanup.confirmed
        ? "unknown"
        : error
          ? "failed"
          : stopping
            ? "stopped"
            : "exited",
    exitCode: code,
    error:
      cleanup && !cleanup.confirmed
        ? "Execution cleanup could not be confirmed: " + cleanup.error
        : error || state.error,
    endedAt: new Date().toISOString(),
  };
  persist();
  wake();
  // Remain briefly available for the final RPC, then leave the durable journal for reconnect/read.
  const timer = setTimeout(() => {
    server.close();
    for (const socket of sockets) socket.destroy();
  }, 1500);
  timer.unref();
}
function killTree() {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    spawn(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "taskkill.exe",
      ),
      ["/pid", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    ).on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
function cleanupExecution() {
  return (cleanupPromise ||= (async () => {
    const run = (args) =>
      new Promise((resolve) => {
        const cli = spawn(cfg.cleanup.command, args, {
          cwd: cfg.cwd,
          env: cfg.env,
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        cli.stderr.on(
          "data",
          (b) => (stderr = (stderr + b.toString()).slice(-8192)),
        );
        const timer = setTimeout(
          () => {
            cli.kill();
            resolve({ code: null, stderr: "Cleanup timeout" });
          },
          cfg.cleanup.mode === "appcontainer" ? 15000 : 4000,
        );
        cli.once("error", (e) => {
          clearTimeout(timer);
          resolve({ code: null, stderr: e.message });
        });
        cli.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stderr });
        });
      });
    const removed = await run(cfg.cleanup.args);
    if (removed.code === 0) return { confirmed: true };
    if (cfg.cleanup.mode === "appcontainer")
      return { confirmed: false, error: removed.stderr };
    const inspect = await run(["inspect", cfg.cleanup.args.at(-1)]);
    return {
      confirmed:
        inspect.code !== 0 &&
        /no such (object|container)/i.test(inspect.stderr),
      error: removed.stderr + " " + inspect.stderr,
    };
  })().catch((e) => ({ confirmed: false, error: e.message })));
}
async function stop(reason = "terminated") {
  if (stopping || settled) return;
  stopping = true;
  state.error = reason;
  persist();
  if (cfg.cleanup?.mode === "appcontainer") killTree();
  if (cfg.cleanup) cleanupPromise = cleanupExecution();
  if (cfg.pty) child.stdin.write(JSON.stringify({ op: "stop" }) + "\n");
  else killTree();
  const timer = setTimeout(killTree, 1000);
  timer.unref();
}
const sockets = new Set();
const seenNonces = new Map();
const mac = (value) =>
  createHmac("sha256", cfg.token).update(value).digest("hex");
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  let pending = "",
    handled = false;
  socket.setTimeout(35000, () => socket.destroy());
  socket.on("data", async (data) => {
    if (handled) return;
    pending += data.toString("utf8");
    if (pending.length > 100000) return socket.destroy();
    const end = pending.indexOf("\n");
    if (end < 0) return;
    handled = true;
    let cancelWait;
    let authenticated = false,
      nonce;
    const respond = (value) => {
      if (!authenticated)
        return socket.end(
          JSON.stringify({
            ok: false,
            error: "Unauthenticated process control",
          }) + "\n",
        );
      const payload = JSON.stringify({ ...value, nonce });
      socket.end(JSON.stringify({ payload, proof: mac(payload) }) + "\n");
    };
    try {
      const req = JSON.parse(pending.slice(0, end));
      const { proof, ...signed } = req;
      const expected = Buffer.from(mac(JSON.stringify(signed)), "hex"),
        given = Buffer.from(String(proof || ""), "hex");
      if (given.length !== expected.length || !timingSafeEqual(given, expected))
        throw Error("Unauthenticated process control");
      if (
        typeof req.nonce !== "string" ||
        req.nonce.length !== 32 ||
        !Number.isSafeInteger(req.issuedAt) ||
        Math.abs(Date.now() - req.issuedAt) > 30000 ||
        seenNonces.has(req.nonce)
      )
        throw Error("Expired or replayed process control");
      for (const [key, time] of seenNonces)
        if (Date.now() - time > 60000) seenNonces.delete(key);
      if (seenNonces.size >= 4096)
        throw Error("Process request capacity exceeded");
      seenNonces.set(req.nonce, Date.now());
      authenticated = true;
      nonce = req.nonce;
      let result;
      if (req.op === "read") {
        if (!Number.isSafeInteger(req.cursor) || req.cursor < 0)
          throw Error("Invalid output cursor");
        if (req.waitMs && !settled && seq <= req.cursor)
          await new Promise((resolve) => {
            let timer;
            const done = () => {
              clearTimeout(timer);
              waiters.delete(done);
              resolve();
            };
            cancelWait = done;
            waiters.add(done);
            socket.once("close", done);
            timer = setTimeout(done, Math.min(30000, Math.max(0, req.waitMs)));
          });
        result = {
          state,
          frames: frames.filter((f) => f.seq > req.cursor),
          cursor: seq,
          truncated: req.cursor < (frames[0]?.seq || seq + 1) - 1,
        };
      } else if (req.op === "write") {
        if (settled || stopping) throw Error("Process is not running");
        const bytes = Buffer.from(req.data, "base64");
        if (bytes.length > 65536) throw Error("Input limit exceeded");
        await new Promise((resolve, reject) =>
          child.stdin.write(
            cfg.pty
              ? JSON.stringify({ op: "write", data: req.data }) + "\n"
              : bytes,
            (e) => (e ? reject(e) : resolve()),
          ),
        );
        result = { acceptedBytes: bytes.length };
      } else if (req.op === "resize") {
        if (
          !cfg.pty ||
          settled ||
          stopping ||
          !Number.isInteger(req.cols) ||
          !Number.isInteger(req.rows) ||
          req.cols < 2 ||
          req.cols > 500 ||
          req.rows < 2 ||
          req.rows > 300
        )
          throw Error("Invalid terminal resize");
        child.stdin.write(
          JSON.stringify({ op: "resize", cols: req.cols, rows: req.rows }) +
            "\n",
        );
        result = { cols: req.cols, rows: req.rows };
      } else if (req.op === "stop") {
        await stop();
        result = { stopping: true };
      } else if (req.op === "status") result = state;
      else throw Error("Unknown process operation");
      respond({ ok: true, result });
    } catch (e) {
      respond({ ok: false, error: String(e.message || e) });
    } finally {
      cancelWait?.();
    }
  });
});
// The broker starts no program until its private control socket exists.
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
state.port = server.address().port;
persist();
const child = spawn(
  cfg.pty ? cfg.helper.command : cfg.command,
  cfg.pty ? cfg.helper.args : cfg.args,
  {
    cwd: cfg.cwd,
    env: cfg.env,
    windowsHide: true,
    detached: process.platform !== "win32" || cfg.ownerMonitored === true,
    stdio: ["pipe", "pipe", "pipe"],
  },
);
child.stdin.on("error", () => {});
const lifetime = setTimeout(() => stop("lifetime-limit"), cfg.timeoutMs);
function markRunning(pid, backend) {
  if (!cfg.sandbox) {
    state = { ...state, status: "running", pid, backend };
    persist();
    wake();
    return;
  }
  const check = () => {
    try {
      const sandbox = JSON.parse(fs.readFileSync(cfg.sandbox.state, "utf8"));
      if (sandbox.error) {
        state.error = sandbox.error;
        persist();
        return false;
      }
      if (sandbox.osSandbox === true) {
        state = {
          ...state,
          status: "running",
          pid: sandbox.pid,
          backend: cfg.pty
            ? "windows-appcontainer-conpty"
            : "windows-appcontainer-pipes",
          osSandbox: true,
        };
        persist();
        wake();
        return false;
      }
    } catch {}
    return !settled && !stopping;
  };
  if (check()) {
    const pending = setInterval(() => {
      if (!check()) clearInterval(pending);
    }, 20);
    pending.unref();
  }
}
if (cfg.pty) {
  child.stdout.on("data", (data) => {
    helperText += data.toString("utf8");
    if (helperText.length > 1000000) {
      stop("invalid-helper-output");
      return;
    }
    let end;
    while ((end = helperText.indexOf("\n")) >= 0) {
      const line = helperText.slice(0, end);
      helperText = helperText.slice(end + 1);
      try {
        const msg = JSON.parse(line.replace(/^\uFEFF/, ""));
        if (msg.type === "ready") {
          markRunning(msg.pid, msg.backend);
        } else if (msg.type === "data")
          output(Buffer.from(msg.data, "base64"), "stdout");
        else if (msg.type === "exit") finish(msg.exitCode);
        else if (msg.type === "error") {
          state.error = msg.error;
          persist();
        }
      } catch (e) {
        state.error = "Invalid PTY frame: " + e.message;
        stop(state.error);
      }
    }
  });
  child.stdin.write(
    JSON.stringify({
      command: cfg.command,
      args: cfg.args,
      cwd: cfg.cwd,
      cols: cfg.cols,
      rows: cfg.rows,
      memoryMb: cfg.memoryMb,
      pidsLimit: cfg.pidsLimit,
    }) + "\n",
  );
} else {
  child.once("spawn", () => {
    markRunning(child.pid, "pipes");
  });
  child.stdout.on("data", (data) => output(data, "stdout"));
}
child.stderr.on("data", (data) => output(data, "stderr"));
child.once("error", (e) => finish(null, e.message));
child.once("close", (code) =>
  finish(code, state.error && !stopping ? state.error : undefined),
);
process.on("SIGTERM", () => stop("broker-terminated"));
process.on("SIGINT", () => stop("broker-interrupted"));
