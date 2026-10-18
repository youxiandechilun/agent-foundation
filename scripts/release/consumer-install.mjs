import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { root, readJson, writeJson, npm, assert } from "./shared.mjs";

export async function installConsumer(consumer, tarball, metadata) {
  await mkdir(consumer, { recursive: true });
  const copiedPackage = path.join(consumer, path.basename(tarball));
  await copyFile(tarball, copiedPackage);
  const consumerMetadata = {
    name: "agent-foundation-sdk-consumer",
    private: true,
    type: "module",
    dependencies: { [metadata.name]: `file:${path.basename(copiedPackage)}` },
    devDependencies: { "@types/node": metadata.devDependencies["@types/node"] },
  };
  await writeJson(path.join(consumer, "package.json"), consumerMetadata);
  // Reuse exact registry resolutions and integrity from the maintained lockfile.
  // No repository path or node_modules directory is made visible to the consumer.
  const locked = await readJson(path.join(root, "package-lock.json"));
  locked.name = consumerMetadata.name;
  delete locked.version;
  locked.packages[""] = consumerMetadata;
  locked.packages[`node_modules/${metadata.name}`] = {
    name: metadata.name,
    version: metadata.version,
    resolved: `file:${path.basename(copiedPackage)}`,
    integrity: `sha512-${createHash("sha512")
      .update(await readFile(copiedPackage))
      .digest("base64")}`,
    dependencies: metadata.dependencies,
    optionalDependencies: metadata.optionalDependencies,
    engines: metadata.engines,
    bin: metadata.bin,
    license: metadata.license,
  };
  await writeJson(path.join(consumer, "package-lock.json"), locked);
  const installed = npm(
    [
      "install",
      "--omit=optional",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      copiedPackage,
    ],
    { cwd: consumer },
  );
  await writeFile(
    path.join(consumer, "install.log"),
    installed.stdout + installed.stderr,
  );
  const packageRoot = path.join(consumer, "node_modules", metadata.name);
  const installedMetadata = await readJson(
    path.join(packageRoot, "package.json"),
  );
  assert(
    installedMetadata.version === metadata.version,
    "Unexpected installed package version",
  );
  assert(
    !(await readdir(packageRoot)).includes("src"),
    "Consumer received development implementation directory",
  );
  const fixtureDirectory = path.join(root, "scripts/release/fixtures");
  for (const fixture of await readdir(fixtureDirectory)) {
    await copyFile(
      path.join(fixtureDirectory, fixture),
      path.join(consumer, fixture),
    );
  }
  return packageRoot;
}
