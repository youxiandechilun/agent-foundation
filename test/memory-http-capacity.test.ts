import { test } from "node:test";
import assert from "node:assert/strict";
import http, { type ClientRequest, type ServerResponse } from "node:http";
import { memoryExport } from "../src/api/memory-export.js";
import { JsonStreamResponse, type ApiContext } from "../src/api/shared.js";
import { setup, token, until } from "./support/wire-server.js";

test("memory HTTP export streams the v1 format without full-list loading and enforces byte budgets", async () => {
  const x = await setup(undefined, { limits: { maxMemoryExportBytes: 4000 } });
  try {
    const entry = x.kernel.memory.put({
      projectId: x.project.id,
      content: "exported memory",
    });
    x.kernel.memory.list = () => {
      throw new Error("whole-list export is forbidden");
    };
    const exported = await x.client.request<{
      format: string;
      memories: { id: string }[];
    }>("GET", `/v1/memories/export?projectId=${x.project.id}`);
    assert.equal(exported.format, "foundation-memory-v1");
    assert.deepEqual(
      exported.memories.map((item) => item.id),
      [entry.id],
    );
    const emptyNamespace = await x.client.request(
      "GET",
      `/v1/memories/export?projectId=${x.project.id}&namespace=`,
    );
    assert.deepEqual(emptyNamespace, exported);
    x.kernel.memory.put({ projectId: x.project.id, content: "x".repeat(5000) });
    const response = await fetch(
      `${x.api.url}/v1/memories/export?projectId=${x.project.id}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(response.status, 413);
    assert.match(await response.text(), /memory_export_capacity/);
  } finally {
    await x.close();
  }
});

test("memory export uses a consistent snapshot and releases capacity on cancellation", async () => {
  const x = await setup(undefined, {
    limits: { maxConcurrentMemoryExports: 1 },
  });
  let first: JsonStreamResponse | undefined;
  try {
    const entry = x.kernel.memory.put({
      projectId: x.project.id,
      content: "before snapshot",
    });
    const controller = new AbortController();
    const context: ApiContext = {
      k: x.kernel,
      signal: controller.signal,
      url: new URL(
        `http://localhost/v1/memories/export?projectId=${x.project.id}`,
      ),
      parts: ["v1", "memories", "export"],
      method: "GET",
      json: async () => ({}),
    };
    first = memoryExport(context);
    assert.throws(() => memoryExport(context), /capacity/);
    x.kernel.memory.put({
      id: entry.id,
      projectId: x.project.id,
      content: "after snapshot",
    });
    const pieces = [];
    for await (const part of first.chunks) pieces.push(part);
    assert.equal(
      JSON.parse(pieces.join("")).memories[0].content,
      "before snapshot",
    );
    first = memoryExport(context);
    controller.abort(new Error("client disconnected"));
    await assert.rejects(async () => {
      for await (const part of first!.chunks) void part;
    }, /client disconnected/);
    const next = memoryExport({ ...context, signal: undefined });
    next.close();
  } finally {
    first?.close();
    await x.close();
  }
});

test("HTTP search disconnect cancels embedding work and frees its admission slot", async () => {
  const x = await setup(undefined, {
    limits: { maxConcurrentMemorySearches: 1 },
  });
  let started = false,
    cancelled = false;
  try {
    x.kernel.memory.semanticSearch = async (
      _project,
      _query,
      _limit,
      _namespace,
      signal,
    ) => {
      started = true;
      assert.ok(signal);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
      return [];
    };
    const controller = new AbortController();
    const request = fetch(`${x.api.url}/v1/memories/semantic-search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId: x.project.id, query: "test" }),
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await until(() => started || undefined);
    const blocked = await fetch(`${x.api.url}/v1/memories/semantic-search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId: x.project.id, query: "test" }),
    });
    assert.equal(blocked.status, 429);
    await blocked.text();
    controller.abort();
    await request;
    await until(() => cancelled || undefined);
    x.kernel.memory.semanticSearch = async () => [];
    assert.deepEqual(
      await x.client.request("POST", "/v1/memories/semantic-search", {
        projectId: x.project.id,
        query: "next",
      }),
      { memories: [] },
    );
  } finally {
    await x.close();
  }
});

