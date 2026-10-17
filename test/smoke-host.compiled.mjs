import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  Kernel,
  parseConfig,
  serve,
  FoundationClient,
  VERSION,
} from "../dist/index.js";
import { applicationIntegration } from "../dist/host/index.js";
const web = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end("<title>Compiled host fixture</title><h1>Real compiled browser</h1>");
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const data = path.resolve(".agent-data-tests", randomUUID());
const config = parseConfig({
  server: { port: 0 },
  dataDir: data,
  workspaceRoots: [path.join(data, "workspace")],
  defaultRoutes: { chat: "text", code: "text", office: "text" },
  routes: {
    text: {
      kind: "text",
      adapter: "openai-completions",
      model: "not-called",
      baseUrl: "http://127.0.0.1:1/v1",
      contextWindow: 128000,
    },
  },
  permissions: {
    browser: "allow",
    computer: "allow",
    network: "allow",
    "files.read": "allow",
    "files.write": "allow",
    node: "allow",
  },
  browser: { headless: true, allowPrivateNetwork: true },
});
const kernel = new Kernel(config, { integrations: [applicationIntegration()] }),
  api = await serve(kernel, "host-smoke-test-token-1234567890"),
  client = new FoundationClient(api.url, "host-smoke-test-token-1234567890");
try {
  const project = await client.project("Compiled host smoke"),
    a = await client.office("create", project.id, {
      format: "xlsx",
      name: "compiled",
      title: "Data",
      rows: [["value"], [23]],
    });
  const table = await client.office("table", project.id, { assetId: a.id });
  if (table[0].rows[1][0] !== 23) throw Error("Compiled Office worker failed");
  const b = await client.browserOpen(project.id, {
    url: `http://127.0.0.1:${web.address().port}`,
  });
  const snapshot = await client.browserAction(b.id, project.id, {
    action: "inspect",
  });
  if (!snapshot.snapshot.includes("Real compiled browser"))
    throw Error("Compiled browser failed");
  await client.browserClose(b.id, project.id);
  const bridge = await client.browserPair(project.id, "compiled pairing");
  await client.browserRevoke(bridge.id, project.id);
  if (
    process.platform === "win32" &&
    !(await client.computerAction(project.id, { action: "inspect" })).ok
  )
    throw Error("Compiled native bridge failed");
  console.log(
    JSON.stringify(
      {
        version: VERSION,
        compiledHost: true,
        optionalFormatWorker: true,
        actualChromium: true,
        windowsBridge: process.platform === "win32",
        pairing: true,
        modelCalled: false,
      },
      null,
      2,
    ),
  );
} finally {
  await api.close();
  web.closeAllConnections();
  await new Promise((r) => web.close(r));
}
