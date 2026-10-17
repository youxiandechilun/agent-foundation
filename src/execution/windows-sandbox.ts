import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rename,
  rm,
  stat,
  readdir,
  realpath,
} from "node:fs/promises";
import type { Config } from "../config.js";
import { hash, invariant, within } from "../util.js";
import {
  nativeProcess,
  processEnvironment,
  type PreparedCommand,
} from "./process.js";

export interface WindowsSandboxRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  grants: { path: string; readOnly: boolean }[];
  env?: Record<string, string>;
  network?: boolean;
}
const compilers = new Map<string, Promise<string>>();
export async function windowsSandboxHelper(config: Config) {
  invariant(
    process.platform === "win32",
    "Windows AppContainer isolation is unavailable on this platform",
    503,
    "isolation_unavailable",
  );
  const source = fileURLToPath(
    new URL("./native/AppContainerHost.cs", import.meta.url),
  );
  const content = await readFile(source),
    directory = path.join(config.dataDir, "native"),
    key = path.join(
      directory,
      "appcontainer-" + hash(content).slice(0, 24) + ".exe",
    );
  if (!compilers.has(key))
    compilers.set(
      key,
      (async () => {
        await mkdir(directory, { recursive: true });
        try {
          if ((await stat(key)).isFile()) return key;
        } catch {}
        const temporary = key + "." + crypto.randomUUID() + ".exe";
        try {
          const compiler = path.join(
            process.env.SystemRoot || "C:\\Windows",
            "Microsoft.NET",
            "Framework64",
            "v4.0.30319",
            "csc.exe",
          );
          const result = await nativeProcess({
            command: compiler,
            args: [
              "/nologo",
              "/r:System.Web.Extensions.dll",
              "/out:" + temporary,
              source,
            ],
            cwd: directory,
            timeoutMs: 30000,
            maxOutputBytes: 32000,
          });
          invariant(
            result.exitCode === 0,
            "Windows sandbox source compilation failed: " +
              result.stdout +
              result.stderr,
            503,
            "isolation_unavailable",
          );
          try {
            await rename(temporary, key);
          } catch (error) {
            try {
              await stat(key);
            } catch {
              throw error;
            }
          }
          return key;
        } finally {
          await rm(temporary, { force: true });
        }
      })().catch((error) => {
        compilers.delete(key);
        throw error;
      }),
    );
  return compilers.get(key)!;
}
async function executable(command: string, cwd: string) {
  invariant(
    command.length > 0 && !/[\0\r\n]/.test(command),
    "Invalid sandbox executable",
  );
  const direct =
    path.isAbsolute(command) || command.includes("\\") || command.includes("/");
  const candidates = direct
    ? [path.resolve(cwd, command)]
    : [
        cwd,
        ...(process.env.PATH || process.env.Path || "").split(path.delimiter),
      ]
        .filter(Boolean)
        .map((root) => path.join(root, command));
  for (const candidate of candidates)
    for (const file of path.extname(candidate)
      ? [candidate]
      : [candidate + ".exe", candidate]) {
      try {
        const actual = await realpath(file),
          info = await stat(actual);
        if (info.isFile()) {
          invariant(
            path.extname(actual).toLowerCase() === ".exe",
            "Sandbox requires an executable; invoke cmd.exe explicitly for batch scripts",
          );
          return actual;
        }
      } catch (error) {
        if (
          !["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code || "",
          )
        )
          throw error;
      }
    }
  invariant(
    false,
    "Sandbox executable was not found",
    503,
    "isolation_unavailable",
  );
}
export async function prepareWindowsSandbox(
  config: Config,
  request: WindowsSandboxRequest,
): Promise<PreparedCommand> {
  const helper = await windowsSandboxHelper(config);
  invariant(
    request.args.length <= 200 &&
      request.args.every(
        (value) => typeof value === "string" && !value.includes("\0"),
      ),
    "Invalid sandbox arguments",
  );
  invariant(
    !request.network ||
      (config.execution.windowsSandbox.network === "internet" &&
        config.permissions.network !== "deny"),
    "Windows sandbox network is disabled by host policy",
    403,
  );
  const original = await executable(request.command, request.cwd),
    exeInfo = await stat(original);
  invariant(
    exeInfo.size <= config.execution.windowsSandbox.maxRuntimeBytes,
    "Sandbox executable exceeds runtime budget",
    413,
  );
  const root = path.join(config.dataDir, "sandboxes"),
    token = crypto.randomUUID().replaceAll("-", ""),
    directory = path.join(root, token),
    runtime = path.join(directory, "runtime"),
    binary = path.join(runtime, "bin"),
    scratch = path.join(runtime, "scratch");
  await mkdir(binary, { recursive: true });
  await mkdir(scratch, { recursive: true });
  const target = path.join(binary, path.basename(original)),
    manifest = path.join(directory, "manifest.json"),
    requestFile = path.join(directory, "request.json");
  try {
    const kernelState = await realpath(config.dataDir);
    await copyFile(original, target);
    const nodeGuard = path.join(binary, "foundation-node-guard.cjs");
    const nodeRuntime =
      path.basename(original).toLowerCase() === "node.exe" ||
      original.toLowerCase() === process.execPath.toLowerCase();
    if (nodeRuntime)
      await copyFile(
        new URL("./native/node-appcontainer-guard.cjs", import.meta.url),
        nodeGuard,
      );
    if (nodeRuntime)
      await writeFile(path.join(binary, "package.json"), '{"type":"commonjs"}');
    const grants: { path: string; readOnly: boolean }[] = [];
    for (const input of [
      ...request.grants,
      ...config.execution.windowsSandbox.readOnlyRoots.map((root) => ({
        path: root,
        readOnly: true,
      })),
    ]) {
      const actual = await realpath(input.path),
        info = await stat(actual);
      invariant(
        actual !== path.parse(actual).root,
        "A whole filesystem drive cannot be granted to the sandbox",
        403,
      );
      invariant(
        !within(actual, kernelState),
        "Sandbox grant would expose kernel state; select a separate project root",
        403,
      );
      const previous = grants.find(
        (g) => g.path.toLowerCase() === actual.toLowerCase(),
      );
      if (previous) previous.readOnly &&= input.readOnly;
      else grants.push({ path: actual, readOnly: input.readOnly });
      invariant(
        info.isDirectory() || info.isFile(),
        "Sandbox grant is not a regular filesystem entry",
      );
    }
    grants.push(
      { path: binary, readOnly: true },
      { path: scratch, readOnly: false },
    );
    const env: Record<string, string> = {};
    for (const name of [
      "SystemRoot",
      "WINDIR",
      "USERPROFILE",
      "LOCALAPPDATA",
      "APPDATA",
      "SystemDrive",
      "LANG",
    ])
      if (process.env[name]) env[name] = process.env[name]!;
    env.PATH = [
      binary,
      ...config.execution.windowsSandbox.readOnlyRoots,
      path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
    ].join(path.delimiter);
    env.TEMP = scratch;
    env.TMP = scratch;
    env.HOME = scratch;
    for (const [name, value] of Object.entries(request.env || {})) {
      invariant(
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !value.includes("\0"),
        "Invalid sandbox environment",
      );
      env[name] = value;
    }
    if (nodeRuntime) {
      const option =
        "--preserve-symlinks --preserve-symlinks-main --require=" +
        JSON.stringify(nodeGuard.replaceAll("\\", "/"));
      env.NODE_OPTIONS =
        option + (env.NODE_OPTIONS ? " " + env.NODE_OPTIONS : "");
    }
    const profile = "foundation.agent." + token;
    await writeFile(
      manifest,
      JSON.stringify({
        id: token,
        profile,
        job: "Local\\Foundation.Agent." + profile,
        grants,
        createdAt: new Date().toISOString(),
      }),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      requestFile,
      JSON.stringify({
        command: target,
        args: request.args,
        cwd: await realpath(request.cwd),
        env,
        network: request.network ? "internet" : "none",
        memoryMb: config.execution.memoryMb,
        pidsLimit: config.execution.pidsLimit,
        cpus: config.execution.cpus,
      }),
      { flag: "wx", mode: 0o600 },
    );
    return {
      command: helper,
      args: ["launch", manifest, requestFile],
      cwd: directory,
      timeoutMs: request.timeoutMs,
      ownerMonitored: true,
      env: processEnvironment(),
      boundary: "windows-appcontainer",
      cleanup: {
        command: helper,
        args: ["cleanup", manifest],
        mode: "appcontainer",
      },
      sandbox: {
        id: token,
        manifest,
        state: path.join(directory, "state.json"),
        workspace: request.cwd,
        network: request.network ? "internet" : "none",
      },
    };
  } catch (error) {
    invariant(within(root, directory), "Invalid sandbox cleanup path");
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
/** Only inactive helper instances are recovered. Preserved live brokers keep their own job/profile. */
export async function recoverWindowsSandboxes(config: Config) {
  if (process.platform !== "win32") return [];
  let entries;
  try {
    entries = await readdir(path.join(config.dataDir, "sandboxes"), {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const output = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const directory = path.join(config.dataDir, "sandboxes", entry.name),
      manifest = path.join(directory, "manifest.json");
    try {
      const state = JSON.parse(
        await readFile(path.join(directory, "state.json"), "utf8").catch(
          () => "{}",
        ),
      );
      if (state.cleanupConfirmed === true) continue;
      const helper = await windowsSandboxHelper(config),
        result = await nativeProcess({
          command: helper,
          args: ["recover", manifest],
          cwd: directory,
          timeoutMs: 30000,
        });
      const after = JSON.parse(
        await readFile(path.join(directory, "state.json"), "utf8"),
      );
      output.push({
        id: entry.name,
        confirmed: result.exitCode === 0 && after.cleanupConfirmed === true,
        preservedLiveOwner:
          result.exitCode === 0 && after.cleanupConfirmed !== true,
        error: result.exitCode === 0 ? undefined : result.stderr,
      });
    } catch (error) {
      output.push({
        id: entry.name,
        confirmed: false,
        error: String((error as Error).message),
      });
    }
  }
  return output;
}
