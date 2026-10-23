import { z } from "zod";
import type { MemoryEntry, MemoryProposal } from "../../contracts.js";
import { invariant } from "../../core/util.js";
import { apiRoutes, input, status } from "../route-table.js";
import { cursor, entityList, type ApiContext } from "../shared.js";
import { memoryExport } from "../memory-export.js";
import { Capacity } from "../../runtime/capacity.js";
import type { Kernel } from "../../core/kernel.js";

const searches = new WeakMap<Kernel, Capacity>();
async function memorySearch<T>(
  context: ApiContext,
  operation: () => Promise<T>,
) {
  let capacity = searches.get(context.k);
  if (!capacity) {
    capacity = new Capacity(
      context.k.config.limits.maxConcurrentMemorySearches,
    );
    searches.set(context.k, capacity);
  }
  const release = capacity.reserve();
  try {
    return await operation();
  } finally {
    release();
  }
}

function projectId({ url }: ApiContext): string {
  const value = url.searchParams.get("projectId");
  invariant(value, "projectId required");
  return value;
}

export const memoryRoutes = apiRoutes({
  "GET memories": (context) => {
    const { k, url } = context,
      project = projectId(context);
    const query = url.searchParams.get("q"),
      namespace = url.searchParams.get("namespace") || undefined;
    if (!query) {
      const page = k.memory.page(
        project,
        namespace,
        cursor(url.searchParams.get("after")),
        Number(url.searchParams.get("limit") ?? 100),
      );
      return {
        memories: page.items,
        cursor: page.cursor,
        hasMore: page.hasMore,
      };
    }
    return {
      memories: k.memory.search(
        project,
        query,
        Number(url.searchParams.get("limit") || 8),
        namespace,
      ),
    };
  },
  "POST memories": status(201, async ({ k, json }) =>
    k.memory.put(await json()),
  ),
  "GET memories/:id": ({ k, id }) => {
    invariant(
      !["export", "import", "merge", "prune", "semantic-search"].includes(id),
      "Endpoint not found",
      404,
      "not_found",
    );
    const memory = k.store.get<MemoryEntry>("memories", id);
    return k.memory.get(id, memory.projectId);
  },
  "DELETE memories/:id": ({ k, id }) => {
    const memory = k.store.get<MemoryEntry>("memories", id);
    k.memory.remove(id, memory.projectId);
    return { deleted: true };
  },
  "GET memories/export": memoryExport,
  "POST memories/import": input(
    z
      .object({
        projectId: z.string(),
        entries: z.array(z.unknown()).max(10000),
      })
      .strict(),
    async ({ k, signal }, value) => ({
      memories: await k.memory.importAsync(
        value.projectId,
        value.entries,
        signal,
      ),
    }),
  ),
  "POST memories/merge": input(
    z
      .object({
        projectId: z.string(),
        ids: z.array(z.string()).min(2).max(100),
        content: z.string().min(1).max(32000),
      })
      .strict(),
    ({ k }, value) => k.memory.merge(value.projectId, value.ids, value.content),
  ),
  "POST memories/prune": input(
    z.object({ projectId: z.string() }).strict(),
    ({ k }, value) => k.memory.pruneExpired(value.projectId),
  ),
  "POST memories/semantic-search": async (context) => {
    const { k, json, signal } = context;
    const value = await json();
    return {
      memories: await memorySearch(context, () =>
        k.memory.semanticSearch(
          value.projectId,
          value.query,
          value.limit,
          value.namespace,
          signal,
        ),
      ),
    };
  },
  "GET memories/:id/history": (context) => ({
    revisions: context.k.memory.history(context.id, projectId(context)),
  }),
  "POST memories/:id/embed": (context) =>
    memorySearch(context, () =>
      context.k.memory.embed(context.id, context.signal),
    ),
  "GET memory-proposals": (context) => {
    const project = projectId(context);
    context.k.store.project(project);
    return entityList<MemoryProposal>(
      context,
      "memory-proposals",
      "proposals",
      { projectId: project },
    );
  },
  "POST memory-proposals/:id/resolve": input(
    z.object({ allow: z.boolean() }).strict(),
    ({ k, id }, value) => {
      invariant(
        !value.allow || k.config.permissions["memory.write"] !== "deny",
        "Memory writes disabled",
        403,
      );
      return k.memory.resolve(id, value.allow);
    },
  ),
});
