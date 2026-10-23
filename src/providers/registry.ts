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

/** Return a fresh adapter, including any mutable closure/private state, per registry. */
export type TextProtocolFactory = () => TextProtocol;
interface ProtocolFactory {
  create: TextProtocolFactory;
  instances: WeakSet<TextProtocol>;
}

/** Copy plain declarations; legacy class methods need their original private-field receiver. */
function protocolSnapshot(
  protocol: TextProtocol,
  ownedState = false,
): TextProtocol {
  const snapshot: TextProtocol = {
    ...protocol,
    id: protocol.id,
    inputIncludesCache: protocol.inputIncludesCache,
    ...(protocol.headers
      ? { headers: Object.freeze({ ...protocol.headers }) }
      : {}),
    url: protocol.url,
    body: protocol.body,
    event: protocol.event,
  };
  const prototype: unknown = Object.getPrototypeOf(protocol);
  const plain = prototype === Object.prototype || prototype === null;
  const receiver = ownedState || !plain ? protocol : snapshot;
  snapshot.url = protocol.url.bind(receiver);
  snapshot.body = protocol.body.bind(receiver);
  snapshot.event = protocol.event.bind(receiver);
  snapshot.credentials = protocol.credentials?.bind(receiver);
  snapshot.toolChoice = protocol.toolChoice?.bind(receiver);
  snapshot.disableReasoning = protocol.disableReasoning?.bind(receiver);
  snapshot.enableReasoning = protocol.enableReasoning?.bind(receiver);
  snapshot.jsonEvents = protocol.jsonEvents?.bind(receiver);
  snapshot.finalize = protocol.finalize?.bind(receiver);
  return Object.freeze(snapshot);
}

/** Independent protocol assembly for one host. Instances always include built-ins. */
export class TextProtocolRegistry {
  private readonly protocols = new Map<string, TextProtocol>(
    builtins.map((p) => [p.id, protocolSnapshot(p)]),
  );
  private readonly factories = new Map<string, ProtocolFactory>();

  private checkId(id: string) {
    invariant(
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) &&
        !this.protocols.has(id) &&
        !reserved.has(id),
      "Duplicate or invalid text protocol ID",
    );
  }

  /**
   * Plain declarations use their immutable own-field copy as `this`. Legacy class
   * instances retain their original receiver; private and captured state cannot
   * be copied. Use registerFactory for independent per-Kernel state.
   */
  register(protocol: TextProtocol): () => void {
    this.checkId(protocol.id);
    const snapshot = protocolSnapshot(protocol);
    this.protocols.set(snapshot.id, snapshot);
    return () => {
      if (this.protocols.get(snapshot.id) === snapshot)
        this.protocols.delete(snapshot.id);
    };
  }

  /** Each clone/Kernel receives a fresh instance. Factories must not reuse objects or closure state. */
  registerFactory(id: string, create: TextProtocolFactory): () => void {
    this.checkId(id);
    return this.installFactory(id, { create, instances: new WeakSet() });
  }

  private installFactory(id: string, factory: ProtocolFactory): () => void {
    const protocol = factory.create();
    invariant(
      protocol.id === id,
      "Text protocol factory returned a different ID",
    );
    invariant(
      !factory.instances.has(protocol),
      "Text protocol factory must return a fresh instance",
    );
    factory.instances.add(protocol);
    const snapshot = protocolSnapshot(protocol, true);
    this.protocols.set(id, snapshot);
    this.factories.set(id, factory);
    return () => {
      if (this.protocols.get(id) !== snapshot) return;
      this.protocols.delete(id);
      this.factories.delete(id);
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
    for (const [id, protocol] of this.protocols) {
      if (snapshot.protocols.has(id)) continue;
      const factory = this.factories.get(id);
      if (factory) snapshot.installFactory(id, factory);
      else snapshot.protocols.set(id, protocol);
    }
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