test("a paused HTTP memory export keeps its slot until timeout and releases its WAL snapshot", async () => {
  const x = await setup(undefined, {
    limits: {
      maxConcurrentMemoryExports: 1,
      memoryExportTimeoutMs: 1000,
      maxMemoryExportBytes: 32 * 1024 * 1024,
    },
  });
  const endpoint = `/v1/memories/export?projectId=${x.project.id}`;
  let request: ClientRequest | undefined;
  let source: ServerResponse | undefined;
  let gatedWrites = 0;
  let exportStartedAt = 0;
  let restoreResponse = () => {};
  const observe = (req: http.IncomingMessage, res: ServerResponse) => {
    if (req.url !== endpoint) return;
    source = res;
    exportStartedAt = performance.now();
    const write = res.write,
      emit = res.emit;
    let sentHead = false;
    res.write = (chunk: unknown, ...args: unknown[]) => {
      // Deliver real HTTP headers and the JSON prefix, then hold a body write
      // without drain. OS loopback buffers cannot make this gate complete.
      if (!sentHead) {
        sentHead = true;
        return Reflect.apply(write, res, [chunk, ...args]) as boolean;
      }
      gatedWrites++;
      return false;
    };
    res.emit = (event: string | symbol, ...args: unknown[]) => {
      if (event === "drain" && gatedWrites > 0) return false;
      return Reflect.apply(emit, res, [event, ...args]) as boolean;
    };
    restoreResponse = () => {
      res.write = write;
      res.emit = emit;
    };
  };
  x.api.server.prependListener("request", observe);
  try {
    // Keep more than the source stream's read-ahead window available. The
    // controlled write/drain gate, rather than platform socket capacity, keeps
    // the generator and its WAL snapshot open until the export timeout.
    x.kernel.store.transaction(() => {
      for (let index = 0; index < 64; index++)
        x.kernel.memory.put({
          id: `slow_memory_${index}`,
          projectId: x.project.id,
          content: "x".repeat(16000) + index,
        });
    });
    const response = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        request = http.get(
          `${x.api.url}${endpoint}`,
          { headers: { Authorization: `Bearer ${token}` } },
          (res) => {
            res.on("error", () => {});
            res.pause();
            res.socket.pause();
            resolve(res);
          },
        );
        request.on("error", reject);
      },
    );
    assert.equal(response.statusCode, 200);
    await until(() => gatedWrites > 0 || undefined);
    assert.equal(source?.writableFinished, false);
    const context: ApiContext = {
      k: x.kernel,
      url: new URL(`http://localhost${endpoint}`),
      parts: ["v1", "memories", "export"],
      method: "GET",
      json: async () => ({}),
    };
    assert.throws(() => memoryExport(context), /capacity/);
    // A writer can advance the WAL while the export holds an earlier snapshot.
    x.kernel.memory.put({
      projectId: x.project.id,
      content: "written while the HTTP client is paused",
    });
    await until(() => {
      try {
        memoryExport(context).close();
        return true;
      } catch (error) {
        if (error instanceof Error && /capacity/.test(error.message)) return;
        throw error;
      }
    });
    await until(() => source?.destroyed || undefined);
    // Let the rejected pipeline reach the server's error handler too. Calling
    // end() after close can otherwise mark an aborted response as finished.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(source?.writableFinished, false);
    assert.ok(
      performance.now() - exportStartedAt >=
        x.config.limits.memoryExportTimeoutMs - 50,
      "the blocked response was retained until its configured timeout",
    );
    const checkpoint = x.kernel.store
      .prepare("PRAGMA wal_checkpoint(PASSIVE)")
      .get() as { busy: number; log: number; checkpointed: number };
    assert.equal(checkpoint.busy, 0);
    assert.equal(checkpoint.checkpointed, checkpoint.log);
  } finally {
    restoreResponse();
    request?.destroy();
    x.api.server.off("request", observe);
    await x.close();
  }
});
