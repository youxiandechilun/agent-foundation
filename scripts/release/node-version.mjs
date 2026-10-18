import { assert } from "./shared.mjs";

export function supportsNode(version, range) {
  const rule = range.match(
    /^\^(\d+)\.(\d+)\.(\d+) \|\| >=(\d+)\.(\d+)\.(\d+)$/,
  );
  const actual = version.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  assert(
    rule && actual,
    `Unsupported Node range/version syntax: ${range} / ${version}`,
  );
  const current = actual.slice(1).map(Number);
  const maintenance = rule.slice(1, 4).map(Number);
  const later = rule.slice(4).map(Number);
  const atLeast = (minimum) =>
    current[0] > minimum[0] ||
    (current[0] === minimum[0] &&
      (current[1] > minimum[1] ||
        (current[1] === minimum[1] && current[2] >= minimum[2])));
  return (
    (current[0] === maintenance[0] && atLeast(maintenance)) || atLeast(later)
  );
}
