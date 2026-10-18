import assert from "node:assert/strict";
import http from "node:http";
import { rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import type { Kernel } from "../src/core/kernel.js";
import { FoundationClient } from "../src/client.js";
import { setup } from "./support/wire-server.js";

function resources(t: TestContext) {
  const servers: http.Server[] = [];
  const kernels: Kernel[] = [];
  const createServer = http.createServer.bind(http);
  t.mock.method(http, "createServer", (listener: http.RequestListener) => {
    const server = createServer(listener);
    servers.push(server);
    return server;
  });
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const kernel of kernels) {
      await kernel.close().catch(() => undefined);
      const root = path.dirname(kernel.config.dataDir);
      assert.ok(root.startsWith(path.join(tmpdir(), "foundation-v2-")));
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    servers,
    track: (kernel: Kernel) => {
      kernels.push(kernel);
    },
    assertClosed: () => {
      assert.ok(servers.every((server) => !server.listening));
      for (const kernel of kernels)
        assert.throws(
          () => kernel.store.db.prepare("SELECT 1"),
          /not open|closed/i,
        );
    },
  };
}

test("fixture closes its wire server and kernel when host initialization fails", async (t) => {
  const observed = resources(t);
  const failure = new Error("intentional integration initialization failure");
  let closed = 0;
  await assert.rejects(
    setup(
      undefined,
      {},
      {
        integrations: [
          {
            id: "fail-install",
            install(kernel) {
              observed.track(kernel);
              throw failure;
            },
            close() {
              closed++;
            },
          },
        ],
      },
    ),
    (error) => error === failure,
  );
  assert.equal(observed.servers.length, 1);
  assert.equal(closed, 1);
  observed.assertClosed();
});

for (const cleanupFails of [false, true])
  test(`fixture closes both HTTP servers after its first POST fails (cleanup failure=${cleanupFails})`, async (t) => {
    const observed = resources(t);
    let requests = 0;
    let closed = 0;
    const cleanupFailure = new Error("intentional cleanup failure");
    await assert.rejects(
      setup(
        undefined,
        {},
        {
          integrations: [
            {
              id: "break-first-request",
              install: observed.track,
              async handle(_kernel, request, url) {
                assert.equal(request.method, "POST");
                assert.equal(url.pathname, "/v1/projects");
                requests++;
                request.socket.destroy();
                return { data: {} };
              },
              close() {
                closed++;
                if (cleanupFails) throw cleanupFailure;
              },
            },
          ],
        },
      ),
      (error: unknown) => {
        if (cleanupFails) {
          assert.ok(error instanceof AggregateError);
          assert.ok(error.cause instanceof TypeError);
          assert.match(error.cause.message, /fetch failed/);
          assert.equal(error.errors[0], error.cause);
        } else {
          assert.ok(error instanceof TypeError);
          assert.match(error.message, /fetch failed/);
        }
        return true;
      },
    );
    assert.equal(requests, 1, "POST initialization must not be retried");
    assert.equal(closed, 1);
    assert.equal(observed.servers.length, 2);
    observed.assertClosed();
  });

test("fixture cleanup still closes the wire server when kernel cleanup rejects", async (t) => {
  const observed = resources(t);
  const fixture = await setup(
    undefined,
    {},
    {
      integrations: [
        {
          id: "fail-close",
          install: observed.track,
          close() {
            throw new Error("intentional integration close failure");
          },
        },
      ],
    },
  );
  const closing = fixture.close();
  assert.equal(fixture.close(), closing, "cleanup is shared across callers");
  await assert.rejects(closing, /Test fixture cleanup failed/);
  observed.assertClosed();
});

if (process.env.FOUNDATION_FIXTURE_STRESS === "1")
  test("fixture setup/close stress records failed origins and network causes", async (t) => {
    const observed = resources(t);
    const createProject = FoundationClient.prototype.project;
    let url = "";
    t.mock.method(
      FoundationClient.prototype,
      "project",
      function (this: FoundationClient, name: string, directory?: string) {
        url = this.baseUrl;
        return createProject.call(this, name, directory);
      },
    );
    const failures: {
      index: number;
      url: string;
      error: string;
      cause: string;
      code?: unknown;
    }[] = [];
    const ports = new Set<string>();
    for (let index = 0; index < 300; index++) {
      try {
        const fixture = await setup(
          undefined,
          {},
          {
            integrations: [{ id: "stress-observer", install: observed.track }],
          },
        );
        ports.add(new URL(fixture.api.url).port);
        await fixture.close();
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        failures.push({
          index,
          url,
          error: String(error),
          cause: String(cause),
          code:
            cause && typeof cause === "object" && "code" in cause
              ? cause.code
              : undefined,
        });
      }
    }
    t.diagnostic(
      JSON.stringify({ attempts: 300, uniquePorts: ports.size, failures }),
    );
    observed.assertClosed();
    assert.equal(failures.length, 0);
  });
