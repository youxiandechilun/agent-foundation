import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  root,
  verification,
  readJson,
  writeJson,
  sha256,
  npm,
  assert,
} from "./shared.mjs";
import { validateManifest } from "./manifest.mjs";

const metadata = await readJson(path.join(root, "package.json"));
const report = {
  version: metadata.version,
  checkedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  status: "failed",
  published: false,
};
try {
  const dist = path.resolve(root, "dist");
  assert(
    dist === path.join(path.resolve(root), "dist"),
    "Refusing to clean unexpected build path",
  );
  const entry = await lstat(dist).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  assert(!entry?.isSymbolicLink(), "Refusing to clean a linked dist directory");
  if (entry) {
    assert(entry.isDirectory(), "dist must be a directory");
    await rm(dist, { recursive: true, force: false });
  }
  console.log("Building complete SDK and optional host entry...");
  const build = npm(["run", "build:host"]);
  await mkdir(verification, { recursive: true });
  await writeFile(
    path.join(verification, "sdk-build.log"),
    build.stdout + build.stderr,
  );
  const destination = path.join(root, "releases", metadata.version);
  await mkdir(destination, { recursive: true });
  const result = npm([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    destination,
  ]);
  const manifests = JSON.parse(result.stdout);
  assert(
    Array.isArray(manifests) && manifests.length === 1,
    "Unexpected npm pack response",
  );
  const manifest = manifests[0];
  assert(
    typeof manifest.filename === "string" &&
      path.basename(manifest.filename) === manifest.filename,
    "Unsafe npm tarball filename",
  );
  const validation = validateManifest(manifest, metadata);
  const tarball = path.join(destination, manifest.filename);
  const checksum = await sha256(tarball);
  await writeJson(path.join(destination, "manifest.json"), {
    ...manifest,
    sha256: checksum,
  });
  await writeFile(
    path.join(destination, "SHA256SUMS.txt"),
    `${checksum}  ${manifest.filename}\n`,
  );
  Object.assign(report, {
    status: "passed",
    tarball,
    sha256: checksum,
    bytes: manifest.size,
    unpackedBytes: manifest.unpackedSize,
    engines: metadata.engines,
    entryChecks: validation,
    sourcePolicy:
      "Compiled ESM JavaScript and declarations; no TypeScript implementation or source maps. JavaScript remains readable.",
    license: metadata.license,
  });
  console.log(
    JSON.stringify(
      { tarball, sha256: checksum, files: validation.files },
      null,
      2,
    ),
  );
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await writeJson(path.join(verification, "sdk-package.json"), report);
}
