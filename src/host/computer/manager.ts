import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Assets } from "../../storage/assets.js";
import type { Config } from "../../core/config.js";
import { invariant, id } from "../../core/util.js";

export const computerActionSchema = z
  .object({
    action: z.enum([
      "inspect",
      "windows",
      "tree",
      "screenshot",
      "focus",
      "move",
      "click",
      "drag",
      "type",
      "key",
      "scroll",
      "set_value",
      "invoke",
      "toggle",
      "select",
      "expand",
      "collapse",
    ]),
    windowId: z
      .string()
      .regex(/^[1-9]\d{0,15}$/)
      .optional(),
    processId: z.number().int().positive().optional(),
    elementId: z
      .string()
      .regex(/^uia:-?\d+(?:\.-?\d+)*$/)
      .max(500)
      .optional(),
    x: z.number().int().min(-100000).max(100000).optional(),
    y: z.number().int().min(-100000).max(100000).optional(),
    toX: z.number().int().min(-100000).max(100000).optional(),
    toY: z.number().int().min(-100000).max(100000).optional(),
    text: z.string().max(10000).optional(),
    key: z.string().min(1).max(100).optional(),
    button: z.enum(["left", "right"]).optional(),
    delta: z.number().int().min(-10000).max(10000).optional(),
  })
  .strict();
