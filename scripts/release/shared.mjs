import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../..", import.meta.url));
export const verification = path.join(root, "verification");
export const npmCli =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

export async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

export function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
    windowsHide: true,
    ...options,
    env: { ...process.env, NODE_PATH: "", ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(binary)} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

export function npm(args, options = {}) {
  return command(process.execPath, [npmCli, ...args], options);
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
