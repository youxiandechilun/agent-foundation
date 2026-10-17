#!/usr/bin/env node
import { parseArgs } from "node:util";
import { VERSION } from "./version.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { Kernel } from "./kernel.js";
import { serve } from "./server.js";
import { FoundationClient } from "./client.js";
import type { Mode } from "./contracts.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: "config.json" },
    url: { type: "string" },
    name: { type: "string" },
    project: { type: "string" },
    session: { type: "string" },
    mode: { type: "string", default: "chat" },
    route: { type: "string" },
    text: { type: "string" },
    file: { type: "string" },
    delivery: { type: "string", default: "start" },
    approval: { type: "string" },
    allow: { type: "boolean", default: false },
    host: { type: "string", default: "core" },
  },
});
const command = positionals[0] || "serve";
try {
  const config = await loadConfig(values.config);
  if (command === "serve") {
    if (
      !["core", "desktop", "browser", "computer", "office"].includes(
        values.host!,
      )
    )
      throw new Error("Unknown host integration");
    const integrationPath = "./host/applications.js";
    const integrations =
      values.host !== "core"
        ? [
            (await import(integrationPath))[
              values.host === "desktop"
                ? "applicationIntegration"
                : values.host + "Integration"
            ](),
          ]
        : [];
    const api = await serve(new Kernel(config, { integrations }));
    console.log(
      `Agent Foundation ${VERSION} ${api.url}\nConfig: ${path.resolve(values.config)}\nAPI token: ${process.env[config.server.tokenEnv] ? `environment ${config.server.tokenEnv}` : path.join(config.dataDir, "api-token")}\nRoutes: ${Object.entries(
        config.routes,
      )
        .filter(([, r]) => r.enabled)
        .map(([id, r]) => `${id}=${r.adapter}/${r.model}`)
        .join(", ")}`,
    );
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      void api.close().then(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else {
    const token =
      process.env[config.server.tokenEnv] ||
      (await readFile(path.join(config.dataDir, "api-token"), "utf8")).trim();
    const client = new FoundationClient(
      values.url || `http://127.0.0.1:${config.server.port}`,
      token,
    );
    if (command === "project")
      console.log(
        JSON.stringify(
          await client.project(values.name || "My project"),
          null,
          2,
        ),
      );
    else if (command === "session")
      console.log(
        JSON.stringify(
          await client.session(
            values.project!,
            values.mode as Mode,
            values.route,
          ),
          null,
          2,
        ),
      );
    else if (command === "upload")
      console.log(
        JSON.stringify(
          await client.upload(
            values.project!,
            path.basename(values.file!),
            await readFile(values.file!),
          ),
          null,
          2,
        ),
      );
    else if (command === "approve")
      console.log(
        JSON.stringify(
          await client.request(
            "POST",
            `/v1/approvals/${values.approval}/resolve`,
            { allow: values.allow },
          ),
          null,
          2,
        ),
      );
    else if (command === "send") {
      const result = await client.submit(values.session!, {
        text: values.text || positionals.slice(1).join(" "),
        delivery: values.delivery as "start" | "steer" | "enqueue",
      });
      console.log(`runId=${result.runId}`);
      for await (const event of client.events(result.runId)) {
        if (event.type === "assistant.message.delta")
          process.stdout.write(String(event.data.text));
        else if (event.type === "assistant.message.committed") console.log();
        else if (
          [
            "tool.started",
            "tool.settled",
            "approval.requested",
            "artifact.created",
            "run.completed",
          ].includes(event.type)
        )
          console.log(`[${event.type}] ${JSON.stringify(event.data)}`);
      }
    } else
      throw new Error(
        "Commands: serve | project | session | upload | send | approve",
      );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
