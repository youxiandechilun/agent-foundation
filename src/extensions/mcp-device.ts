import { hash, invariant, registerSecret, delay } from "../util.js";
import { OAuthVault } from "./oauth-vault.js";
import { randomBytes } from "node:crypto";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export interface DeviceContext {
  issuer: string;
  tokenEndpoint: string;
  authMethod: string;
  clientId: string;
  clientSecret?: string;
  clientMode: "metadata" | "dynamic" | "pre_registered";
  scope: string;
}
type Target = { id: string; url: string; oauth: unknown };
export interface DeviceGrant {
  grantId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  interval: number;
  context: DeviceContext;
}
type Record = Omit<DeviceGrant, "deviceCode" | "context"> & {
  deviceCode?: string;
  context?: DeviceContext;
  state: "pending" | "authorized" | "denied" | "expired" | "failed";
  nextPollAt: number;
  error?: string;
};
const binding = (t: Target) =>
  hash(JSON.stringify({ url: t.url, oauth: t.oauth }));
/** One durable device grant per server, with a rate limiter shared by all callers. */
export class MCPDeviceFlow {
  private busy = new Map<string, Promise<any>>();
  private controllers = new Map<string, AbortController>();
  private versions = new Map<string, number>();
  constructor(
    private vault: OAuthVault,
    private lifetime: AbortSignal,
    private clock: () => number = Date.now,
  ) {}
  active(id: string) {
    return this.busy.has(id);
  }
  private view(r?: Record) {
    if (!r) return { state: "idle" };
    return {
      state: r.state,
      userCode: r.state === "pending" ? r.userCode : undefined,
      verificationUri: r.verificationUri,
      verificationUriComplete:
        r.state === "pending" ? r.verificationUriComplete : undefined,
      expiresAt: new Date(r.expiresAt).toISOString(),
      intervalSeconds: r.interval,
      nextPollAt:
        r.state === "pending"
          ? new Date(r.nextPollAt).toISOString()
          : undefined,
      error: r.error,
    };
  }
  private finish(r: Record, state: Record["state"], error?: string) {
    r.state = state;
    r.error = error;
    delete r.deviceCode;
    delete r.context;
    r.userCode = "";
    delete r.verificationUriComplete;
  }
  async status(
    target: Target,
    recover?: (grant: DeviceGrant) => Promise<boolean>,
  ) {
    const r = await this.vault.load<Record>(
      target.id,
      "device-flow",
      binding(target),
    );
    if (
      r?.state === "pending" &&
      r.grantId &&
      (await recover?.(r as DeviceGrant))
    )
      return this.view({ ...r, state: "authorized" });
    // Status is read-only; only the serialized poll/begin path commits expiry.
    return this.view(
      r?.state === "pending" && r.expiresAt <= this.clock()
        ? { ...r, state: "expired" }
        : r,
    );
  }
  private run<T>(
    target: Target,
    action: (guard: () => void, signal: AbortSignal) => Promise<T>,
    join = false,
  ): Promise<T> {
    const previous = this.busy.get(target.id);
    if (previous) {
      invariant(join, "A device authorization operation is in progress", 409);
      return previous;
    }
    const version = this.versions.get(target.id) || 0,
      controller = new AbortController();
    this.controllers.set(target.id, controller);
    const guard = () => {
      this.lifetime.throwIfAborted();
      controller.signal.throwIfAborted();
      invariant(
        (this.versions.get(target.id) || 0) === version,
        "Device authorization cancelled",
        409,
      );
    };
    const operation = (async () =>
      action(guard, AbortSignal.any([this.lifetime, controller.signal])))();
    this.busy.set(target.id, operation);
    void operation
      .finally(() => {
        if (this.busy.get(target.id) === operation) {
          this.busy.delete(target.id);
          this.controllers.delete(target.id);
        }
      })
      .catch(() => undefined);
    return operation;
  }
  begin(
    target: Target,
    create: (signal: AbortSignal) => Promise<Omit<DeviceGrant, "grantId">>,
    guardExternal: () => void,
  ) {
    return this.run(target, async (guard, signal) => {
      const old = await this.vault.load<Record>(
        target.id,
        "device-flow",
        binding(target),
      );
      invariant(
        !old || old.state !== "pending" || old.expiresAt <= this.clock(),
        "A device authorization is already pending; cancel it before starting another",
        409,
      );
      const grant = await create(signal);
      guard();
      guardExternal();
      const r: Record = {
        ...grant,
        grantId: randomBytes(24).toString("base64url"),
        state: "pending",
        nextPollAt: this.clock() + grant.interval * 1000,
      };
      registerSecret(grant.deviceCode);
      await this.vault.save(
        target.id,
        "device-flow",
        binding(target),
        r,
        () => {
          guard();
          guardExternal();
        },
      );
      return this.view(r);
    });
  }
  poll<T>(
    target: Target,
    exchange: (grant: DeviceGrant, signal: AbortSignal) => Promise<T>,
    commit: (token: T, guard: () => void) => Promise<void>,
    recover?: (grant: DeviceGrant) => Promise<boolean>,
  ) {
    return this.run(
      target,
      async (guard, signal) => {
        const r = await this.vault.load<Record>(
          target.id,
          "device-flow",
          binding(target),
        );
        guard();
        invariant(r, "No device authorization has been started", 404);
        if (r.state !== "pending") return this.view(r);
        const persist = () =>
          this.vault.save(target.id, "device-flow", binding(target), r, guard);
        if (r.grantId && (await recover?.(r as DeviceGrant))) {
          guard();
          this.finish(r, "authorized");
          await persist();
          return this.view(r);
        }
        if (r.expiresAt <= this.clock()) {
          this.finish(r, "expired", "expired_token");
          await persist();
          return this.view(r);
        }
        if (r.nextPollAt > this.clock()) return this.view(r);
        invariant(
          r.deviceCode && r.context,
          "Corrupt device authorization state",
          500,
        );
        registerSecret(r.deviceCode);
        if (r.context.clientSecret) registerSecret(r.context.clientSecret);
        // A restart cannot bypass the in-flight request timeout and start another poll too early.
        r.nextPollAt = this.clock() + 10000 + r.interval * 1000;
        await persist();
        try {
          const token = await exchange(r as DeviceGrant, signal);
          guard();
          await commit(token, guard);
          guard();
          this.finish(r, "authorized");
        } catch (e) {
          guard();
          const code = (e as any).oauthError;
          if (
            code === "authorization_pending" ||
            code === "slow_down" ||
            code === "connection_error"
          ) {
            if (code === "slow_down") r.interval += 5;
            if (code === "connection_error")
              r.interval = Math.min(r.interval * 2, 86400);
            r.error = code;
            r.nextPollAt = this.clock() + r.interval * 1000;
          } else
            this.finish(
              r,
              code === "access_denied"
                ? "denied"
                : code === "expired_token"
                  ? "expired"
                  : "failed",
              /^[a-z_]{1,80}$/.test(code || "") ? code : "invalid_response",
            );
        }
        await persist();
        return this.view(r);
      },
      true,
    );
  }
  async wait(target: Target, poll: () => Promise<any>, signal?: AbortSignal) {
    const stop = signal
      ? AbortSignal.any([signal, this.lifetime])
      : this.lifetime;
    for (;;) {
      stop.throwIfAborted();
      const status = await poll();
      stop.throwIfAborted();
      if (status.state !== "pending") return status;
      await delay(
        Math.max(
          1,
          Math.min(60000, Date.parse(status.nextPollAt) - this.clock()),
        ),
        stop,
      );
    }
  }
  invalidate(id: string) {
    this.versions.set(id, (this.versions.get(id) || 0) + 1);
    this.controllers
      .get(id)
      ?.abort(new Error("Device authorization cancelled"));
    this.vault.remove(id, "device-flow");
  }
}
