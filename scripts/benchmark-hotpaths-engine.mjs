// @ts-check
import assert from "node:assert/strict";
import { localProvider } from "./benchmark-hotpaths-fixtures.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {import("../src/storage/store.js").Store} Store */
/** This measures real Engine, context, schema validation, tool effects, normalization, transcripts and events.
 * @param {string} directory @param {Store} store @param {string} scratch @param {number} count @param {string} secret
 * @param {(runId: string, type: string, data: Record<string, unknown>) => void} ephemeral
 * @returns {Promise<import("./benchmark-hotpaths-worker.mjs").Scenario>}
 */
export async function createEngineScenario(
  directory,
  store,
  scratch,
  count,
  secret,
  ephemeral,
) {
  const load = (/** @type {string} */ name) =>
    import(pathToFileURL(path.join(directory, name)).href);
  /** @type {typeof import("../src/runtime/engine.js")} */
  const { ExecutionEngine } = await load("runtime/engine.js");
  /** @type {typeof import("../src/providers/text.js")} */
  const { HttpTextProvider } = await load("providers/text.js");
  /** @type {typeof import("../src/core/config.js")} */
  const { parseConfig } = await load("core/config.js");
  /** @type {typeof import("../src/core/context.js")} */
  const { ContextManager } = await load("core/context.js");
  /** @type {typeof import("../src/storage/assets.js")} */
  const { Assets } = await load("storage/assets.js");
  /** @type {typeof import("../src/runtime/tool-result.js")} */
  const { normalizeToolResult } = await load("runtime/tool-result.js");
  /** @type {typeof import("../src/runtime/scheduler.js")} */
  const { ToolScheduler } = await load("runtime/scheduler.js");
  const provider = await localProvider(secret);
  try {
    const config = parseConfig({
      dataDir: scratch,
      workspaceRoots: [scratch],
      defaultRoutes: { chat: "text", code: "text", office: "text" },
      routes: {
        text: {
          kind: "text",
          adapter: "openai-completions",
          model: "benchmark",
          baseUrl: provider.url,
          contextWindow: 128000,
          maxOutputTokens: 1000,
        },
      },
    });
    const assets = new Assets(store, config),
      context = new ContextManager(store, config);
    const history = Array.from({ length: 24 }, (_, i) => ({
      role: /** @type {const} */ ("user"),
      content: `history-${i}: ${"history ".repeat(32)}`,
      timestamp: i,
    }));
    store.put("projects", {
      id: "project",
      name: "benchmark",
      root: scratch,
      createdAt: new Date(0).toISOString(),
    });
    for (let i = 0; i < count; i++) {
      store.put("sessions", {
        id: `session-${i}`,
        projectId: "project",
        routeId: "text",
        mode: "code",
      });
      store.put("runs", {
        id: `run-${i}`,
        sessionId: `session-${i}`,
        status: "running",
      });
      store.saveTranscript(
        `session-${i}`,
        history.map((message, index) => ({
          id: `history-${index}`,
          runId: `run-${i}`,
          message,
        })),
      );
    }
    /** @type {{status: string, error?: string, steps: number}[]} */
    const outcomes = [];
    /** @type {number[]} */
    const totals = [];
    return {
      operations: count,
      parameters: {
        engineRuns: count,
        modelStepsPerRun: 3,
        toolsPerRun: 2,
        historyMessages: history.length,
        historyBytes: Buffer.byteLength(JSON.stringify(history)),
        toolOutputPaddingCharacters: 1024,
        finalResponseBytes: Buffer.byteLength(provider.finalText),
        deltaCharacters: 32,
        liveListener: false,
        transport: "loopback HTTP/SSE; no external model inference",
      },
      run: async () => {
        for (let i = 0; i < count; i++) {
          let total = 0;
          /** @type {import("../src/runtime/types.js").ToolDefinition<{value: number}>[]} */
          const tools = [
            {
              name: "benchmark_accumulate",
              description: "Accumulate a validated number",
              parameters: {
                type: "object",
                properties: {
                  value: { type: "integer", minimum: 1, maximum: 2 },
                },
                required: ["value"],
                additionalProperties: false,
              },
              risk: "read",
              scheduling: { parallelSafe: true, resources: () => [] },
              execute: async (_id, args) => {
                total += args.value;
                return {
                  content: [
                    {
                      type: "text",
                      text: `total=${total}; ${secret} ${"x".repeat(1024)}`,
                    },
                  ],
                };
              },
            },
          ];
          const runId = `run-${i}`,
            sessionId = `session-${i}`;
          const engine = new ExecutionEngine({
            runId,
            routeId: "text",
            instructions:
              "Complete two accumulation steps then report the total.",
            history,
            tools,
            provider: new HttpTextProvider("text", config.routes.text),
            maxSteps: 4,
            maxToolCalls: 2,
            maxMessages: 100,
            timeoutMs: 30000,
            scheduler: new ToolScheduler(4),
            store,
            normalizeResult: (result, signal) =>
              normalizeToolResult(
                result,
                assets,
                "project",
                config.limits.maxOutputBytes,
                signal,
              ),
            publish: (type, data, durable = true) => {
              if (durable) store.emit(runId, type, data);
              else ephemeral(runId, type, data);
            },
            checkpoint: (message, id) =>
              store.appendTranscript(sessionId, { id, runId, message }),
            prepare: (messages, signal) =>
              context.prepare(runId, "text", messages, signal, tools),
          });
          outcomes.push(
            await engine.run({
              role: "user",
              content: `Accumulate 1 then 2. ${secret}`,
              timestamp: 100,
            }),
          );
          totals.push(total);
        }
      },
      verify: () => {
        provider.verify(count * 3);
        for (let i = 0; i < count; i++) {
          assert.deepEqual(outcomes[i], { status: "completed", steps: 3 });
          assert.equal(totals[i], 3);
          const transcript = store.transcript(`session-${i}`);
          assert.equal(transcript.length, history.length + 6);
          assert.ok(!JSON.stringify(transcript).includes(secret));
          const last = transcript.at(-1)?.message;
          assert.ok(last?.role === "assistant");
          assert.deepEqual(last.content, [
            { type: "text", text: provider.finalText },
          ]);
          assert.equal(
            store
              .replay(`run-${i}`)
              .filter((event) => event.type === "model-step.completed").length,
            3,
          );
        }
      },
      close: provider.close,
    };
  } catch (error) {
    await provider.close();
    throw error;
  }
}
