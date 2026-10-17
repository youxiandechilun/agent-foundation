import {
  readFile,
  readdir,
  lstat,
  mkdir,
  writeFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { hash, invariant, within } from "../util.js";

export function sourceHash(manifest: unknown, files: Record<string, string>) {
  return hash(
    JSON.stringify({
      manifest,
      files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
    }),
  );
}
export function validateSourceFiles(files: Record<string, string>) {
  invariant(
    files && typeof files === "object" && !Array.isArray(files),
    "Source files must be an object",
  );
  const seen = new Set<string>();
  for (const [name, content] of Object.entries(files)) {
    invariant(
      typeof content === "string" &&
        Buffer.from(content, "utf8").toString("utf8") === content,
      "Source files must contain canonical UTF-8 text",
    );
    invariant(
      name.length > 0 &&
        name.length <= 240 &&
        !path.isAbsolute(name) &&
        !name.includes("\\") &&
        !name.includes("\0") &&
        !name
          .split("/")
          .some(
            (p) =>
              !p ||
              p === "." ||
              p === ".." ||
              /[. ]$/.test(p) ||
              p.includes(":") ||
              /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p) ||
              p === "node_modules",
          ) &&
        !name.endsWith(".node"),
      "Unsafe source bundle path",
    );
    invariant(
      !seen.has(name.toLowerCase()),
      "Source paths collide after case normalization",
    );
    seen.add(name.toLowerCase());
  }
  invariant(
    seen.size > 0 &&
      seen.size <= 200 &&
      Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0) <=
        4 * 1024 * 1024,
    "Source bundle exceeds limits",
  );
}
export async function readSourceFiles(root: string) {
  const files: Record<string, string> = Object.create(null);
  let size = 0;
  const walk = async (directory: string) => {
    invariant(
      !(await lstat(directory)).isSymbolicLink(),
      "Source directory is a symlink",
      403,
    );
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name),
        info = await lstat(target);
      invariant(
        !info.isSymbolicLink(),
        "Source bundle symlinks are forbidden",
        403,
      );
      if (info.isDirectory()) await walk(target);
      else {
        invariant(info.isFile(), "Source must be a regular file", 403);
        size += info.size;
        invariant(
          size <= 4 * 1024 * 1024 && Object.keys(files).length < 200,
          "Source bundle exceeds limits",
        );
        files[path.relative(root, target).replaceAll("\\", "/")] =
          await readFile(target, "utf8");
      }
    }
  };
  await walk(root);
  validateSourceFiles(files);
  return files;
}
export async function sourceSnapshot(
  parent: string,
  files: Record<string, string>,
) {
  validateSourceFiles(files);
  await mkdir(parent, { recursive: true });
  invariant(
    !(await lstat(parent)).isSymbolicLink(),
    "Snapshot root cannot be a symlink",
    403,
  );
  const root = await mkdtemp(path.join(parent, "invocation-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, name);
      invariant(within(root, file), "Snapshot escapes root");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, { flag: "wx", mode: 0o400 });
    }
  } catch (e) {
    await removeSnapshot(parent, root);
    throw e;
  }
  return root;
}
export async function removeSnapshot(parent: string, root: string) {
  const absoluteParent = path.resolve(parent),
    absolute = path.resolve(root);
  invariant(
    path.dirname(absolute) === absoluteParent &&
      path.basename(absolute).startsWith("invocation-") &&
      within(absoluteParent, absolute),
    "Refusing to remove a path outside the invocation root",
  );
  if ((await lstat(absolute).catch(() => undefined))?.isSymbolicLink())
    throw new Error("Refusing to remove a symlink snapshot");
  await rm(absolute, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
