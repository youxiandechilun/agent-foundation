import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Kernel } from "../src/core/kernel.js";
import { loadConfig, parseConfig } from "../src/core/config.js";
import {
  TextProtocolRegistry,
  textProtocolIds,
} from "../src/providers/registry.js";
import type { TextProtocol } from "../src/providers/protocol.js";
import { textOf } from "../src/runtime/types.js";

const adapter = "isolated-host-json";
const requestSchema = z.object({ variant: z.string(), model: z.string() });
const replySchema = z.object({ reply: z.string() });

function protocol(variant: string): TextProtocol {
  return {
    id: adapter,
    headers: { "x-protocol-variant": variant },
    url: (base) => `${base}/generate`,
    body: ({ route }) => ({ variant, model: route.model }),
    async event(value, response) {
      await response.text(replySchema.parse(value).reply);
      response.usage({ input_tokens: 3, output_tokens: 2 });
      response.finish("stop");
    },
  };
}

async function fixture(t: TestContext) {
  const scratch = path.join(process.cwd(), ".agent-data-tests");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "protocol-scope-"));
  const kernels: Kernel[] = [];
  const requests: {
    variant: string;
    model: string;
    header: string | undefined;
  }[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = requestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      requests.push({
        ...body,
        header: request.headers["x-protocol-variant"] as string | undefined,
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ reply: `${body.variant}:${body.model}` }));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    try {
      await Promise.all(kernels.map((kernel) => kernel.close()));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(path.dirname(root), scratch);
      await rm(root, { recursive: true, force: true });
    }
  });
  const input = (name: string) => ({
    dataDir: path.join(root, name, "data"),
    workspaceRoots: [path.join(root, name, "workspace")],
    extensions: { allowedRoots: [path.join(root, name, "extensions")] },
    memory: { enabled: false },
    defaultRoutes: { chat: "text", code: "text", office: "text" },
    routes: { text: { kind: "text", adapter, model: "base", baseUrl } },
  });
  const kernel = (name: string, registry: TextProtocolRegistry) => {
    const created = new Kernel(parseConfig(input(name), root, registry), {
      textProtocols: registry,
    });
    kernels.push(created);
    return created;
  };
  return { root, kernels, requests, input, kernel };
}

async function complete(kernel: Kernel, routeId = "text") {
  const project = await kernel.createProject("protocol isolation");
  const session = kernel.createSession(project.id, "chat", "request", routeId);
  const submitted = await kernel.submit(session.id, {
    text: "reply using your own protocol",
  });
  const run = await kernel.wait(submitted.runId);
  assert.equal(run.status, "completed");
  const reply = kernel.store.transcript(session.id).at(-1)!.message;
  assert.equal(reply.role, "assistant");
  return textOf(reply);
}

test("same-name protocols remain independent across Kernels after the assembly registries are unregistered", async (t) => {
  const x = await fixture(t);
  const leftRegistry = new TextProtocolRegistry();
  const rightRegistry = new TextProtocolRegistry();
  const declaration = protocol("left");
  const removeLeft = leftRegistry.register(declaration);
  const removeRight = rightRegistry.register(protocol("right"));
  const left = x.kernel("left", leftRegistry);
  const right = x.kernel("right", rightRegistry);
  removeLeft();
  removeRight();
  declaration.headers = { "x-protocol-variant": "mutated" };
  declaration.body = () => ({ variant: "mutated", model: "mutated" });
  assert.equal(leftRegistry.find(adapter), undefined);
  assert.equal(rightRegistry.find(adapter), undefined);
  assert.equal(textProtocolIds().includes(adapter), false);
  await Promise.all([left.init(), right.init()]);
  assert.deepEqual(await Promise.all([complete(left), complete(right)]), [
    "left:base",
    "right:base",
  ]);
  assert.deepEqual(
    x.requests.map((request) => [request.variant, request.header]).sort(),
    [
      ["left", "left"],
      ["right", "right"],
    ],
  );
  await left.close();
  assert.equal(await complete(right), "right:base");
});

test("configuration loading, route updates and restart restoration use the Kernel's custom protocol registry", async (t) => {
  const x = await fixture(t);
  const registry = new TextProtocolRegistry();
  const unregister = registry.register(protocol("persistent"));
  const configFile = path.join(x.root, "host-config.json");
  await writeFile(configFile, JSON.stringify(x.input("persisted")));
  const config = await loadConfig(configFile, registry);
  const first = new Kernel(config, { textProtocols: registry });
  x.kernels.push(first);
  unregister();
  await first.init();
  await first.updateRoutes({
    set: { updated: { ...config.routes.text, model: "updated-model" } },
    defaultRoutes: { chat: "updated" },
  });
  assert.equal(await complete(first, "updated"), "persistent:updated-model");
  await first.close();

  const restartRegistry = new TextProtocolRegistry();
  const unregisterRestart = restartRegistry.register(protocol("restored"));
  const restarted = x.kernel("persisted", restartRegistry);
  unregisterRestart();
  await restarted.init();
  assert.equal(restarted.config.defaultRoutes.chat, "updated");
  assert.equal(restarted.config.routes.updated.model, "updated-model");
  assert.equal(await complete(restarted, "updated"), "restored:updated-model");
  assert.equal(textProtocolIds().includes(adapter), false);
});
