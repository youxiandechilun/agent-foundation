import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";

export async function verifyCli(packageRoot, config) {
  const installedBin = path.join(
    process.cwd(),
    "node_modules/.bin",
    process.platform === "win32" ? "agent-foundation.cmd" : "agent-foundation",
  );
  await access(installedBin);
  if (process.platform === "win32")
    assert.match(
      await readFile(installedBin, "utf8"),
      /agent-foundation.*dist[\\/]cli\.js/,
    );
  const configFile = path.join(process.cwd(), "cli-config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      ...config,
      dataDir: path.join(process.cwd(), "cli-data"),
    }),
  );
  const child = spawn(
    process.execPath,
    [path.join(packageRoot, "dist/cli.js"), "serve", "--config", configFile],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    const deadline = Date.now() + 15000;
    while (
      !/Agent Foundation .*http:\/\/127\.0\.0\.1:\d+/.test(output) &&
      Date.now() < deadline
    ) {
      if (child.exitCode !== null)
        throw new Error(`CLI exited before startup: ${output}`);
      await pause(50);
    }
    assert.match(
      output,
      /Agent Foundation .*http:\/\/127\.0\.0\.1:\d+/,
      output,
    );
    return {
      started: true,
      runtime: process.version,
      command: "agent-foundation serve --config <file>",
      installedBin,
    };
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}
