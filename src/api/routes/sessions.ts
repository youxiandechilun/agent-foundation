import { z } from "zod";
import { modeIdSchema } from "../../modes/registry.js";
import { reasoningEffortSchema } from "../../core/config.js";
import type { Project, Session, Run } from "../../contracts.js";
import { streamRunEvents } from "../events.js";
import {
  cursor,
  entityList,
  type HttpContext,
  type HttpResult,
} from "../shared.js";
import { apiRoutes, input, status } from "../route-table.js";

const reasoningFields = {
  subagentsEnabled: z.boolean().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  reasoningBudgetTokens: z.number().int().min(1024).max(1_000_000).optional(),
};
const sessionUpdate = z
  .object({
    mode: modeIdSchema.optional(),
    routeId: z.string().optional(),
    name: z.string().max(200).optional(),
    autonomy: z.enum(["plan", "assist", "autonomous"]).optional(),
    archived: z.boolean().optional(),
    agentId: z.string().optional(),
    ...reasoningFields,
    readableSessionIds: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict();

const routes = apiRoutes({
  "GET projects": (context) =>
    entityList<Project>(context, "projects", "projects"),
  "POST projects": status(
    201,
    input(
      z
        .object({
          name: z.string().min(1).max(200),
          directory: z.string().optional(),
          billingAccount: z.string().min(1).max(200).optional(),
        })
        .strict(),
      ({ k }, value) =>
        k.createProject(value.name, value.directory, {
          billingAccount: value.billingAccount,
        }),
    ),
  ),
  "GET sessions": (context) =>
    entityList<Session>(context, "sessions", "sessions", {
      projectId: context.url.searchParams.get("projectId") || undefined,
    }),
  "POST sessions": status(
    201,
    input(
      z
        .object({
          projectId: z.string(),
          mode: modeIdSchema.default("chat"),
          name: z.string().optional(),
          routeId: z.string().optional(),
          agentId: z.string().optional(),
          ...reasoningFields,
        })
        .strict(),
      ({ k }, value) =>
        k.updateSession(
          k.createSession(
            value.projectId,
            value.mode,
            value.name,
            value.routeId,
            value.agentId,
          ).id,
          {
            subagentsEnabled: value.subagentsEnabled ?? true,
            reasoningEffort: value.reasoningEffort,
            reasoningBudgetTokens: value.reasoningBudgetTokens,
          },
        ),
    ),
  ),
  "GET sessions/:id": ({ k, id, url }) => {
    const runs = k.store.page<Run>(
      "runs",
      { sessionId: id },
      cursor(url.searchParams.get("runsAfter")),
      Number(url.searchParams.get("runsLimit") ?? 100),
    );
    return {
      session: k.store.session(id),
      ...k.store.transcriptPage(
        id,
        cursor(url.searchParams.get("after")),
        Number(url.searchParams.get("limit") || 100),
      ),
      runs: runs.items,
      runsCursor: runs.cursor,
      runsHasMore: runs.hasMore,
    };
  },
  "GET sessions/:id/runs": (context) => {
    context.k.store.session(context.id);
    return entityList<Run>(context, "runs", "runs", { sessionId: context.id });
  },
  "PATCH sessions/:id": async ({ k, id, json }) => {
    k.store.session(id);
    return k.updateSession(id, sessionUpdate.parse(await json()));
  },
  "GET sessions/:id/security-audits": ({ k, id, url }) =>
    k.securityAudit.list(id, {
      limit: Number(url.searchParams.get("limit") ?? 100),
      offset: Number(url.searchParams.get("offset") ?? 0),
    }),
  "POST sessions/:id/inputs": status(202, async ({ k, id, json }) => {
    k.store.session(id);
    const result = await k.submit(id, await json());
    return { ...result, events: `/v1/runs/${result.runId}/events` };
  }),
  "GET runs/:id": ({ k, id }) => k.store.run(id),
  "POST runs/:id/cancel": status(202, ({ k, id }) => k.cancel(id)),
});

export async function sessionRoutes(context: HttpContext): Promise<HttpResult> {
  const { k, req, res, url, parts, method } = context;
  if (
    parts.length !== 4 ||
    parts[0] !== "v1" ||
    parts[1] !== "runs" ||
    parts[3] !== "events" ||
    method !== "GET"
  )
    return routes(context);
  const run = k.store.run(parts[2]);
  const after = cursor(
    url.searchParams.get("after") || req.headers["last-event-id"]?.toString(),
  );
  if (url.searchParams.get("format") === "json") {
    const events = k.store.replay(
      run.id,
      after,
      Number(url.searchParams.get("limit") ?? 1000),
      Number.MAX_SAFE_INTEGER,
      1024 * 1024,
    );
    return {
      data: {
        events,
        cursor: events.at(-1)?.seq || after,
        hasMore: k.store.eventCursor(run.id) > (events.at(-1)?.seq || after),
        status: k.store.run(run.id).status,
      },
    };
  }
  await streamRunEvents(k.store, run.id, after, res, k.config.limits);
  return true;
}
