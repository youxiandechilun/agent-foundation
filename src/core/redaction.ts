import { AsyncLocalStorage } from "node:async_hooks";

export type RedactionMode = "full" | "registered" | "off";
interface Settings {
  mode: RedactionMode;
  environment?: readonly string[];
}
interface State {
  settings: Settings;
  secrets: Map<string, number>;
  escaped: Map<string, string>;
  closed: boolean;
  revision: number;
  nextExpiry: number;
  cached?: {
    revision: number;
    globalRevision: number;
    environment: string;
    redact: Redactor;
  };
}
const state = (settings: Settings): State => ({
  settings: { ...settings, environment: [...(settings.environment ?? [])] },
  secrets: new Map(),
  escaped: new Map(),
  closed: false,
  revision: 0,
  nextExpiry: Infinity,
});
const fallback = state({ mode: "full" });
const storage = new AsyncLocalStorage<State>();
const owners = new WeakMap<State, RedactionScope>();
const current = () => storage.getStore() ?? fallback;

/** Explicit owner for SDK/service entry points; async continuations retain the owner. */
export class RedactionScope {
  private readonly state: State;
  private readonly bound = new WeakSet<object>();
  constructor(settings: Settings) {
    this.state = state(settings);
    owners.set(this.state, this);
  }
  run<T>(operation: () => T): T {
    return storage.getStore() === this.state
      ? operation()
      : storage.run(this.state, operation);
  }
  register(value: string, ttlMs?: number): void {
    this.run(() => registerSecret(value, ttlMs));
  }
  bind<T extends object>(target: T): T {
    if (this.bound.has(target)) return target;
    this.bound.add(target);
    const keys = new Set<PropertyKey>();
    for (
      let prototype: object | null = target;
      prototype && prototype !== Object.prototype;
      prototype = Object.getPrototypeOf(prototype) as object | null
    ) {
      for (const key of Reflect.ownKeys(prototype)) {
        if (key === "constructor" || keys.has(key)) continue;
        keys.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
        const owner = prototype;
        const run = <R>(operation: () => R) => this.run(operation);
        if (typeof descriptor.value === "function") {
          const method: (...args: unknown[]) => unknown = descriptor.value;
          Object.defineProperty(target, key, {
            ...descriptor,
            value: function (this: object, ...args: unknown[]) {
              return run(() =>
                Reflect.apply(
                  owner === target
                    ? method
                    : (Reflect.get(owner, key, this) as (
                        ...args: unknown[]
                      ) => unknown),
                  this,
                  args,
                ),
              );
            },
          });
        } else if (descriptor.get) {
          const get = descriptor.get;
          Object.defineProperty(target, key, {
            ...descriptor,
            get: function (this: object) {
              return run(() => Reflect.apply(get, this, []));
            },
          });
        }
      }
    }
    return target;
  }
  close() {
    this.state.closed = true;
    this.state.secrets.clear();
    this.state.escaped.clear();
    this.state.cached = undefined;
    this.state.revision++;
    this.state.nextExpiry = Infinity;
  }
}
export function captureRedaction<T extends object>(target: T): T {
  return owners.get(current())?.bind(target) ?? target;
}

function activeSecrets(owner: State) {
  const time = Date.now();
  if (time >= owner.nextExpiry) {
    owner.nextExpiry = Infinity;
    for (const [secret, expiresAt] of owner.secrets) {
      if (expiresAt <= time) {
        owner.secrets.delete(secret);
        owner.revision++;
      } else owner.nextExpiry = Math.min(owner.nextExpiry, expiresAt);
    }
  }
  return owner.secrets.keys();
}
function secretsFor(owner: State) {
  // Explicit host registrations outside a kernel preserve their legacy global scope.
  const secrets = new Set(activeSecrets(fallback));
  if (owner !== fallback)
    for (const secret of activeSecrets(owner)) secrets.add(secret);
  return secrets;
}
export function processSecretSnapshot() {
  const owner = current();
  return owner.settings.mode === "off" ? [] : [...secretsFor(owner)];
}
export function registerSecret(value: string, ttlMs?: number) {
  const owner = current();
  if (owner.closed) return;
  const expiresAt =
    ttlMs === undefined ? Infinity : Date.now() + Math.max(1, ttlMs);
  if (ttlMs !== undefined) activeSecrets(owner);
  const add = (secret: string) => {
    const previous = owner.secrets.get(secret);
    if (previous === undefined) owner.revision++;
    const expiry = Math.max(previous ?? 0, expiresAt);
    owner.secrets.set(secret, expiry);
    owner.nextExpiry = Math.min(owner.nextExpiry, expiry);
  };
  if (value.length >= 8) {
    add(value);
    add(JSON.stringify(value).slice(1, -1));
    const raw = value.replace(/^(Bearer|Basic)\s+/i, "");
    if (raw.length >= 8) {
      add(raw);
      add(JSON.stringify(raw).slice(1, -1));
    }
  }
}
/** Standalone helpers use the host default; a kernel always owns a separate scope. */
export function configureRedaction(next: Settings) {
  current().settings = { ...next, environment: [...(next.environment ?? [])] };
  current().cached = undefined;
}
interface Redactor {
  (text: string): string;
  readonly shortest: number;
}
const unredacted: Redactor = Object.assign((text: string) => text, {
  shortest: Infinity,
});
const credentialName = /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i;

