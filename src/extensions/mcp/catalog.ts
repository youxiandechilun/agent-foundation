import { invariant } from "../../core/util.js";

/** All MCP catalogs share the same page, item and cursor limits. */
export async function collectCatalog<T>(
  readPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: unknown }>,
  validate: () => void,
): Promise<T[]> {
  const items: T[] = [],
    cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await readPage(cursor);
    validate();
    invariant(Array.isArray(result.items), "Invalid MCP catalog", 502);
    items.push(...result.items);
    invariant(items.length <= 2000, "MCP catalog exceeds limit");
    if (!result.nextCursor) return items;
    invariant(
      typeof result.nextCursor === "string" && !cursors.has(result.nextCursor),
      "MCP repeated or invalid pagination cursor",
      502,
    );
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  throw new Error("MCP catalog pagination exceeds limit");
}
