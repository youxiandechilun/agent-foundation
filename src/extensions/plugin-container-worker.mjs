import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
// Trusted host code is mounted separately and read-only. Console output is not protocol output.
const output = process.stdout.write.bind(process.stdout);
console.log =
  console.info =
  console.warn =
    (...args) => process.stderr.write(args.map(String).join(" ") + "\n");
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 200 * 1024 * 1024)
    throw new Error("Plugin input too large");
}
const request = JSON.parse(input);
const root = request.root || "/plugin";
try {
  for (const [name, digest] of Object.entries(request.integrity)) {
    const file = path.resolve(root, name),
      relative = path.relative(root, file);
    if (
      relative === ".." ||
      /^(?:\.\.[\\/])/.test(relative) ||
      path.isAbsolute(relative)
    )
      throw new Error("Invalid plugin snapshot path");
    if (
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex") !== digest
    )
      throw new Error("Plugin snapshot integrity failed");
  }
  const entry = path.resolve(root, request.entry);
  if (!Object.hasOwn(request.integrity, request.entry))
    throw new Error("Entry missing from source snapshot");
  const module = await import(pathToFileURL(entry).href),
    { operation, payload } = request;
  let result;
  if (operation === "tool") {
    if (typeof module.execute !== "function")
      throw new Error("Plugin execute export missing");
    result = await module.execute(
      payload.name,
      payload.args,
      Object.freeze(payload.context),
    );
  } else if (operation === "media") {
    const method = module.mediaAdapters?.[payload.adapterId]?.[payload.method];
    if (typeof method !== "function") throw new Error("Media method missing");
    result = await method(payload.request, Object.freeze(payload.context));
  } else throw new Error("Unsupported plugin operation");
  output(JSON.stringify({ nonce: request.nonce, ok: true, result }) + "\n");
} catch (error) {
  output(
    JSON.stringify({
      nonce: request.nonce,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }) + "\n",
  );
}