type Action = z.infer<typeof computerActionSchema>;
interface Lease {
  runId: string;
  projectId: string;
  expires: number;
  controller: AbortController;
}
/** Native bridge with project/run leases, explicit window targets and serialized cancellable processes. */
export class ComputerController {
  private owner?: Lease;
  private stopped = false;
  private closed = false;
  private queued = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly config: Config,
    readonly assets: Assets,
    private authorize?: (projectId: string, action: Action) => void,
  ) {}
  status() {
    if (this.owner && this.owner.expires <= Date.now())
      this.release(this.owner.runId, this.owner.projectId);
    return {
      platform: process.platform,
      available:
        process.platform === "win32" &&
        this.config.computer.enabled &&
        !this.closed,
      stopped: this.stopped,
      owner: this.owner?.runId,
      projectId: this.owner?.projectId,
      expiresAt: this.owner
        ? new Date(this.owner.expires).toISOString()
        : undefined,
      queued: this.queued,
      boundary: "native-user-session",
      targeting: "window-and-process",
      globalInput: this.config.computer.allowGlobalInput,
    };
  }
  acquire(runId: string, projectId: string) {
    this.status();
    this.allowed(projectId);
    invariant(
      !this.owner ||
        (this.owner.runId === runId && this.owner.projectId === projectId),
      "Computer is controlled by another run or project",
      409,
    );
    if (!this.owner)
      this.owner = {
        runId,
        projectId,
        expires: Date.now() + this.config.computer.leaseMs,
        controller: new AbortController(),
      };
    else this.owner.expires = Date.now() + this.config.computer.leaseMs;
    return this.owner;
  }
  release(runId: string, projectId?: string) {
    if (
      this.owner?.runId === runId &&
      (!projectId || this.owner.projectId === projectId)
    ) {
      const lease = this.owner;
      this.owner = undefined;
      lease.controller.abort(new Error("Computer control lease released"));
    }
  }
  async emergencyStop() {
    this.stopped = true;
    if (this.owner) this.release(this.owner.runId, this.owner.projectId);
    await this.tail.catch(() => {});
    return this.status();
  }
  resume() {
    invariant(!this.closed, "Computer plugin closed", 503);
    this.stopped = false;
    return this.status();
  }
  private allowed(projectId: string, action?: Action) {
    invariant(
      !this.closed && !this.stopped,
      "Computer control stopped or closed",
      503,
    );
    invariant(
      this.config.computer.enabled &&
        this.config.permissions.computer !== "deny",
      "Computer capability disabled",
      403,
    );
    this.assets.store.project(projectId);
    if (action) this.authorize?.(projectId, action);
    if (
      action &&
      !["inspect", "windows"].includes(action.action) &&
      !action.windowId
    )
      invariant(
        action.action === "screenshot"
          ? this.config.computer.allowDesktopCapture
          : this.config.computer.allowGlobalInput,
        "Explicit target window and process are required",
        403,
      );
    if (action?.action === "screenshot")
      invariant(
        this.config.permissions["files.write"] !== "deny",
        "Screenshot file capability disabled",
        403,
      );
    if (action?.processId && this.config.computer.allowedProcessIds.length)
      invariant(
        this.config.computer.allowedProcessIds.includes(action.processId),
        "Target process is not allowed",
        403,
      );
  }
  async action(
    runId: string,
    projectId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    invariant(
      process.platform === "win32",
      "Native computer adapter currently supports Windows",
      501,
    );
    const action = computerActionSchema.parse(input);
    this.allowed(projectId, action);
    signal?.throwIfAborted();
    invariant(
      Boolean(action.windowId) === Boolean(action.processId),
      "Window and process IDs must be provided together",
    );
    const targetless = ["inspect", "windows"].includes(action.action);
    if (!targetless && !action.windowId)
      invariant(
        action.action === "screenshot"
          ? this.config.computer.allowDesktopCapture
          : this.config.computer.allowGlobalInput,
        "Explicit target window and process are required",
        403,
      );
    if (
      [
        "tree",
        "set_value",
        "invoke",
        "toggle",
        "select",
        "expand",
        "collapse",
        "focus",
      ].includes(action.action)
    )
      invariant(action.windowId, "This action requires a target window");
    if (
      [
        "set_value",
        "invoke",
        "toggle",
        "select",
        "expand",
        "collapse",
      ].includes(action.action)
    )
      invariant(
        action.elementId,
        "This action requires an accessibility element reference",
      );
    if (["type", "set_value"].includes(action.action))
      invariant(action.text !== undefined, "Text is required");
    if (action.action === "key") invariant(action.key, "Key is required");
    if (["move", "click", "drag"].includes(action.action))
      invariant(
        action.x !== undefined && action.y !== undefined,
        "Pointer coordinates are required",
      );
    if (action.action === "drag")
      invariant(
        action.toX !== undefined && action.toY !== undefined,
        "Drag destination is required",
      );
    if (action.action === "scroll")
      invariant(action.delta !== undefined, "Scroll delta is required");
    invariant(
      this.queued < this.config.computer.maxQueuedActions,
      "Computer action queue capacity reached",
      429,
    );
    const lease = this.acquire(runId, projectId),
      stop = AbortSignal.any([
        lease.controller.signal,
        ...(signal ? [signal] : []),
      ]);
    this.queued++;
    const pending = this.tail
      .catch(() => {})
      .then(async () => {
        stop.throwIfAborted();
        this.allowed(projectId, action);
        invariant(
          this.owner === lease && lease.expires > Date.now(),
          "Computer control lease expired",
          409,
        );
        const directory = path.join(this.config.dataDir, "computer-captures");
        await mkdir(directory, { recursive: true });
        const output = path.join(directory, id("screen") + ".png");
        try {
          const parsed = await this.execute(
            {
              ...action,
              output,
              allowedProcessIds: this.config.computer.allowedProcessIds,
              limits: {
                maxElements: this.config.computer.maxElements,
                maxDepth: this.config.computer.maxDepth,
                maxCapturePixels: this.config.computer.maxCapturePixels,
              },
            },
            projectId,
            action,
            lease,
            stop,
          );
          stop.throwIfAborted();
          this.allowed(projectId, action);
          if (action.action !== "screenshot") return parsed;
          const bytes = await readFile(output, { signal: stop });
          invariant(
            bytes.length <= this.config.limits.maxUploadBytes,
            "Screenshot exceeds asset limit",
            413,
          );
          stop.throwIfAborted();
          this.allowed(projectId, action);
          const asset = await this.assets.create(
            projectId,
            "computer-screenshot.png",
            bytes,
            "artifact",
            "image/png",
            stop,
          );
          return { ...parsed, asset };
        } finally {
          await rm(output, { force: true });
        }
      })
      .finally(() => {
        this.queued--;
      });
    this.tail = pending;
    return pending;
  }
  private execute(
    input: Record<string, unknown>,
    projectId: string,
    action: Action,
    lease: Lease,
    signal: AbortSignal,
  ): Promise<any> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const powershell = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const child = spawn(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          fileURLToPath(
            new URL("./native/windows-computer.ps1", import.meta.url),
          ),
        ],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            SystemRoot: process.env.SystemRoot || "C:\\Windows",
            TEMP: process.env.TEMP || this.config.dataDir,
            TMP: process.env.TMP || this.config.dataDir,
          },
        },
      );
      let stdout: Buffer[] = [],
        stderr: Buffer[] = [],
        size = 0,
        error: Error | undefined,
        settled = false;
      const abort = (reason: Error) => {
        error ||= reason;
        child.kill();
      };
      const cancelled = () =>
        abort(
          new Error(
            "Computer action cancelled: " +
              String(signal.reason?.message || signal.reason || "abort"),
          ),
        );
      const timeout = setTimeout(
        () => abort(new Error("Computer action timed out")),
        this.config.computer.timeoutMs,
      );
      const policy = setInterval(() => {
        try {
          this.allowed(projectId, action);
          invariant(
            this.owner === lease && lease.expires > Date.now(),
            "Computer control lease expired",
            409,
          );
        } catch (e) {
          abort(e as Error);
        }
      }, 100);
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(policy);
        signal.removeEventListener("abort", cancelled);
      };
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.from(JSON.stringify(input)).toString("base64"));
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.config.computer.maxOutputBytes)
          abort(new Error("Computer result exceeds output limit"));
        else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.config.computer.maxOutputBytes)
          abort(new Error("Computer result exceeds output limit"));
        else stderr.push(chunk);
      });
      child.once("error", (e) => {
        error ||= e;
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) return reject(error);
        if (code !== 0)
          return reject(
            new Error(
              Buffer.concat(stderr).toString("utf8").slice(0, 3000) ||
                `Computer adapter exited ${code}`,
            ),
          );
        try {
          const result = JSON.parse(
            Buffer.concat(stdout)
              .toString("utf8")
              .replace(/^\uFEFF/, ""),
          );
          invariant(
            result.ok === true,
            "Computer adapter returned an invalid result",
            502,
          );
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });
  }
  async close() {
    if (this.closed) return;
    await this.emergencyStop();
    this.closed = true;
  }
}
