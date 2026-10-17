import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const forbidden =
  /@earendil-works\/pi-|@mariozechner\/pi-|@modelcontextprotocol\/sdk|vendor\/pi|config\.fixture/;
const frameworkOrModelSdk =
  /^(?:@modelcontextprotocol\/sdk|@openai\/agents|@anthropic-ai\/sdk|openai|@earendil-works\/pi-.+|@mariozechner\/pi-.+)$/;
for (const [name, entry] of Object.entries(
  JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"))
    .packages || {},
)) {
  const dependencyName = name.split("node_modules/").at(-1);
  if (dependencyName && frameworkOrModelSdk.test(dependencyName))
    throw Error(
      "Framework/model/MCP SDK remains in lockfile: " + dependencyName,
    );
}
if (forbidden.test(JSON.stringify(manifest)))
  throw Error("An agent framework dependency remains");
if (
  forbidden.test(await readFile(path.join(root, "package-lock.json"), "utf8"))
)
  throw Error("An agent framework entry remains in the lockfile");
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else {
      const content = await readFile(file);
      if (
        /\.(ts|mjs|cjs)$/.test(entry.name) &&
        ["src", "extensions", "examples"].some((base) =>
          path.relative(root, file).startsWith(base + path.sep),
        ) &&
        forbidden.test(content.toString())
      )
        throw Error("Framework reference in " + file);
      if (
        directory.includes(path.sep + "src") &&
        /\.(ts|mjs|cjs)$/.test(entry.name) &&
        /fixtureStream|fixturePng|adapter\s*===?\s*['"]fixture/.test(
          content.toString(),
        )
      )
        throw Error("Production fixture in " + file);
      files.push({
        path: path.relative(root, file).replaceAll("\\", "/"),
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
}
await walk(path.join(root, "src"));
await walk(path.join(root, "extensions"));
await walk(path.join(root, "examples"));
await walk(path.join(root, "scripts"));
await walk(path.join(root, "docs"));
await walk(path.join(root, "test"));
for (const name of [
  "package.json",
  "package-lock.json",
  "config.json",
  "config.example.json",
  "tsconfig.json",
  "tsconfig.core.json",
  "README.md",
]) {
  const content = await readFile(path.join(root, name));
  files.push({
    path: name,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
await mkdir(path.join(root, "verification"), { recursive: true });
const report = {
  version: manifest.version,
  checkedAt: new Date().toISOString(),
  runtime: "foundation-owned",
  agentFrameworkDependencies: [],
  mcpSdkDependencies: [],
  modelSdkDependencies: [],
  productionDependencies: manifest.dependencies,
  optionalHostDependencies: manifest.optionalDependencies,
  productionFixtureAdapters: [],
  sourceFiles: files.length,
  files,
};
await writeFile(
  path.join(root, "verification/source-manifest.json"),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    {
      version: report.version,
      runtime: report.runtime,
      sourceFiles: report.sourceFiles,
      agentFrameworkDependencies: [],
      productionFixtureAdapters: [],
    },
    null,
    2,
  ),
);
