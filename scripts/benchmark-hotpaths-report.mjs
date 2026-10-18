// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** @typedef {{files: number, bytes: number, sha256: string}} Fingerprint */
/** Fingerprint all regular files deterministically; exclude maps/declarations from compiled code.
 * @param {string} directory @param {boolean} compiled @returns {Promise<Fingerprint>}
 */
export async function fingerprint(directory, compiled) {
  const digest = createHash("sha256");
  let files = 0,
    bytes = 0;
  /** @param {string} relative */
  async function walk(relative) {
    const entries = await readdir(path.join(directory, relative), {
      withFileTypes: true,
    });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      assert.ok(
        !entry.isSymbolicLink(),
        `Fingerprint directory must not contain symlinks: ${name}`,
      );
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && (!compiled || !/\.(map|d\.ts)$/.test(name))) {
        const content = await readFile(path.join(directory, name));
        digest.update(
          `${name.replaceAll("\\", "/")}\0${createHash("sha256").update(content).digest("hex")}\n`,
        );
        files++;
        bytes += content.length;
      }
    }
  }
  await walk("");
  assert.ok(files > 0, `No files to fingerprint: ${directory}`);
  return { files, bytes, sha256: digest.digest("hex") };
}

/** @param {string} directory @returns {Promise<Record<string, string>>} */
export async function scriptFingerprints(directory) {
  const names = (await readdir(directory))
    .filter((name) => /^benchmark-hotpaths.*\.mjs$/.test(name))
    .sort();
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const name of names)
    Object.assign(hashes, {
      [name]: createHash("sha256")
        .update(await readFile(path.join(directory, name)))
        .digest("hex"),
    });
  return hashes;
}

/** @param {number[]} values */
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return {
    samplesMs: values,
    medianMs:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

/** @param {(import("./benchmark-hotpaths-worker.mjs").WorkerResult & {label: string})[]} samples @param {{label: string}[]} versions @param {string[]} selected @param {number} rounds */
export function summarize(samples, versions, selected, rounds) {
  return Object.fromEntries(
    selected.map((scenario) => {
      const versionsResult = Object.fromEntries(
        versions.map((version) => {
          const runs = samples.filter(
            (sample) =>
              sample.scenario === scenario && sample.label === version.label,
          );
          assert.equal(runs.length, rounds);
          assert.ok(runs.every((run) => run.operations === runs[0].operations));
          return [
            version.label,
            {
              ...stats(runs.map((run) => run.measured.elapsedMs)),
              operations: runs[0].operations,
              parameters: runs[0].parameters,
            },
          ];
        }),
      );
      const baseline = versionsResult[versions[0].label].medianMs;
      const relativeToFirst = Object.fromEntries(
        versions.map((version) => [
          version.label,
          baseline / versionsResult[version.label].medianMs,
        ]),
      );
      return [
        scenario,
        { versions: versionsResult, speedupRelativeToFirst: relativeToFirst },
      ];
    }),
  );
}
