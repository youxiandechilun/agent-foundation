// Narrowing helpers for decoded JSON from peers, providers and HTTP clients.

/** A decoded JSON object; its members stay `unknown` until a guard narrows them. */
export type WireObject = Record<string, unknown>;
/** Plain-object view of a wire value. Arrays and primitives expose no named members. */
export function wireObject(value: unknown): WireObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WireObject)
    : undefined;
}
/** Reads a nested member, treating every non-object step as absent. */
export function wireMember(value: unknown, ...path: string[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as WireObject)[key];
  }
  return value;
}
/** True when `list` is an array containing `item`; any other value contains nothing. */
export function wireIncludes(list: unknown, item: unknown): boolean {
  return Array.isArray(list) && list.includes(item);
}
