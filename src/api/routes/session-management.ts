import { z } from "zod";
import { invariant } from "../../core/util.js";
import type { ToolEffect, InboxEntry } from "../../contracts.js";
import type { MigrationReceipt } from "../../sessions/migration.js";
import { entityList } from "../shared.js";
import { apiRoutes, input, status } from "../route-table.js";
import { sessionExport } from "../session-export.js";

export const sessionManagementRoutes = apiRoutes({
  "POST sessions/:id/process-actions": status(
    202,
    input(
      z
        .object({
          action: z.enum(["start", "read", "write", "resize", "stop", "list"]),
          arguments: z.record(z.string(), z.unknown()).default({}),
        })
        .strict(),
      ({ k, id }, value) => k.processAction(id, value.action, value.arguments),
    ),
  ),
  "GET sessions/:id/migration": ({ k, id, signal }) =>
    k.exportMigration(id, signal),
  "POST migrations/import": status(
    201,
    input(
      z
        .object({
          projectId: z.string(),
          bundle: z.unknown(),
          key: z.string().min(1).max(180),
          routeId: z.string().optional(),
        })
        .strict(),
      ({ k }, value) =>
        k.importMigration(
          value.projectId,
          value.bundle,
          value.key,
          value.routeId,
        ),
    ),
  ),
  "GET migrations": ({ k, url }) => {
    const projectId = url.searchParams.get("projectId");
    invariant(projectId, "projectId required");
    k.store.project(projectId);
    return entityList<MigrationReceipt>(
      { k, url },
      "session-migrations",
      "migrations",
      { projectId },
    );
  },
  "POST sessions/import": status(
    201,
    input(
      z
        .object({
          projectId: z.string(),
          snapshot: z.unknown(),
          routeId: z.string().optional(),
        })
        .strict(),
      ({ k }, value) =>
        k.importSession(value.projectId, value.snapshot, value.routeId),
    ),
  ),
  "POST sessions/:id/rewind": input(
    z
      .object({
        throughMessageId: z.string().min(1).optional(),
        beforeMessageId: z.string().min(1).optional(),
        files: z.boolean().optional(),
        conversation: z.boolean().optional(),
        force: z.boolean().optional(),
      })
      .strict(),
    ({ k, id }, value) => k.rewind(id, value),
  ),
  "GET sessions/:id/checkpoints": (context) => {
    const { k, id } = context;
    k.store.session(id);
    return entityList(context, "checkpoints", "checkpoints", { sessionId: id });
  },
  "POST sessions/:id/fork": status(201, async ({ k, id, json }) =>
    k.forkSession(id, (await json()).throughMessageId),
  ),
  "GET sessions/:id/export": (context) => sessionExport(context, context.id),
  "GET runs/:id/context": ({ k, id }) => {
    k.store.run(id);
    return k.store.find("work-contexts", id) || { status: "not-prepared" };
  },
  "POST runs/:id/resume": status(202, ({ k, id }) => k.resume(id)),
  "GET runs/:id/effects": (context) =>
    entityList<ToolEffect>(context, "effects", "effects", {
      runId: context.id,
    }),
  "GET runs/:id/inbox": (context) =>
    entityList<InboxEntry>(context, "inbox", "inputs", { runId: context.id }),
  "GET runs/:id/plan": ({ k, id }) =>
    k.store.find("work-plans", id) || { steps: [] },
});
