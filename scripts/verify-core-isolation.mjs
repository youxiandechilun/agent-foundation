import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const absent = [];
for (const name of [
  "playwright",
  "ws",
  "docx",
  "exceljs",
  "mammoth",
  "pdfjs-dist",
  "pptxgenjs",
  "@xmldom/xmldom",
  "jszip",
  "pdf-lib",
  "@napi-rs/canvas",
  "@modelcontextprotocol/sdk",
  "openai",
  "@anthropic-ai/sdk",
]) {
  const candidate = path.join(root, "node_modules", name);
  try {
    await access(candidate);
    throw Error("Unexpected optional dependency in clean core: " + name);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    absent.push(name);
  }
}
for (const name of [
  "host",
  "office.js",
  "office-worker.cjs",
  "browser.js",
  "computer.js",
  "nodes.js",
  "platform",
]) {
  try {
    await access(path.join(root, "dist", name));
    throw Error("Optional integration emitted in core build: " + name);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
await import(new URL("../dist/index.js", import.meta.url));
console.log(
  JSON.stringify(
    {
      version: manifest.version,
      coreImportPassed: true,
      optionalDependenciesAbsent: absent,
      coreProductionDependencies: manifest.dependencies,
      outputEntries: await readdir(path.join(root, "dist")),
    },
    null,
    2,
  ),
);
