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
}
const state = (settings: Settings): State => ({
  settings: { ...settings, environment: [...(settings.environment ?? [])] },
  secrets: new Map(),
  escaped: new Map(),
  closed: false,
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
  }
}
export function captureRedaction<T extends object>(target: T): T {
  return owners.get(current())?.bind(target) ?? target;
}

function activeSecrets(owner: State) {
  const time = Date.now();
  for (const [secret, expiresAt] of owner.secrets)
    if (expiresAt <= time) owner.secrets.delete(secret);
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
  const add = (secret: string) =>
    owner.secrets.set(
      secret,
      Math.max(owner.secrets.get(secret) || 0, expiresAt),
    );
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
}
interface Redactor {
  (text: string): string;
  readonly shortest: number;
}
const unredacted: Redactor = Object.assign((text: string) => text, {
  shortest: Infinity,
});
const credentialName = /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i;
function secretRedactor(): Redactor {
  const owner = current();
  const { mode, environment = [] } = owner.settings;
  if (mode === "off") return unredacted;
  const secrets = secretsFor(owner);
  const names =
    mode === "full"
      ? Object.getOwnPropertyNames(process.env).filter((name) =>
          credentialName.test(name),
        )
      : environment;
  for (const name of names) {
    const value = process.env[name];
    if (value && value.length >= 8) {
      secrets.add(value);
      let escaped = owner.escaped.get(value);
      if (escaped === undefined) {
        escaped = JSON.stringify(value).slice(1, -1);
        if (owner.escaped.size >= 256) owner.escaped.clear();
        owner.escaped.set(value, escaped);
      }
      secrets.add(escaped);
    }
  }
  let shortest = Infinity;
  for (const secret of secrets) shortest = Math.min(shortest, secret.length);
  return Object.assign(
    (text: string) => {
      if (text.length < shortest) return text;
      for (const secret of secrets)
        if (text.length >= secret.length)
          text = text.replaceAll(secret, "[REDACTED]");
      return text;
    },
    { shortest },
  );
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
