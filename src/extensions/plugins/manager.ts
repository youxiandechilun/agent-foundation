import { z } from "zod";
import { fork, spawn } from "node:child_process";
import { writeFile, mkdir, readFile, realpath, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../storage/store.js";
import type { Config } from "../../core/config.js";
import { CAPABILITIES, type ToolDefinition } from "../../runtime/types.js";
import {
  now,
  invariant,
  safePath,
  within,
  registerSecret,
} from "../../core/util.js";
import {
  readSourceFiles,
  sourceHash,
  validateSourceFiles,
  sourceSnapshot,
  removeSnapshot,
} from "./source-bundle.js";
import { observePlugin } from "./invocation.js";
import {
  prepareExtensionHost,
  reviewedWorkspace,
} from "../../execution/extension-host.js";

const capability = z.enum(CAPABILITIES);
export const pluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
    name: z.string().max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    entry: z.string().regex(/\.(mjs|js|cjs)$/),
    description: z.string().max(2000).default(""),
    envRefs: z.record(z.string(), z.string()).default({}),
    containerNetwork: z.boolean().optional(),
    tools: z
      .array(
        z.object({
          name: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
          description: z.string(),
          parameters: z.record(z.string(), z.any()),
          risk: z
            .enum(["read", "write", "execute", "network", "control"])
            .default("execute"),
          capabilities: z.array(capability).default([]),
        }),
      )
      .default([]),
    mediaAdapters: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).default([]),
    mediaCapabilities: z
      .record(
        z.string(),
        z
          .object({
            kinds: z.array(z.enum(["image", "video"])).min(1),
            operations: z
              .array(z.enum(["generate", "edit", "variation"]))
              .min(1),
            polling: z.boolean().default(false),
            cancellation: z.boolean().default(false),
            recovery: z.boolean().default(false),
          })
          .strict(),
      )
      .default({}),
  })
  .strict()
  .refine(
    (manifest) =>
      manifest.mediaAdapters.every((id) => manifest.mediaCapabilities[id]),
    "Every media adapter needs explicit mediaCapabilities",
  );
