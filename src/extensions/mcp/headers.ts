import { invariant } from "../../core/util.js";
import type { WireObject } from "./protocol.js";
export type HeaderBinding = {
  name: string;
  path: string[];
  type: "string" | "integer" | "boolean";
};
/** Header-safe text of a routing value; non-ASCII or padded text is base64-wrapped. */
export function mcpHeaderValue(value: unknown) {
  const text = String(value);
  return /^[\x20-\x7e\t]*$/.test(text) &&
    text.trim() === text &&
    !(text.startsWith("=?base64?") && text.endsWith("?="))
    ? text
    : "=?base64?" + Buffer.from(text).toString("base64") + "?=";
}
export function headerBindings(schema: unknown): HeaderBinding[] {
  const bindings: HeaderBinding[] = [],
    names = new Set<string>();
  function visit(
    value: unknown,
    path: string[],
    reachable: boolean,
    depth: number,
  ) {
    invariant(depth < 80, "MCP header schema nesting limit");
    if (!value || typeof value !== "object") return;
    const node = value as WireObject;
    if (Object.hasOwn(node, "x-mcp-header")) {
      const name = node["x-mcp-header"];
      invariant(
        reachable &&
          path.length &&
          typeof name === "string" &&
          /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
          !names.has(name.toLowerCase()) &&
          (node.type === "integer" ||
            node.type === "string" ||
            node.type === "boolean"),
        "Invalid x-mcp-header annotation",
      );
      names.add(name.toLowerCase());
      bindings.push({ name, path, type: node.type });
    }
    if (node.properties && typeof node.properties === "object")
      for (const [key, value] of Object.entries(node.properties))
        visit(value, [...path, key], reachable, depth + 1);
    for (const keyword of [
      "items",
      "prefixItems",
      "allOf",
      "oneOf",
      "anyOf",
      "not",
      "if",
      "then",
      "else",
      "contains",
      "additionalProperties",
      "unevaluatedProperties",
      "$defs",
      "definitions",
      "patternProperties",
      "dependentSchemas",
    ]) {
      const child = node[keyword];
      if (Array.isArray(child))
        for (const value of child) visit(value, path, false, depth + 1);
      else if (child && typeof child === "object") {
        if (
          [
            "$defs",
            "definitions",
            "patternProperties",
            "dependentSchemas",
          ].includes(keyword)
        )
          for (const value of Object.values(child))
            visit(value, path, false, depth + 1);
        else visit(child, path, false, depth + 1);
      }
    }
  }
  visit(schema, [], true, 0);
  return bindings;
}
export function parameterHeaders(bindings: HeaderBinding[], args: unknown) {
  const headers: Record<string, string> = {};
  for (const binding of bindings) {
    let value = args;
    for (const key of binding.path) {
      value =
        value && typeof value === "object" && Object.hasOwn(value, key)
          ? (value as WireObject)[key]
          : undefined;
      if (value === undefined) break;
    }
    if (value === undefined) continue;
    invariant(
      binding.type === "integer"
        ? Number.isSafeInteger(value)
        : typeof value === binding.type,
      "MCP header parameter has invalid type",
    );
    headers["Mcp-Param-" + binding.name] = mcpHeaderValue(value);
  }
  return headers;
}
