import { pathToFileURL } from "node:url";
import { readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** @typedef {{ ok: true, result: unknown } | { ok: false, error: string }} PluginReply */
/** @typedef {(name: string, args: unknown, context: unknown) => unknown} ToolHandler */
/** @typedef {(this: Record<string, unknown>, request: unknown, context: unknown) => unknown} MediaHandler */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Both IPC and isolated stdio execute the same verified snapshot and exports.
/** @param {unknown} input @param {string} root @param {string} entry @returns {Promise<unknown>} */
async function execute(input, root, entry) {
  if (!isRecord(input)) throw new Error("Invalid plugin invocation");
  const request = input;
  if (!isRecord(request.integrity))
    throw new Error("Missing verified source snapshot");
  const relativeEntry = path.relative(root, entry).replaceAll("\\", "/");
  if (!Object.hasOwn(request.integrity, relativeEntry))
    throw new Error("Entry missing from source snapshot");
  for (const [name, digest] of Object.entries(request.integrity)) {
    const file = path.resolve(root, name),
      relative = path.relative(root, file);
    if (
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative) ||
      !(await lstat(file)).isFile()
    )
      throw new Error("Invalid plugin snapshot path");
    if (
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex") !== digest
    )
      throw new Error("Plugin snapshot integrity failed");
  }
  /** @type {unknown} */
  const module = await import(pathToFileURL(entry).href);
  const { operation, payload } = request;
  if (!isRecord(module) || !isRecord(payload))
    throw new Error("Invalid plugin exports or payload");
  if (operation === "tool") {
    if (
      typeof module.execute !== "function" ||
      typeof payload.name !== "string"
    )
      throw new Error("Plugin must export execute(name,args,context)");
    return /** @type {ToolHandler} */ (module.execute)(
      payload.name,
      payload.args,
      Object.freeze(payload.context),
    );
  }
  if (operation === "media") {
    const adapters = module.mediaAdapters;
    if (
      !isRecord(adapters) ||
      typeof payload.adapterId !== "string" ||
      typeof payload.method !== "string"
    )
      throw new Error("Invalid media adapter request");
    const adapter = adapters[payload.adapterId];
    if (!isRecord(adapter) || typeof adapter[payload.method] !== "function")
      throw new Error("Media method " + payload.method + " not implemented");
    return /** @type {MediaHandler} */ (adapter[payload.method]).call(
      adapter,
      payload.request,
      Object.freeze(payload.context),
    );
  }
  throw new Error("Unknown plugin operation");
}

/** @param {unknown} request @param {string} root @param {string} entry @param {(reply: PluginReply) => void} send @returns {Promise<void>} */
async function reply(request, root, entry, send) {
  try {
    send({ ok: true, result: await execute(request, root, entry) });
  } catch (error) {
    send({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

if (typeof process.send === "function") {
  // One invocation per process; the host controls lifetime and inherited credentials.
  process.once("message", (request) => {
    void reply(request, process.cwd(), process.argv[2], (result) =>
      process.send?.(result),
    );
  });
} else {
  // Trusted runtime is mounted separately; plugin console output is never protocol output.
  const output = process.stdout.write.bind(process.stdout);
  console.log =
    console.info =
    console.warn =
      (...args) => process.stderr.write(args.map(String).join(" ") + "\n");
  /** @type {Buffer[]} */
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Invalid plugin input chunk");
    bytes += chunk.length;
    if (bytes > 200 * 1024 * 1024) throw new Error("Plugin input too large");
    chunks.push(chunk);
  }
  /** @type {unknown} */
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(request) || typeof request.entry !== "string")
    throw new Error("Invalid plugin invocation");
  const root = path.resolve(
    typeof request.root === "string" ? request.root : "/plugin",
  );
  await reply(request, root, path.resolve(root, request.entry), (result) => {
    output(JSON.stringify({ nonce: request.nonce, ...result }) + "\n");
  });
}
