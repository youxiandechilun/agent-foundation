import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Config } from "../core/config.js";
import { invariant } from "../core/util.js";
import { realpath } from "node:fs/promises";
import { safePath } from "../core/util.js";

/** All command entry points share the same network permission declaration. */
export function executionCapabilities(config: Config): ("exec" | "network")[] {
  return (config.execution.boundary === "docker" &&
    config.execution.dockerNetwork) ||
    (config.execution.boundary === "windows-appcontainer" &&
      config.execution.windowsSandbox.network === "internet")
    ? ["exec", "network"]
    : ["exec"];
}

export function processEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LANG",
  ])
    if (process.env[name]) env[name] = process.env[name];
  return env;
}
/** libuv >=1.53 can pass Node pipe handles into an AppContainer child. */
export function nodePipeCompatibility() {
  const [major, minor] = process.versions.uv.split(".").map(Number);
  return major > 1 || minor >= 53
    ? "native-runtime"
    : "inherited-or-file-stdio-only";
}
export interface PreparedCommand extends Command {
  env: NodeJS.ProcessEnv;
  boundary: "native" | "docker" | "windows-appcontainer";
  cleanup?: { command: string; args: string[]; mode?: "appcontainer" };
  sandbox?: {
    id: string;
    manifest: string;
    state: string;
    workspace: string;
    network: "none" | "internet";
  };
}
/** Docker arguments are generated only by trusted host configuration. No native fallback. */
export async function prepareCommand(
  config: Config,
  request: Command,
  root: string,
  tty = false,
): Promise<PreparedCommand> {
  invariant(
    request.command.length > 0 &&
      !request.command.includes("\0") &&
      request.args.length <= 100 &&
      request.args.every((a) => typeof a === "string" && !a.includes("\0")),
    "Invalid process command",
  );
  const actualRoot = await realpath(root),
    cwd = await safePath(actualRoot, path.relative(actualRoot, request.cwd));
  if (config.execution.boundary === "windows-appcontainer") {
    invariant(
      !tty,
      "Windows AppContainer currently supports pipes; isolated PTY is unavailable and will not fall back to native",
      503,
      "isolation_feature_unavailable",
    );
    invariant(
      config.permissions["files.read"] !== "deny",
      "Isolated command workspace reads are disabled",
      403,
    );
    const { prepareWindowsSandbox } = await import("./windows-sandbox.js");
    return prepareWindowsSandbox(config, {
      ...request,
      cwd,
      grants: [
        {
          path: actualRoot,
          readOnly:
            config.execution.workspaceReadOnly ||
            config.permissions["files.write"] === "deny",
        },
      ],
      network: config.execution.windowsSandbox.network === "internet",
    });
  }
  if (config.execution.boundary === "native") {
    invariant(
      !config.execution.requireIsolation,
      "Native execution prohibited by isolation policy",
      403,
    );
    return { ...request, cwd, env: processEnvironment(), boundary: "native" };
  }
  const e = config.execution;
  invariant(
    !e.requireIsolation ||
      (e.readOnlyRoot &&
        e.dockerUser
          .split(":")
          .every((n) => Number(n) > 0 && Number(n) <= 4294967294)),
    "Required isolation needs a non-root user and read-only root",
    403,
    "isolation_required",
  );
  invariant(
    !actualRoot.includes(","),
    "Docker workspace paths containing comma are unsupported",
  );
  invariant(
    /^[A-Za-z0-9][A-Za-z0-9._/:@-]+$/.test(e.dockerImage),
    "Invalid container image reference",
  );
  const relative = path.relative(actualRoot, cwd).replaceAll("\\", "/");
  const container = "foundation-" + crypto.randomUUID();
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    container,
    "--init",
    "--interactive",
    ...(tty ? ["--tty"] : []),
    "--user",
    e.dockerUser,
    "--memory",
    e.memoryMb + "m",
    "--memory-swap",
    e.memoryMb + "m",
    "--cpus",
    String(e.cpus),
    "--pids-limit",
    String(e.pidsLimit),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    e.dockerNetwork ? "bridge" : "none",
    "--mount",
    `type=bind,source=${actualRoot},target=/workspace${e.workspaceReadOnly ? ",readonly" : ""}`,
    "--workdir",
    `/workspace/${relative}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    ...(e.readOnlyRoot ? ["--read-only"] : []),
    e.dockerImage,
    request.command,
    ...request.args,
  ];
  return {
    ...request,
    command: "docker",
    args,
    cwd: actualRoot,
    env: processEnvironment(),
    boundary: "docker",
    cleanup: { command: "docker", args: ["rm", "--force", container] },
  };
}

export interface Command {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  /** Trusted sandbox launcher watches its parent and must survive long enough to revoke grants. */
  ownerMonitored?: boolean;
}
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  boundary: "native" | "docker" | "windows-appcontainer";
}
export function nativeProcess(
  request: Command,
  signal?: AbortSignal,
  output?: (text: string, stream: "stdout" | "stderr") => void,
): Promise<CommandResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = processEnvironment();
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32" || request.ownerMonitored === true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      failure: string | undefined,
      settled = false;
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const executable = path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "taskkill.exe",
        );
        spawn(executable, ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        }).on("error", () => child.kill());
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const abort = () => {
      failure = "Command cancelled";
      kill();
    };
    const timer = setTimeout(() => {
      failure = "Command timed out";
      kill();
    }, request.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const onData = (chunk: Buffer, stream: "stdout" | "stderr") => {
      bytes += chunk.length;
      if (bytes > (request.maxOutputBytes || 128000)) {
        failure = "Command output limit exceeded";
        kill();
        return;
      }
      const value = decoders[stream].write(chunk);
      if (stream === "stdout") stdout += value;
      else stderr += value;
      output?.(value, stream);
    };
    child.stdout.on("data", (data) => onData(data, "stdout"));
    child.stderr.on("data", (data) => onData(data, "stderr"));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      const finalOut = decoders.stdout.end(),
        finalErr = decoders.stderr.end();
      stdout += finalOut;
      stderr += finalErr;
      if (finalOut) output?.(finalOut, "stdout");
      if (finalErr) output?.(finalErr, "stderr");
      if (failure)
        reject(Object.assign(new Error(failure), { stdout, stderr, exitCode }));
      else resolve({ exitCode, stdout, stderr, boundary: "native" });
    });
  });
}
export class CommandRunner {
  private closing = false;
  private pending = new Map<AbortController, Promise<CommandResult>>();
  constructor(readonly config: Config) {}
  async run(
    request: Command,
    root: string,
    signal?: AbortSignal,
    output?: (text: string, stream: "stdout" | "stderr") => void,
  ): Promise<CommandResult> {
    invariant(!this.closing, "Command runner is closed", 503);
    signal?.throwIfAborted();
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const operation = this.runOnce(request, root, combined, output);
    this.pending.set(controller, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(controller);
    }
  }
  async close() {
    this.closing = true;
    for (const controller of this.pending.keys())
      controller.abort(new Error("Kernel command runner closed"));
    const results = await Promise.allSettled([...this.pending.values()]);
    const failures = results
      .filter((r) => r.status === "rejected")
      .filter((r) => r.reason?.code === "isolation_cleanup_failed");
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        "Command sandbox cleanup unconfirmed",
      );
  }
  private async runOnce(
    request: Command,
    root: string,
    signal: AbortSignal,
    output?: (text: string, stream: "stdout" | "stderr") => void,
  ): Promise<CommandResult> {
    const prepared = await prepareCommand(this.config, request, root);
    const stop = async () => {
      if (prepared.cleanup) {
        const result = await nativeProcess({
          ...prepared.cleanup,
          cwd: prepared.cwd,
          timeoutMs: prepared.cleanup.mode === "appcontainer" ? 30000 : 5000,
        });
        if (prepared.cleanup.mode === "appcontainer")
          invariant(
            result.exitCode === 0,
            "Windows sandbox cleanup unconfirmed: " + result.stderr,
            503,
            "isolation_cleanup_failed",
          );
        return result;
      }
    };
    const onAbort = () => {
      void stop().catch(() => undefined);
    };
    if (prepared.cleanup?.mode !== "appcontainer")
      signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await nativeProcess(
        { ...prepared, maxOutputBytes: this.config.limits.maxOutputBytes },
        signal,
        output,
      );
      if (prepared.sandbox) {
        const { readFile } = await import("node:fs/promises");
        const state = JSON.parse(
          await readFile(prepared.sandbox.state, "utf8").catch(() =>
            JSON.stringify({
              error: "Sandbox did not publish verified state: " + result.stderr,
            }),
          ),
        );
        invariant(
          state.osSandbox === true &&
            state.cleanupConfirmed === true &&
            !state.error,
          "Windows sandbox launch or cleanup failed: " +
            (state.error || result.stderr),
          503,
          "isolation_unavailable",
        );
      }
      return { ...result, boundary: prepared.boundary };
    } catch (error) {
      try {
        await stop();
      } catch (cleanupError) {
        throw Object.assign(
          new AggregateError(
            [error, cleanupError],
            "Command failed and execution cleanup unconfirmed",
          ),
          { code: "isolation_cleanup_failed" },
        );
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  /** Explicit environment probe for deployment validation. Does not pull images. */
  async probe(root: string) {
    if (this.config.execution.boundary === "native")
      return { available: true, boundary: "native", osSandbox: false };
    if (this.config.execution.boundary === "windows-appcontainer") {
      const result = await this.run(
        {
          command: process.execPath,
          args: ["-e", "process.stdout.write('appcontainer-ready')"],
          cwd: root,
          timeoutMs: 30000,
        },
        root,
      );
      invariant(
        result.exitCode === 0 && result.stdout === "appcontainer-ready",
        "Windows sandbox runtime probe failed",
        503,
        "isolation_unavailable",
      );
      return {
        available: true,
        boundary: "windows-appcontainer",
        osSandbox: true,
        network: this.config.execution.windowsSandbox.network,
        persistentPipes: true,
        pty: false,
        nodePipeCompatibility: nodePipeCompatibility(),
      };
    }
    const response = await nativeProcess({
      command: "docker",
      args: ["info", "--format", "{{.OSType}}"],
      cwd: root,
      timeoutMs: 10000,
    });
    invariant(
      response.exitCode === 0 && response.stdout.trim() === "linux",
      "A Linux Docker engine is required",
      503,
      "isolation_unavailable",
    );
    return { available: true, boundary: "docker", osSandbox: true };
  }
}
