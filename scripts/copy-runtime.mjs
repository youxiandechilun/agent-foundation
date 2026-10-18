import { copyFile, mkdir } from "node:fs/promises";
import { CORE_RUNTIME_FILES, HOST_RUNTIME_FILES } from "./runtime-files.mjs";

const files = [
  ...CORE_RUNTIME_FILES,
  ...(process.argv.includes("--host") ? HOST_RUNTIME_FILES : []),
];
for (const file of files) {
  const target = new URL("../dist/" + file, import.meta.url);
  await mkdir(new URL("./", target), { recursive: true });
  await copyFile(new URL("../src/" + file, import.meta.url), target);
}
