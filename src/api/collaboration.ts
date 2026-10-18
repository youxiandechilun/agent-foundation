import type { Session } from "../contracts.js";
import type { ApiContext, ApiResult } from "./shared.js";

export async function collaborationApi(
  context: ApiContext,
): Promise<ApiResult | undefined> {
  const {
    k: kernel,
    json,
    method,
    parts: [version, key, id, op],
  } = context;
  if (version !== "v1") return;
  if (context.parts.length > 4) {
    if (
      context.parts.length === 5 &&
      key === "sessions" &&
      id &&
      op === "role-review" &&
      context.parts[4] === "decision" &&
      method === "POST"
    )
      return { data: kernel.teams.resolveRoleReview(id, await json()) };
    return;
  }
  if (key === "teams") {
    if (!id && method === "GET")
      return { data: { teams: kernel.teams.list() } };
    if (!id && method === "POST")
      return { data: kernel.teams.put(await json()), status: 201 };
    if (id && !op && method === "GET") return { data: kernel.teams.get(id) };
    if (id && !op && method === "DELETE") {
      kernel.teams.remove(id);
      return { data: { deleted: true } };
    }
  }
  if (key === "sessions" && id && op === "collaboration") {
    if (method === "GET")
      return { data: kernel.store.session(id).collaboration || null };
    if (method === "PUT")
      return { data: kernel.teams.configure(id, await json()) };
    if (method === "DELETE") return { data: kernel.teams.configure(id, null) };
  }
  if (key === "sessions" && id && op === "branches" && method === "GET") {
    const session = kernel.store.session(id);
    const sessions = kernel.store.list<Session>("sessions", {
      projectId: session.projectId,
    });
    const byId = new Map(sessions.map((entry) => [entry.id, entry]));
    const children = new Map<string, string[]>();
    for (const entry of sessions) {
      if (!entry.forkedFromSessionId) continue;
      const siblings = children.get(entry.forkedFromSessionId) || [];
      siblings.push(entry.id);
      children.set(entry.forkedFromSessionId, siblings);
    }
    const ids = new Set([session.id]);
    let current = session;
    while (
      current.forkedFromSessionId &&
      !ids.has(current.forkedFromSessionId)
    ) {
      const parent = byId.get(current.forkedFromSessionId);
      if (!parent) break;
      ids.add(parent.id);
      current = parent;
    }
    // Set iteration also visits new descendants, while cycles remain bounded.
    for (const parentId of ids)
      for (const childId of children.get(parentId) || []) ids.add(childId);
    return {
      data: {
        branches: sessions
          .filter((entry) => ids.has(entry.id))
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            forkedFromSessionId: entry.forkedFromSessionId,
            forkedThroughMessageId: entry.forkedThroughMessageId,
          })),
      },
    };
  }
}
