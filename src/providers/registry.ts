import { invariant } from "../core/util.js";
import type { TextProtocol } from "./protocol.js";
import { openaiCompletions } from "./protocols/openai-completions.js";
import { openaiResponses } from "./protocols/openai-responses.js";
import { anthropicMessages } from "./protocols/anthropic-messages.js";

// Adapters that select media or embedding handlers rather than a text protocol.
const reserved = new Set([
  "image-json",
  "video-job",
  "media-http",
  "custom-media",
  "openai-embeddings",
]);
const protocols = new Map<string, TextProtocol>(
  [openaiCompletions, openaiResponses, anthropicMessages].map((p) => [p.id, p]),
);

/**
 * Register a text wire protocol under its `id`, the value routes use as `adapter`.
 * Register before loading configuration that names it; built-in protocols cannot be replaced.
 */
export function registerTextProtocol(protocol: TextProtocol): () => void {
  invariant(
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(protocol.id) &&
      !protocols.has(protocol.id) &&
      !reserved.has(protocol.id),
    "Duplicate or invalid text protocol ID",
  );
  protocols.set(protocol.id, protocol);
  return () => {
    if (protocols.get(protocol.id) === protocol) protocols.delete(protocol.id);
  };
}

export const findTextProtocol = (adapter: string): TextProtocol | undefined =>
  protocols.get(adapter);

export function textProtocol(adapter: string): TextProtocol {
  const protocol = protocols.get(adapter);
  invariant(protocol, `Unknown text protocol ${adapter}`, 503);
  return protocol;
}

export const textProtocolIds = () => [...protocols.keys()];
