import assert from "node:assert/strict";
import { createServer, get, type RequestListener } from "node:http";
import type { ListenOptions } from "node:net";
import { test, type TestContext } from "node:test";
import { listenHttp } from "../src/transport/http-listener.js";

const host = "127.0.0.1";
const blockedPort = 6697;

function managedServer(t: TestContext, listener?: RequestListener) {
  const server = createServer(listener);
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });
  return server;
}

test("automatic HTTP ports reject a real blocked allocation before a single fetch request", async (t) => {
  let requests = 0;
  const server = managedServer(t, (_request, response) => {
    requests++;
    response.end("accepted");
  });
  const baseline = server.listeners("connection");
  const allocated: number[] = [];
  server.on("listening", () => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    allocated.push(address.port);
  });
  const baselineListening = server.listeners("listening");
  const actualListen = server.listen.bind(server);
  let attempts = 0;
  t.mock.method(server, "listen", (options: ListenOptions) =>
    actualListen({ ...options, port: attempts++ === 0 ? blockedPort : 0 }),
  );
  const address = await listenHttp(server, { host, port: 0 });
  assert.equal(allocated[0], blockedPort);
  assert.ok(attempts >= 2);
  assert.notEqual(address.port, blockedPort);
  assert.equal(address.port, allocated.at(-1));
  assert.deepEqual(server.listeners("connection"), baseline);
  assert.equal(server.listenerCount("error"), 0);
  assert.deepEqual(server.listeners("listening"), baselineListening);
  const response = await fetch(`http://${host}:${address.port}/`, {
    method: "POST",
    body: "only once",
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "accepted");
  assert.equal(requests, 1);
});

test("explicit blocked ports are preserved even though fetch rejects them", async (t) => {
  let requests = 0;
  const server = managedServer(t, (_request, response) => {
    requests++;
    response.end("explicit");
  });
  const address = await listenHttp(server, { host, port: blockedPort });
  assert.equal(address.port, blockedPort);
  await assert.rejects(fetch(`http://${host}:${blockedPort}/`), (error) => {
    assert.ok(error instanceof TypeError);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, "bad port");
    return true;
  });
  assert.equal(requests, 0);
  const body = await new Promise<string>((resolve, reject) => {
    get(`http://${host}:${blockedPort}/`, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve(text));
      response.on("error", reject);
    }).on("error", reject);
  });
  assert.equal(body, "explicit");
  assert.equal(requests, 1);
});

test("exhausted HTTP port reselection is bounded and releases the candidate and temporary listeners", async (t) => {
  const server = managedServer(t);
  const baseline = server.listeners("connection");
  const baselineListening = server.listeners("listening");
  const actualListen = server.listen.bind(server);
  let attempts = 0;
  t.mock.method(server, "listen", (options: ListenOptions) => {
    attempts++;
    return actualListen({ ...options, port: blockedPort });
  });
  await assert.rejects(
    listenHttp(server, { host, port: 0 }),
    /Could not allocate an HTTP port accepted by fetch after 32 attempts/,
  );
  assert.equal(attempts, 32);
  assert.equal(server.listening, false);
  assert.equal(server.address(), null);
  assert.deepEqual(server.listeners("connection"), baseline);
  assert.equal(server.listenerCount("error"), 0);
  assert.deepEqual(server.listeners("listening"), baselineListening);
});

test("bind failures are not retried and preserve unrelated event listeners", async (t) => {
  const blocker = managedServer(t);
  await new Promise<void>((resolve) => blocker.listen(0, host, resolve));
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  const server = managedServer(t);
  const observedErrors: Error[] = [];
  const onError = (error: Error) => observedErrors.push(error);
  const onListening = () => assert.fail("occupied port must not listen");
  server.on("error", onError);
  server.on("listening", onListening);
  const baseline = server.listeners("connection");
  const baselineListening = server.listeners("listening");
  const actualListen = server.listen.bind(server);
  let attempts = 0;
  t.mock.method(server, "listen", (options: ListenOptions) => {
    attempts++;
    return actualListen({ ...options, port });
  });
  await assert.rejects(listenHttp(server, { host, port: 0 }), {
    code: "EADDRINUSE",
  });
  assert.equal(attempts, 1);
  assert.equal(observedErrors.length, 1);
  assert.equal(server.listening, false);
  assert.deepEqual(server.listeners("error"), [onError]);
  assert.deepEqual(server.listeners("listening"), baselineListening);
  assert.deepEqual(server.listeners("connection"), baseline);
});

test("synchronous listen errors release temporary event listeners", async (t) => {
  const server = managedServer(t);
  const baseline = server.listeners("connection");
  const baselineListening = server.listeners("listening");
  const failure = new Error("intentional synchronous listen failure");
  t.mock.method(server, "listen", () => {
    throw failure;
  });
  await assert.rejects(
    listenHttp(server, { host, port: 0 }),
    (error) => error === failure,
  );
  assert.equal(server.listening, false);
  assert.equal(server.listenerCount("error"), 0);
  assert.deepEqual(server.listeners("listening"), baselineListening);
  assert.deepEqual(server.listeners("connection"), baseline);
});
