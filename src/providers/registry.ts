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
const builtins = [openaiCompletions, openaiResponses, anthropicMessages];

/** Independent protocol assembly for one host. Instances always include built-ins. */
export class TextProtocolRegistry {
  private readonly protocols = new Map<string, TextProtocol>(
    builtins.map((p) => [p.id, p]),
  );

  register(protocol: TextProtocol): () => void {
    invariant(
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(protocol.id) &&
        !this.protocols.has(protocol.id) &&
        !reserved.has(protocol.id),
      "Duplicate or invalid text protocol ID",
    );
    // Do not let later mutations of a caller's declaration change a live host.
    const snapshot = Object.freeze({
      ...protocol,
      id: protocol.id,
      url: protocol.url.bind(protocol),
      body: protocol.body.bind(protocol),
      event: protocol.event.bind(protocol),
      credentials: protocol.credentials?.bind(protocol),
      toolChoice: protocol.toolChoice?.bind(protocol),
      disableReasoning: protocol.disableReasoning?.bind(protocol),
      enableReasoning: protocol.enableReasoning?.bind(protocol),
      jsonEvents: protocol.jsonEvents?.bind(protocol),
      finalize: protocol.finalize?.bind(protocol),
      inputIncludesCache: protocol.inputIncludesCache,
      ...(protocol.headers
        ? { headers: Object.freeze({ ...protocol.headers }) }
        : {}),
    });
    this.protocols.set(snapshot.id, snapshot);
    return () => {
      if (this.protocols.get(snapshot.id) === snapshot)
        this.protocols.delete(snapshot.id);
    };
  }

  find(adapter: string): TextProtocol | undefined {
    return this.protocols.get(adapter);
  }
  get(adapter: string): TextProtocol {
    const protocol = this.find(adapter);
    invariant(protocol, `Unknown text protocol ${adapter}`, 503);
    return protocol;
  }
  ids(): string[] {
    return [...this.protocols.keys()];
  }
  clone(): TextProtocolRegistry {
    const snapshot = new TextProtocolRegistry();
    for (const [id, protocol] of this.protocols)
      if (!snapshot.protocols.has(id)) snapshot.protocols.set(id, protocol);
    return snapshot;
  }
}

/** Legacy process-wide assembly, used by standalone helpers unless explicitly injected. */
export const defaultTextProtocols = new TextProtocolRegistry();

/**
 * Register a text wire protocol under its `id`, the value routes use as `adapter`.
 * Register before loading configuration that names it; built-in protocols cannot be replaced.
 */
export function registerTextProtocol(protocol: TextProtocol): () => void {
  return defaultTextProtocols.register(protocol);
}

export const findTextProtocol = (adapter: string): TextProtocol | undefined =>
  defaultTextProtocols.find(adapter);

export function textProtocol(adapter: string): TextProtocol {
  return defaultTextProtocols.get(adapter);
}

export const textProtocolIds = () => defaultTextProtocols.ids();