/** Sparse Aho-Corasick automaton. Packed arrays avoid one Map per secret character. */
function compileRedactor(secrets: ReadonlySet<string>): Redactor {
  if (!secrets.size) return unredacted;
  const first = [-1],
    failures = [0],
    lengths = [0];
  const characters: number[] = [],
    targets: number[] = [],
    next: number[] = [];
  const root = new Map<number, number>();
  let shortest = Infinity;
  const transition = (node: number, character: number) => {
    if (!node) return root.get(character) ?? -1;
    for (let edge = first[node]; edge !== -1; edge = next[edge])
      if (characters[edge] === character) return targets[edge];
    return -1;
  };
  for (const secret of secrets) {
    shortest = Math.min(shortest, secret.length);
    let node = 0;
    for (let i = 0; i < secret.length; i++) {
      const character = secret.charCodeAt(i);
      let child = transition(node, character);
      if (child === -1) {
        child = first.length;
        first.push(-1);
        failures.push(0);
        lengths.push(0);
        characters.push(character);
        targets.push(child);
        next.push(first[node]);
        first[node] = characters.length - 1;
        if (!node) root.set(character, child);
      }
      node = child;
    }
    lengths[node] = Math.max(lengths[node], secret.length);
  }
  const queue = [...root.values()];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (let edge = first[node]; edge !== -1; edge = next[edge]) {
      const child = targets[edge],
        character = characters[edge];
      let fallbackNode = failures[node],
        target = transition(fallbackNode, character);
      while (fallbackNode && target === -1) {
        fallbackNode = failures[fallbackNode];
        target = transition(fallbackNode, character);
      }
      failures[child] = target === -1 ? 0 : target;
      lengths[child] = Math.max(lengths[child], lengths[failures[child]]);
      queue.push(child);
    }
  }
  const nodeFirst = Int32Array.from(first),
    nodeFail = Uint32Array.from(failures),
    nodeLength = Uint32Array.from(lengths);
  const edgeChars = Uint16Array.from(characters),
    edgeTargets = Uint32Array.from(targets),
    edgeNext = Int32Array.from(next);
  const step = (node: number, character: number) => {
    if (!node) return root.get(character) ?? -1;
    for (let edge = nodeFirst[node]; edge !== -1; edge = edgeNext[edge])
      if (edgeChars[edge] === character) return edgeTargets[edge];
    return -1;
  };
  first.length =
    failures.length =
    lengths.length =
    characters.length =
    targets.length =
    next.length =
    queue.length =
      0;
  const smallSet = secrets.size <= 16 ? [...secrets] : undefined;
  return Object.assign(
    (text: string) => {
      if (text.length < shortest) return text;
      if (smallSet && !smallSet.some((secret) => text.includes(secret)))
        return text;
      let node = 0;
      const starts: number[] = [],
        ends: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const character = text.charCodeAt(i);
        let target = step(node, character);
        while (node && target === -1) {
          node = nodeFail[node];
          target = step(node, character);
        }
        node = target === -1 ? 0 : target;
        if (!nodeLength[node]) continue;
        let start = i + 1 - nodeLength[node];
        // Merge every overlapping match, including a longer match ending later.
        while (ends.length && ends[ends.length - 1] > start) {
          start = Math.min(start, starts.pop()!);
          ends.pop();
        }
        starts.push(start);
        ends.push(i + 1);
      }
      if (!starts.length) return text;
      const parts: string[] = [];
      let offset = 0;
      for (let i = 0; i < starts.length; i++) {
        parts.push(text.slice(offset, starts[i]), "[REDACTED]");
        offset = ends[i];
      }
      parts.push(text.slice(offset));
      return parts.join("");
    },
    { shortest },
  );
}

function secretRedactor(): Redactor {
  const owner = current();
  const { mode, environment = [] } = owner.settings;
  if (mode === "off") return unredacted;
  activeSecrets(fallback);
  if (owner !== fallback) activeSecrets(owner);
  const environmentSecrets: string[] = [];
  const names =
    mode === "full"
      ? Object.getOwnPropertyNames(process.env).filter((name) =>
          credentialName.test(name),
        )
      : environment;
  for (const name of names) {
    const value = process.env[name];
    if (value && value.length >= 8) {
      environmentSecrets.push(value);
      let escaped = owner.escaped.get(value);
      if (escaped === undefined) {
        escaped = JSON.stringify(value).slice(1, -1);
        if (owner.escaped.size >= 256) owner.escaped.clear();
        owner.escaped.set(value, escaped);
      }
      environmentSecrets.push(escaped);
    }
  }
  const environmentKey = JSON.stringify(environmentSecrets);
  const cached = owner.cached;
  if (
    cached?.revision === owner.revision &&
    cached.globalRevision === fallback.revision &&
    cached.environment === environmentKey
  )
    return cached.redact;
  const secrets = secretsFor(owner);
  for (const value of environmentSecrets) secrets.add(value);
  const redact = compileRedactor(secrets);
  owner.cached = {
    revision: owner.revision,
    globalRevision: fallback.revision,
    environment: environmentKey,
    redact,
  };
  return redact;
}
export function redactSecrets(text: string): string {
  return secretRedactor()(text);
}
export function createJsonRedactor(): (value: unknown) => string {
  const redact = secretRedactor();
  if (redact.shortest === Infinity) return (value) => JSON.stringify(value);
  return (value) =>
    redact(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "string" && item.length >= redact.shortest
          ? redact(item)
          : item,
      ),
    );
}
export function redactJsonText(value: unknown): string {
  return createJsonRedactor()(value);
}
export function redactJson<T>(value: T): T {
  return JSON.parse(redactJsonText(value)) as T;
}
