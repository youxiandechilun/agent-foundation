import { Type } from "typebox";
import { now } from "../core/util.js";
import type { BuiltinTools } from "./builtin.js";

export function registerMemory({ k, session, runId, add }: BuiltinTools): void {
  add(
    "memory_search",
    "Search actual persistent project memory by keywords or configured semantic embeddings.",
    Type.Object({
      query: Type.String(),
      namespace: Type.Optional(Type.String()),
      semantic: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    "read",
    ["memory.read"],
    async (args, signal) =>
      args.semantic
        ? k.memory.semanticSearch(
            session.projectId,
            args.query,
            args.limit,
            args.namespace,
            signal,
          )
        : k.memory.search(
            session.projectId,
            args.query,
            args.limit,
            args.namespace,
          ),
  );
  add(
    "memory_read",
    "Read a complete non-expired project memory by its actual ID.",
    Type.Object({ id: Type.String() }),
    "read",
    ["memory.read"],
    async (args) => k.memory.get(args.id, session.projectId),
  );
  add(
    "memory_save",
    "Save an explicit durable user fact/preference. Do not store credentials or inferred facts.",
    Type.Object({
      content: Type.String({ maxLength: 32000 }),
      tags: Type.Optional(Type.Array(Type.String())),
      namespace: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
    }),
    "write",
    ["memory.write"],
    async (args) =>
      k.memory.put({
        ...args,
        projectId: session.projectId,
        source: `run:${runId}`,
      }),
  );
  add(
    "memory_delete",
    "Delete a specific project memory.",
    Type.Object({ id: Type.String() }),
    "write",
    ["memory.write"],
    async (args) => {
      k.memory.remove(args.id, session.projectId);
      return { deleted: true };
    },
  );
}

export function registerPlan({ k, runId, add }: BuiltinTools): void {
  add(
    "plan_update",
    "Persist a work plan and actual progress for the current run.",
    Type.Object({
      steps: Type.Array(
        Type.Object({
          title: Type.String({ maxLength: 300 }),
          status: Type.Union([
            Type.Literal("pending"),
            Type.Literal("running"),
            Type.Literal("completed"),
            Type.Literal("blocked"),
          ]),
        }),
        { maxItems: 50 },
      ),
    }),
    "write",
    [],
    async (args) => {
      const plan = k.store.put("work-plans", {
        id: runId,
        steps: args.steps,
        updatedAt: now(),
      });
      k.store.emit(runId, "plan.updated", { plan });
      return plan;
    },
  );
}

export function registerTranscript({ k, session, add }: BuiltinTools): void {
  add(
    "transcript_read",
    "Read earlier canonical session messages to recover details omitted from model context.",
    Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    "read",
    ["files.read"],
    async (args) => ({
      messages: k.store.transcriptSlice(
        session.id,
        args.offset || 0,
        args.limit || 10,
      ).messages,
    }),
  );
}
