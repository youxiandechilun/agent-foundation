import path from "node:path";
import { assert } from "./shared.mjs";
import { CORE_RUNTIME_FILES, HOST_RUNTIME_FILES } from "../runtime-files.mjs";

const runtimeFiles = [...CORE_RUNTIME_FILES, ...HOST_RUNTIME_FILES].map(
  (file) => "dist/" + file,
);

export function validateManifest(manifest, metadata) {
  const files = new Set(
    manifest.files.map((file) => file.path.replaceAll("\\", "/")),
  );
  const targets = Object.values(metadata.exports).flatMap((entry) =>
    Object.values(entry),
  );
  for (const target of [
    ...targets,
    metadata.bin["agent-foundation"],
    ...runtimeFiles,
  ]) {
    assert(
      files.has(target.replace(/^\.\//, "")),
      `Package is missing runtime target: ${target}`,
    );
  }
  for (const name of [
    "extensions/browser-bridge/manifest.json",
    "config.example.json",
    "docs/SDK.md",
  ]) {
    assert(files.has(name), `Package is missing integration material: ${name}`);
  }
  for (const file of files) {
    assert(
      !path.posix.isAbsolute(file) && !file.split("/").includes(".."),
      `Unsafe package path: ${file}`,
    );
    assert(
      !/^(src|test|scripts|verification|node_modules|releases|data|logs)\//.test(
        file,
      ),
      `Development/private path included: ${file}`,
    );
    assert(
      !/(^|\/)(config\.json|\.env(?:\..*)?)$/.test(file),
      `Local configuration included: ${file}`,
    );
    assert(
      !file.includes(".agent-data") && !file.endsWith(".map"),
      `Runtime data or source map included: ${file}`,
    );
    assert(
      !file.endsWith(".ts") || file.endsWith(".d.ts"),
      `TypeScript implementation included: ${file}`,
    );
    assert(
      /^(dist\/|docs\/|examples\/sdk\/|extensions\/browser-bridge\/|package\.json$|README\.md$|config\.example\.json$)/.test(
        file,
      ),
      `Unexpected package file: ${file}`,
    );
  }
  return { files: files.size, exportTargets: targets, runtimeFiles };
}
