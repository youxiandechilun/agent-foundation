// Build first: npm run build
// Run: node scripts/benchmark-optimization-runtime.mjs
// JSON on stdout; no model/network calls, fixture files, or source mutations.
import { RegexSearch } from "../dist/runtime/regex-search.js";
import { ResponseBuilder } from "../dist/providers/protocol.js";
import { anthropicMessages } from "../dist/providers/protocols/anthropic-messages.js";
import { anthropicMessages as serialize } from "../dist/providers/serialize.js";
import { estimateTokens } from "../dist/runtime/token-counter.js";
import {
  RedactionScope,
  registerSecret,
  redactSecrets,
} from "../dist/core/redaction.js";

const initializationStart = performance.now();
const matcher = new RegexSearch("^(a+)+$", false, undefined, 500, 10000);
let regex;
try {
  // Validate syntax and wait for worker startup. An empty batch does not execute
  // RegExp.test, so this is not regex JIT warmup or part of the measured match.
  await matcher.match([]);
  const initializationMs = performance.now() - initializationStart;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const start = performance.now();
  let error;
  try {
    await matcher.match(["a".repeat(100) + "!"]);
  } catch (failure) {
    error = { code: failure.code, message: failure.message };
  } finally {
    clearInterval(timer);
  }
  regex = {
    pattern: "^(a+)+$",
    chars: 101,
    initializationMs,
    matchTimeoutMs: 500,
    elapsedMs: performance.now() - start,
    hostTimerIntervalMs: 10,
    hostTimerTicks: ticks,
    timedOut: error?.code === "search_timeout",
    error,
  };
} finally {
  await matcher.close();
}

const nativeBlock = { type: "text", text: "x".repeat(64 * 1024) };
const response = new ResponseBuilder("anthropic-messages", "text", "test");
await anthropicMessages.event(
  { type: "content_block_start", index: 0, content_block: nativeBlock },
  response,
);
response.finish("stop");
anthropicMessages.finalize(response);
const message = response.output;
const legacy = {
  ...message,
  providerState: { ...message.providerState, items: [nativeBlock] },
};
const wire = JSON.stringify(serialize([message], "text"));
const anthropic = {
  textBytes: 64 * 1024,
  storedBytes: Buffer.byteLength(JSON.stringify(message)),
  legacyStoredBytes: Buffer.byteLength(JSON.stringify(legacy)),
  estimatedTokens: estimateTokens([message]),
  // Reproduce the previous estimator's whole-message JSON weight. These are
  // heuristic counts, not tokens reported by the external model provider.
  legacyWholeMessageEstimate: Math.ceil(
    Buffer.byteLength(JSON.stringify([legacy])) / 2,
  ),
  wireMessagesBytes: Buffer.byteLength(wire),
  replayUnchanged: wire === JSON.stringify(serialize([legacy], "text")),
};

const redaction = [];
for (const count of [0, 1000, 10000]) {
  const scope = new RedactionScope({ mode: "registered" });
  try {
    scope.run(() => {
      for (let i = 0; i < count; i++)
        registerSecret(`dummy-key-${i}-` + "k".repeat(24));
      const payload = "z".repeat(128 * 1024);
      const samplesMs = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        redactSecrets(payload);
        samplesMs.push(performance.now() - start);
      }
      redaction.push({
        registered: count,
        payloadKiB: 128,
        samplesMs,
        coldMs: samplesMs[0],
        medianMs: samplesMs.toSorted((a, b) => a - b)[2],
      });
    });
  } finally {
    scope.close();
  }
}

console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      regex,
      anthropic,
      redaction,
      limits: [
        "Synthetic single-process measurements; RSS, retained heap, real providers and production throughput are not measured.",
        "The regex result tests isolation, timeout and host responsiveness. It is not a speedup ratio against the prior main-thread probe, which used different input lengths and a 2000 ms parent timeout.",
        "Anthropic sizes cover one 64 KiB ASCII text block. Replay equality is checked; heuristic token counts are not actual model tokenizer counts.",
        "Redaction uses no-match text and synthetic keys. Five samples include one cold matcher compilation and four warm calls; cold time is reported separately. Cross-run timing varies with machine load and JIT state.",
      ],
    },
    null,
    2,
  ),
);
