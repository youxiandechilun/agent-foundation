import { spawn } from "node:child_process";
import { realpath, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../core/config.js";
import { invariant, within } from "../core/util.js";
import { processEnvironment } from "./process.js";
import { terminateProcessTree } from "./lifecycle.js";

export interface ExtensionHostRequest {
  command: string;
  args: string[];
  cwd: string;
  mounts: { source: string; target: string; readOnly: boolean }[];
  workdir: string;
  env: Record<string, string>;
  network: boolean;
}
export interface ExtensionHost {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  boundary: "docker" | "windows-appcontainer";
  ownerMonitored?: boolean;
  cleanup: () => Promise<void>;
}
export async function reviewedWorkspace(config: Config, root: string) {
  const actual = await realpath(root);
  const allowed = await Promise.all(
    [...config.workspaceRoots, ...config.extensions.allowedRoots].map((r) =>
      realpath(r),
    ),
  );
  invariant(
    allowed.some((r) => within(r, actual)),
    "Extension workspace outside configured roots",
    403,
  );
  return actual;
}
/** Host-generated container arguments. No installation, image pulls, socket mounts or native fallback. */
export async function prepareExtensionHost(
  config: Config,
  request: ExtensionHostRequest,
  boundary: "docker" | "windows-appcontainer" = "docker",
): Promise<ExtensionHost> {
  if (boundary === "windows-appcontainer") {
    const sources = new Map<string, string>();
    for (const mount of request.mounts) {
      invariant(
        /^\/(?:workspace|plugin|runtime)$/.test(mount.target) &&
          !sources.has(mount.target),
        "Invalid isolated mount target",
      );
      sources.set(mount.target, await realpath(mount.source));
    }
    invariant(
      sources.has(request.workdir),
      "Isolated workdir needs an approved mount",
    );
    const map = (value: string) => {
      for (const [target, source] of sources)
        if (value === target || value.startsWith(target + "/"))
          return path.join(source, value.slice(target.length));
      return value;
    };
    const { prepareWindowsSandbox } = await import("./windows-sandbox.js");
    const prepared = await prepareWindowsSandbox(config, {
      command: request.command,
      args: request.args.map(map),
      cwd: sources.get(request.workdir)!,
      timeoutMs: config.extensions.timeoutMs,
      grants: request.mounts.map((m) => ({
        path: m.source,
        readOnly: m.readOnly,
      })),
      env: request.env,
      network: request.network,
    });
    return {
      ...prepared,
      boundary: "windows-appcontainer",
      cleanup: async () => {
        const { nativeProcess } = await import("./process.js");
        const result = await nativeProcess({
          ...prepared.cleanup!,
          cwd: prepared.cwd,
          timeoutMs: 30000,
        });
        invariant(
          result.exitCode === 0,
          "Windows extension cleanup unconfirmed: " + result.stderr,
          503,
          "isolation_cleanup_failed",
        );
      },
    };
  }
  const e = config.execution;
  invariant(
    e.readOnlyRoot &&
      e.dockerUser
        .split(":")
        .every((v) => Number(v) > 0 && Number(v) <= 4294967294),
    "Extension isolation requires read-only root and a non-root container user",
    403,
    "isolation_required",
  );
  invariant(
    /^[A-Za-z0-9][A-Za-z0-9._/:@-]+$/.test(e.dockerImage),
    "Invalid container image",
  );
  invariant(
    request.command &&
      !request.command.includes("\0") &&
      !/^[A-Za-z]:[\\/]/.test(request.command),
    "Container command must use a container executable path",
  );
  invariant(
    request.args.length <= 200 && request.args.every((a) => !a.includes("\0")),
    "Invalid container arguments",
  );
  invariant(
    !request.network || e.dockerNetwork,
    "Container network is disabled by host policy",
    403,
  );
  const mounts: string[] = [],
    targets = new Set<string>();
  for (const item of request.mounts) {
    invariant(
      /^\/(?:workspace|plugin|runtime)$/.test(item.target) &&
        !targets.has(item.target),
      "Invalid isolated mount target",
    );
    targets.add(item.target);
    const source = await realpath(item.source);
    invariant(!/[,\r\n]/.test(source), "Unsupported isolated source path");
    mounts.push(
      "--mount",
      `type=bind,source=${source},target=${item.target}${item.readOnly ? ",readonly" : ""}`,
    );
  }
  invariant(
    targets.has(request.workdir),
    "Isolated workdir needs an approved mount",
  );
  const container = "foundation-extension-" + crypto.randomUUID();
  const envDirectory = path.join(config.dataDir, "isolation-env");
  await mkdir(envDirectory, { recursive: true });
  const envFile = path.join(envDirectory, container + ".env");
  const envLines = Object.entries(request.env).map(([name, value]) => {
    invariant(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/[\r\n\0]/.test(value),
      "Container environment needs valid names and single-line values",
    );
    return name + "=" + value;
  });
  await writeFile(envFile, envLines.join("\n"), { flag: "wx", mode: 0o600 });
  let cleaned = false;
  return {
    command: "docker",
    cwd: request.cwd,
    env: processEnvironment(),
    boundary: "docker",
    args: [
      "run",
      "--rm",
      "--pull=never",
      "--name",
      container,
      "--init",
      "--interactive",
      "--user",
      e.dockerUser,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      e.memoryMb + "m",
      "--memory-swap",
      e.memoryMb + "m",
      "--cpus",
      String(e.cpus),
      "--pids-limit",
      String(e.pidsLimit),
      "--network",
      request.network ? "bridge" : "none",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=64m",
      ...mounts,
      "--workdir",
      request.workdir,
      "--env-file",
      envFile,
      e.dockerImage,
      request.command,
      ...request.args,
    ],
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        await new Promise<void>((resolve) => {
          const child = spawn("docker", ["rm", "--force", container], {
            env: processEnvironment(),
            shell: false,
            windowsHide: true,
            stdio: "ignore",
            detached: process.platform !== "win32",
          });
          const timeout = setTimeout(() => {
            void terminateProcessTree(child);
            resolve();
          }, 3000);
          child.once("error", () => {
            clearTimeout(timeout);
            resolve();
          });
          child.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } finally {
        await rm(envFile, { force: true });
      }
    },
  };
}
