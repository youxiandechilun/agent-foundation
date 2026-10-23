import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Kernel } from "../src/core/kernel.js";
import { parseConfig } from "../src/core/config.js";
import type {
  KernelIntegration,
  KernelServices,
  ServiceToolFactory,
} from "../src/runtime/registry.js";
import { Store } from "../src/storage/store.js";

async function fixture(
  t: TestContext,
  integrations: KernelIntegration[],
  timeoutMs = 200,
) {
  const root = await mkdtemp(path.join(tmpdir(), "foundation-install-"));
  const config = parseConfig({
    dataDir: path.join(root, "data"),
    workspaceRoots: [path.join(root, "workspace")],
    extensions: { allowedRoots: [path.join(root, "extensions")], timeoutMs },
    memory: { enabled: false },
    defaultRoutes: { chat: "text", code: "text", office: "text" },
    routes: {
      text: {
        kind: "text",
        adapter: "openai-completions",
        model: "unused",
        baseUrl: "http://127.0.0.1:1",
      },
    },
  });
  const kernel = new Kernel(config, { integrations });
  t.after(async () => {
    try {
      await kernel.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return { kernel, config };
}

test(
  "a timed-out integration receives cancellation, cleans partial state and releases the store",
  { timeout: 5000 },
  async (t) => {
    const order: string[] = [];
    let installationSignal: AbortSignal | undefined;
    const x = await fixture(t, [
      {
        id: "ready",
        install() {
          order.push("ready");
        },
        close() {
          order.push("ready closed");
        },
      },
      {
        id: "stalled",
        install(_kernel, signal) {
          installationSignal = signal;
          order.push("partial allocation");
          return new Promise<void>((_resolve, reject) =>
            signal!.addEventListener("abort", () => reject(signal!.reason), {
              once: true,
            }),
          );
        },
        close() {
          order.push("partial allocation closed");
        },
      },
      {
        id: "later",
        install() {
          order.push("later installed");
        },
      },
    ]);
    await assert.rejects(
      x.kernel.init(),
      /Integration stalled installation timed out/,
    );
    assert.equal(installationSignal?.aborted, true);
    assert.deepEqual(order, [
      "ready",
      "partial allocation",
      "ready closed",
      "partial allocation closed",
    ]);
    const reopened = new Store(x.config.dataDir, { exclusiveKernel: true });
    reopened.close();
  },
);

test(
  "an uncooperative integration cannot keep init pending after its timeout",
  { timeout: 5000 },
  async (t) => {
    let closed = 0;
    const x = await fixture(t, [
      {
        id: "uncooperative",
        install: () => new Promise(() => {}),
        close() {
          closed++;
        },
      },
    ]);
    await assert.rejects(
      x.kernel.init(),
      /uncooperative installation timed out/,
    );
    assert.equal(closed, 1);
  },
);

test(
  "closing during extension installation aborts init without installing later extensions",
  { timeout: 5000 },
  async (t) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let installationSignal: AbortSignal | undefined;
    let laterInstalled = false;
    const x = await fixture(
      t,
      [
        {
          id: "waiting",
          install(_kernel, signal) {
            installationSignal = signal;
            entered();
            return new Promise(() => {});
          },
        },
        {
          id: "later",
          install() {
            laterInstalled = true;
          },
        },
      ],
      30_000,
    );
    const initializing = x.kernel.init();
    const rejection = assert.rejects(
      initializing,
      /shutting down during initialization/,
    );
    await started;
    await x.kernel.close();
    await rejection;
    assert.equal(installationSignal?.aborted, true);
    assert.equal(laterInstalled, false);
  },
);

test("service tool factories receive a narrow immutable facade and retain revocation", async (t) => {
  let observed: KernelServices | undefined;
  const factory: ServiceToolFactory = ({ services, session, ...context }) => {
    assert.equal("kernel" in context, false);
    assert.equal("store" in services, false);
    assert.equal("config" in services, false);
    observed = services;
    return [
      {
        name: "service_project",
        description: "Read the current project",
        parameters: { type: "object" },
        risk: "read",
        execute: async () => ({
          content: [
            {
              type: "text",
              text: services.projects.get(session.projectId).name,
            },
          ],
        }),
      },
    ];
  };
  const x = await fixture(t, [
    {
      id: "services",
      serviceTools(context) {
        assert.equal(this.id, "services");
        return factory(context);
      },
    },
    {
      id: "legacy-method",
      tools() {
        assert.equal(this.id, "legacy-method");
        return [];
      },
    },
  ]);
  await x.kernel.init();
  const project = await x.kernel.createProject("Narrow services");
  const session = x.kernel.createSession(project.id);
  const context = {
    kernel: x.kernel,
    session,
    runId: "narrow",
    routeId: session.routeId,
  };
  const resolved = await x.kernel.toolRegistry.resolve(context);
  assert.deepEqual((await resolved[0].execute("call", {})).content, [
    { type: "text", text: "Narrow services" },
  ]);
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed?.assets), true);
  const original = observed;
  const remove = x.kernel.toolRegistry.registerServices(
    "second-service",
    async (context) =>
      (await factory(context)).map((tool) => ({
        ...tool,
        name: "second_project",
      })),
  );
  const second = await x.kernel.toolRegistry.resolve(context);
  assert.equal(
    observed,
    original,
    "one facade is reused for the kernel lifetime",
  );
  remove();
  await assert.rejects(second[1].execute("removed", {}), /removed or replaced/);
});

test("service tool factories can be unit tested with only the services they use", async () => {
  const factory = (({
    services: { projects },
    session,
  }: {
    services: Pick<KernelServices, "projects">;
    session: { projectId: string };
  }) => [
    {
      name: "project_name",
      description: "Project name",
      parameters: {},
      risk: "read",
      execute: async () => ({
        content: [{ type: "text", text: projects.get(session.projectId).name }],
      }),
    },
  ]) satisfies ServiceToolFactory;
  const tools = factory({
    session: { projectId: "project" },
    services: {
      projects: {
        get: () => ({
          id: "project",
          name: "Fake",
          root: ".",
          createdAt: "now",
        }),
      },
    },
  });
  assert.deepEqual((await tools[0].execute()).content, [
    { type: "text", text: "Fake" },
  ]);
});
