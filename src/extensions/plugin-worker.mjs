import { pathToFileURL } from "node:url";
import { readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
// One invocation per process; the host controls lifetime and strips inherited credentials.
process.once("message", async (request) => {
  try {
    const root = process.cwd();
    if (!request.integrity || typeof request.integrity !== "object")
      throw new Error("Missing verified source snapshot");
    for (const [name, digest] of Object.entries(request.integrity)) {
      const file = path.resolve(root, name),
        relative = path.relative(root, file);
      if (
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative) ||
        (await lstat(file)).isSymbolicLink()
      )
        throw new Error("Invalid snapshot path");
      if (
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex") !== digest
      )
        throw new Error("Plugin snapshot changed before execution");
    }
    const module = await import(pathToFileURL(process.argv[2]).href);
    const { operation, payload } = request;
    let result;
    if (operation === "tool") {
      if (typeof module.execute !== "function")
        throw new Error("Plugin must export execute(name,args,context)");
      result = await module.execute(
        payload.name,
        payload.args,
        Object.freeze(payload.context),
      );
    } else if (operation === "media") {
      const adapter = module.mediaAdapters?.[payload.adapterId];
      if (!adapter || typeof adapter[payload.method] !== "function")
        throw new Error(`Media method ${payload.method} not implemented`);
      result = await adapter[payload.method](
        payload.request,
        Object.freeze(payload.context),
      );
    } else throw new Error("Unknown plugin operation");
    process.send?.({ ok: true, result });
  } catch (error) {
    process.send?.({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
