import assert from "node:assert/strict";
import http, { type ClientRequest } from "node:http";
import { test } from "node:test";
import { setup, token, until } from "./support/wire-server.js";

function partial(url: string, length?: number) {
  const request = http.request(url, {
    method: "POST",
    agent: false,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(length === undefined ? {} : { "Content-Length": length }),
    },
  });
  request.on("error", () => {});
  request.on("response", (response) => response.resume());
  request.flushHeaders();
  request.write("{");
  return request;
}

test("JSON admission bounds incomplete HTTP bodies and releases leases on disconnect", async () => {
  const x = await setup(undefined, {
    limits: { maxConcurrentJsonRequests: 2 },
  });
  const requests: ClientRequest[] = [];
  let readers = 0;
  const observe = (req: http.IncomingMessage) => {
    if (req.method !== "POST" || req.url !== "/v1/projects") return;
    const iterate = req[Symbol.asyncIterator].bind(req);
    req[Symbol.asyncIterator] = () => {
      readers++;
      return iterate();
    };
  };
  x.api.server.prependListener("request", observe);
  try {
    requests.push(partial(x.api.url + "/v1/projects", 32000));
    requests.push(partial(x.api.url + "/v1/projects", 32000));
    await until(() => readers === 2 || undefined);
    const blocked = await fetch(x.api.url + "/v1/projects", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "blocked" }),
    });
    assert.equal(blocked.status, 429);
    assert.match(await blocked.text(), /resource_capacity/);
    assert.equal(
      readers,
      2,
      "rejection happens before reading or allocating a body",
    );
    requests[0].destroy();
    await until(async () => {
      const response = await fetch(x.api.url + "/v1/projects", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "after disconnect" }),
      });
      await response.text();
      if (response.status === 429) return;
      assert.equal(response.status, 201);
      return true;
    });
    assert.equal((await fetch(x.api.url + "/health")).status, 200);
  } finally {
    requests.forEach((request) => request.destroy());
    x.api.server.off("request", observe);
    await x.close();
  }
});

test("JSON byte admission reserves declared bytes and the complete chunked route limit", async () => {
  const x = await setup(undefined, {
    limits: { maxConcurrentJsonRequests: 8, maxInFlightJsonBytes: 8192 },
  });
  let reads = 0;
  const observe = (req: http.IncomingMessage) => {
    if (req.url !== "/v1/projects" || req.method !== "POST") return;
    const iterate = req[Symbol.asyncIterator].bind(req);
    req[Symbol.asyncIterator] = () => {
      reads++;
      return iterate();
    };
  };
  x.api.server.prependListener("request", observe);
  let request: ClientRequest | undefined;
  try {
    request = partial(x.api.url + "/v1/projects", 6144);
    await until(() => reads === 1 || undefined);
    const blocked = await fetch(x.api.url + "/v1/projects", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "x".repeat(4096),
    });
    assert.equal(blocked.status, 429);
    await blocked.text();
    assert.equal(reads, 1);
    const chunked = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        const req = http.request(
          x.api.url + "/v1/projects",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          },
          resolve,
        );
        req.once("error", reject);
        req.write('{"name":');
        req.end('"chunked"}');
      },
    );
    chunked.resume();
    assert.equal(chunked.statusCode, 429);
    assert.equal(reads, 1);
  } finally {
    request?.destroy();
    x.api.server.off("request", observe);
    await x.close();
  }
});

test("invalid JSON and per-route oversize responses return parser capacity", async () => {
  const x = await setup(undefined, {
    limits: { maxConcurrentJsonRequests: 1 },
  });
  try {
    for (const [body, expected] of [
      ["{", 400],
      ["x".repeat(65537), 413],
    ] as const) {
      const response = await fetch(x.api.url + "/v1/projects", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
      assert.equal(response.status, expected);
      await response.text();
      const next = await fetch(x.api.url + "/v1/projects", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "valid after failure" }),
      });
      assert.equal(next.status, 201);
      await next.text();
    }
  } finally {
    await x.close();
  }
});

test("disconnect cannot return JSON capacity while a real host handler retains its decoded body", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started = 0;
  const x = await setup(
    undefined,
    { limits: { maxConcurrentJsonRequests: 1 } },
    {
      integrations: [
        {
          id: "held-json-body",
          async handle(_kernel, _req, url, json) {
            if (url.pathname !== "/v1/held-json") return;
            const body = (await json()) as { text: string };
            started++;
            if (started === 1) await gate;
            return { data: { length: body.text.length } };
          },
        },
      ],
    },
  );
  const controller = new AbortController();
  const call = (signal?: AbortSignal) =>
    fetch(x.api.url + "/v1/held-json", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "x".repeat(10000) }),
      signal,
    });
  try {
    const first = call(controller.signal).catch(() => undefined);
    await until(() => started === 1 || undefined);
    controller.abort();
    await first;
    const blocked = await call();
    assert.equal(blocked.status, 429);
    await blocked.text();
    assert.equal(started, 1);
    finish();
    await until(async () => {
      const response = await call();
      const value = await response.json();
      if (response.status === 429) return;
      assert.equal(response.status, 200);
      assert.deepEqual(value, { length: 10000 });
      return true;
    });
  } finally {
    controller.abort();
    finish();
    await x.close();
  }
});