export interface InstalledPlugin {
  id: string;
  manifest: z.infer<typeof pluginManifestSchema>;
  enabled: boolean;
  trustedHash?: string;
  hash: string;
  directory: string;
  installedAt: string;
}
export class PluginManager {
  private closing = false;
  private pending = new Map<AbortController, Promise<any>>();
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {}
  list() {
    return this.store.list<InstalledPlugin>("plugins").map((p) => ({
      ...p,
      directory: undefined,
      executionBoundary:
        this.config.extensions.executionBoundary === "native"
          ? "native-child-process"
          : this.config.extensions.executionBoundary,
    }));
  }
  async install(manifestInput: unknown, files: Record<string, string>) {
    const manifest = pluginManifestSchema.parse(manifestInput);
    validateSourceFiles(files);
    invariant(Object.hasOwn(files, manifest.entry), "Plugin needs entry file");
    const digest = sourceHash(manifest, files);
    const directory = path.join(
      this.config.dataDir,
      "plugins",
      manifest.id,
      digest + "-" + crypto.randomUUID(),
    );
    await safePath(
      this.config.dataDir,
      path.relative(this.config.dataDir, directory),
      true,
    );
    await mkdir(directory, { recursive: true });
    await safePath(
      this.config.dataDir,
      path.relative(this.config.dataDir, directory),
    );
    for (const [name, content] of Object.entries(files)) {
      invariant(
        !name.includes("node_modules") && !name.endsWith(".node"),
        "Plugin bundle must contain inspectable source",
      );
      const file = await safePath(directory, name, true);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
    }
    const plugin: InstalledPlugin = {
      id: manifest.id,
      manifest,
      enabled: false,
      hash: digest,
      directory,
      installedAt: now(),
    };
    invariant(
      manifest.tools.every(
        (tool) => `plugin_${manifest.id}_${tool.name}`.length <= 64,
      ),
      "Plugin tool name exceeds the protocol limit",
    );
    invariant(
      !this.store
        .list<InstalledPlugin>("plugins")
        .some(
          (other) =>
            other.id !== plugin.id &&
            other.manifest.mediaAdapters.some((id) =>
              manifest.mediaAdapters.includes(id),
            ),
        ),
      "Media adapter ID already belongs to another plugin",
      409,
    );
    this.store.put("plugins", plugin);
    return this.list().find((p) => p.id === plugin.id)!;
  }
  async installDirectory(directory: string) {
    const actual = await realpath(directory),
      roots = await Promise.all(
        this.config.extensions.allowedRoots.map((r) => realpath(r)),
      );
    invariant(
      roots.some((root) => within(root, actual)),
      "Plugin directory outside configured extension roots",
      403,
    );
    const declaration = JSON.parse(
      await readFile(await safePath(actual, "plugin.json"), "utf8"),
    );
    const { files: names, ...manifest } = declaration;
    invariant(
      Array.isArray(names) && names.length <= 200,
      "plugin.json requires files[]",
    );
    const files: Record<string, string> = {};
    for (const name of names)
      files[name] = await readFile(await safePath(actual, name), "utf8");
    return this.install(manifest, files);
  }
  enable(pluginId: string, enabled: boolean, trustedHash?: string) {
    const plugin = this.store.get<InstalledPlugin>("plugins", pluginId);
    invariant(
      !enabled || trustedHash === plugin.hash,
      "Enabling source plugin code requires its reviewed hash",
      403,
      "plugin_trust_required",
    );
    this.store.put("plugins", {
      ...plugin,
      enabled,
      trustedHash: enabled ? trustedHash : undefined,
    });
    return this.list().find((p) => p.id === pluginId)!;
  }
  remove(pluginId: string) {
    this.store.get("plugins", pluginId);
    this.store.remove("plugins", pluginId);
  }
  private async invoke(
    plugin: InstalledPlugin,
    operation: "tool" | "media",
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    invariant(!this.closing, "Plugin manager is closed", 503);
    signal?.throwIfAborted();
    const controller = new AbortController();
    const task = this.invokeOnce(
      plugin,
      operation,
      payload,
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    );
    this.pending.set(controller, task);
    try {
      return await task;
    } finally {
      this.pending.delete(controller);
    }
  }
  async close() {
    this.closing = true;
    for (const controller of this.pending.keys())
      controller.abort(new Error("Kernel plugin manager closed"));
    const results = await Promise.allSettled([...this.pending.values()]);
    const failures = results
      .filter((r) => r.status === "rejected")
      .filter((r) => r.reason?.code === "isolation_cleanup_failed");
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        "Plugin sandbox cleanup unconfirmed",
      );
  }
  private async invokeOnce(
    plugin: InstalledPlugin,
    operation: "tool" | "media",
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    invariant(
      !this.config.execution.requireIsolation ||
        this.config.extensions.executionBoundary !== "native",
      "Native source plugins are prohibited by required isolation",
      403,
      "isolation_required",
    );
    const current = this.store.get<InstalledPlugin>("plugins", plugin.id);
    invariant(
      current.enabled &&
        current.hash === plugin.hash &&
        current.trustedHash === plugin.hash,
      "Plugin disabled, updated, or untrusted",
      403,
    );
    const files = await this.verifiedFiles(current);
    const invocationRoot = path.join(this.config.dataDir, "plugin-invocations");
    const snapshot = await sourceSnapshot(invocationRoot, files);
    try {
      const entry = await safePath(snapshot, plugin.manifest.entry);
      const env: NodeJS.ProcessEnv = {};
      for (const key of [
        "PATH",
        "Path",
        "SystemRoot",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
      ])
        if (process.env[key]) env[key] = process.env[key];
      for (const [key, ref] of Object.entries(plugin.manifest.envRefs)) {
        invariant(process.env[ref], `Missing environment variable ${ref}`, 503);
        env[key] = process.env[ref];
        if (/key|token|secret|password|auth|credential/i.test(key))
          registerSecret(env[key]!);
      }
      if (this.config.extensions.executionBoundary !== "native") {
        const explicitEnv = Object.fromEntries(
          Object.keys(plugin.manifest.envRefs).map((key) => [key, env[key]!]),
        );
        return await this.invokeContainer(
          plugin,
          operation,
          payload,
          snapshot,
          files,
          explicitEnv,
          signal,
        );
      }
      signal?.throwIfAborted();
      const options: import("node:child_process").ForkOptions & {
        windowsHide: boolean;
      } = {
        cwd: snapshot,
        env,
        execArgv: [`--max-old-space-size=${this.config.extensions.maxHeapMb}`],
        windowsHide: true,
        silent: true,
        detached: process.platform !== "win32",
      };
      return await observePlugin(
        fork(
          fileURLToPath(new URL("./worker.mjs", import.meta.url)),
          [entry],
          options,
        ),
        { operation, payload },
        files,
        this.config.extensions.timeoutMs,
        this.config.limits.maxUploadBytes * 2,
        signal,
      );
    } finally {
      await removeSnapshot(invocationRoot, snapshot).catch(() => undefined);
    }
  }
  private async invokeContainer(
    plugin: InstalledPlugin,
    operation: "tool" | "media",
    payload: any,
    snapshot: string,
    files: Record<string, string>,
    env: Record<string, string>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const tool =
      operation === "tool"
        ? plugin.manifest.tools.find((t) => t.name === payload.name)
        : undefined;
    const caps = tool?.capabilities || [];
    const invocationRoot = path.dirname(snapshot);
    await chmod(invocationRoot, 0o700);
    await chmod(snapshot, 0o755);
    const preparedDirectories = new Set([snapshot]);
    for (const name of Object.keys(files)) {
      let directory = path.dirname(path.join(snapshot, name));
      while (!preparedDirectories.has(directory)) {
        await chmod(directory, 0o755);
        preparedDirectories.add(directory);
        directory = path.dirname(directory);
      }
      await chmod(path.join(snapshot, name), 0o444);
    }
    const runtime = await sourceSnapshot(invocationRoot, {
      "plugin-worker.mjs": await readFile(
        new URL("./worker.mjs", import.meta.url),
        "utf8",
      ),
    });
    try {
      await chmod(runtime, 0o755);
      await chmod(path.join(runtime, "plugin-worker.mjs"), 0o444);
      const mounts = [
        { source: snapshot, target: "/plugin", readOnly: true },
        { source: runtime, target: "/runtime", readOnly: true },
      ];
      const safePayload = structuredClone(payload);
      if (
        payload.context?.projectRoot &&
        caps.some((c) => c === "files.read" || c === "files.write")
      ) {
        const source = await reviewedWorkspace(
          this.config,
          payload.context.projectRoot,
        );
        mounts.push({
          source,
          target: "/workspace",
          readOnly:
            this.config.execution.workspaceReadOnly ||
            !caps.includes("files.write"),
        });
        safePayload.context.projectRoot =
          this.config.extensions.executionBoundary === "windows-appcontainer"
            ? source
            : "/workspace";
      } else if (safePayload.context) delete safePayload.context.projectRoot;
      const host = await prepareExtensionHost(
        this.config,
        {
          command: "node",
          args: [
            `--max-old-space-size=${this.config.extensions.maxHeapMb}`,
            "/runtime/plugin-worker.mjs",
          ],
          cwd: snapshot,
          mounts,
          workdir: "/plugin",
          env,
          network:
            plugin.manifest.containerNetwork === true ||
            caps.includes("network"),
        },
        this.config.extensions.executionBoundary === "windows-appcontainer"
          ? "windows-appcontainer"
          : "docker",
      );
      try {
        signal?.throwIfAborted();
        return await observePlugin(
          spawn(host.command, host.args, {
            cwd: host.cwd,
            env: host.env,
            shell: false,
            windowsHide: true,
            detached:
              process.platform !== "win32" || host.ownerMonitored === true,
            stdio: ["pipe", "pipe", "pipe"],
          }),
          {
            nonce: crypto.randomUUID(),
            entry: plugin.manifest.entry,
            root:
              this.config.extensions.executionBoundary ===
              "windows-appcontainer"
                ? snapshot
                : "/plugin",
            operation,
            payload: safePayload,
          },
          files,
          this.config.extensions.timeoutMs,
          this.config.limits.maxUploadBytes * 2,
          signal,
        );
      } finally {
        await host.cleanup();
      }
    } finally {
      await removeSnapshot(invocationRoot, runtime);
    }
  }
  private async verifiedFiles(plugin: InstalledPlugin) {
    try {
      invariant(
        path.dirname(plugin.directory) ===
          path.join(this.config.dataDir, "plugins", plugin.id) &&
          (path.basename(plugin.directory) === plugin.hash ||
            (path.basename(plugin.directory).startsWith(plugin.hash + "-") &&
              /^[a-f0-9-]{36}$/.test(
                path.basename(plugin.directory).slice(plugin.hash.length + 1),
              ))),
        "Plugin installation root mismatch",
        403,
      );
      const files = await readSourceFiles(plugin.directory);
      invariant(
        plugin.manifest.entry in files &&
          sourceHash(plugin.manifest, files) === plugin.hash,
        "Plugin source integrity check failed; review and reinstall changed source",
        403,
        "plugin_integrity_failed",
      );
      return files;
    } catch (e) {
      this.store.put("plugins", {
        ...plugin,
        enabled: false,
        trustedHash: undefined,
      });
      throw e;
    }
  }
  async verify(pluginId: string) {
    const plugin = this.store.get<InstalledPlugin>("plugins", pluginId);
    await this.verifiedFiles(plugin);
    return {
      id: pluginId,
      hash: plugin.hash,
      verified: true,
      checkedAt: now(),
    };
  }
  async export(pluginId: string) {
    const plugin = this.store.get<InstalledPlugin>("plugins", pluginId);
    return {
      manifest: plugin.manifest,
      files: await this.verifiedFiles(plugin),
      hash: plugin.hash,
    };
  }
  mediaDefinition(adapterId: string) {
    const plugins = this.store
      .list<InstalledPlugin>("plugins")
      .filter((p) => p.enabled && p.manifest.mediaAdapters.includes(adapterId));
    invariant(
      plugins.length === 1,
      "Media adapter must identify one enabled plugin",
      409,
    );
    const definition = plugins[0].manifest.mediaCapabilities?.[adapterId];
    invariant(
      definition,
      "Media capabilities missing; review and reinstall the plugin manifest",
      409,
    );
    return definition;
  }
  tools(projectId: string, projectRoot: string): ToolDefinition[] {
    return this.store
      .list<InstalledPlugin>("plugins")
      .filter((p) => p.enabled && p.trustedHash === p.hash)
      .flatMap((plugin) =>
        plugin.manifest.tools.map((t) => ({
          name: `plugin_${plugin.id}_${t.name}`.slice(0, 64),
          description: t.description,
          parameters: t.parameters,
          risk: t.risk,
          capabilities: [
            ...new Set([
              "plugin" as const,
              ...t.capabilities,
              ...(plugin.manifest.containerNetwork ? ["network" as const] : []),
            ]),
          ],
          source: { kind: "plugin" as const, id: plugin.id },
          execute: async (_callId: string, args: any, signal?: AbortSignal) => {
            const value = await this.invoke(
              plugin,
              "tool",
              {
                name: t.name,
                args,
                context: { projectId, projectRoot, pluginId: plugin.id },
              },
              signal,
            );
            return value && Array.isArray(value.content)
              ? value
              : {
                  content: [{ type: "text", text: JSON.stringify(value) }],
                  details: value,
                };
          },
        })),
      );
  }
  async media(
    adapterId: string,
    method: string,
    request: unknown,
    context: unknown,
    signal?: AbortSignal,
  ) {
    const plugin = this.store
      .list<InstalledPlugin>("plugins")
      .find((p) => p.enabled && p.manifest.mediaAdapters.includes(adapterId));
    invariant(
      plugin,
      `Media adapter ${adapterId} is not installed/enabled`,
      503,
    );
    return this.invoke(
      plugin,
      "media",
      { adapterId, method, request, context },
      signal,
    );
  }
}
