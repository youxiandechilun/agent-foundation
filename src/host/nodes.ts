import { captureRedaction } from "../core/util.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { Store } from "../storage/store.js";
import {
  id,
  hash,
  now,
  invariant,
  errorText,
  registerSecret,
} from "../core/util.js";

export interface DeviceNode {
  id: string;
  projectId: string;
  name: string;
  kind: "device" | "browser" | "computer";
  capabilities: string[];
  tokenHash: string;
  enabled: boolean;
  connected: boolean;
  lastSeen?: string;
  createdAt: string;
}
export interface NodeTask {
  id: string;
  nodeId: string;
  capability: string;
  args: unknown;
  status:
    "queued" | "running" | "completed" | "failed" | "unknown" | "cancelled";
  result?: unknown;
  error?: string;
  createdAt: string;
  deadline: string;
  finishedAt?: string;
}
export interface NodeManagerOptions {
  maxPendingTasks?: number;
  maxPendingBytes?: number;
  retentionDays?: number;
  retentionIntervalMs?: number;
}
export class NodeManager {
  readonly websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
  });
  private sockets = new Map<string, WebSocket>();
  private closed = false;
  private readonly waiters = new Map<string, () => void>();
  private readonly options: Required<NodeManagerOptions>;
  private retentionTimer?: ReturnType<typeof setInterval>;
  private retentionWork?: Promise<number>;
  constructor(
    readonly store: Store,
    private authorize?: (
      node: DeviceNode,
      capability?: string,
      args?: unknown,
    ) => void,
    options: NodeManagerOptions = {},
  ) {
    captureRedaction(this);
    this.options = {
      maxPendingTasks: options.maxPendingTasks ?? 64,
      maxPendingBytes: options.maxPendingBytes ?? 8 * 1024 * 1024,
      retentionDays: options.retentionDays ?? 0,
      retentionIntervalMs: options.retentionIntervalMs ?? 3_600_000,
    };
    invariant(
      Number.isSafeInteger(this.options.maxPendingTasks) &&
        this.options.maxPendingTasks > 0 &&
        Number.isSafeInteger(this.options.maxPendingBytes) &&
        this.options.maxPendingBytes > 0 &&
        Number.isSafeInteger(this.options.retentionDays) &&
        this.options.retentionDays >= 0 &&
        Number.isSafeInteger(this.options.retentionIntervalMs) &&
        this.options.retentionIntervalMs >= 1000,
      "Invalid node task limits",
    );
    if (this.options.retentionDays) {
      this.retentionTimer = setInterval(() => {
        void this.prune().catch(() => undefined);
      }, this.options.retentionIntervalMs).unref();
      void this.prune().catch(() => undefined);
    }
  }
  pair(input: unknown) {
    const p = z
      .object({
        projectId: z.string(),
        name: z.string().max(100),
        kind: z.enum(["device", "browser", "computer"]).default("device"),
        capabilities: z
          .array(z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/))
          .min(1)
          .max(100),
      })
      .strict()
      .parse(input);
    this.store.project(p.projectId);
    const token = randomBytes(32).toString("hex");
    registerSecret(token);
    const node: DeviceNode = {
      ...p,
      id: id("node"),
      tokenHash: hash(token),
      enabled: true,
      connected: false,
      createdAt: now(),
    };
    this.store.put("nodes", node);
    return { ...this.public(node), token };
  }
  private public(node: DeviceNode) {
    const { tokenHash, ...visible } = node;
    return {
      ...visible,
      connected:
        this.sockets.has(node.id) ||
        Boolean(
          node.lastSeen && Date.now() - Date.parse(node.lastSeen) < 60000,
        ),
    };
  }
  list(projectId?: string) {
    return this.store
      .list<DeviceNode>("nodes")
      .filter((n) => !projectId || n.projectId === projectId)
      .map((n) => this.public(n));
  }
  verify(nodeId: string, token: string) {
    const node = this.store.get<DeviceNode>("nodes", nodeId),
      expected = Buffer.from(node.tokenHash),
      actual = Buffer.from(hash(token));
    invariant(
      node.enabled &&
        expected.length === actual.length &&
        timingSafeEqual(expected, actual),
      "Invalid node credentials",
      401,
    );
    this.authorize?.(node);
    return node;
  }
  revoke(nodeId: string) {
    const node = this.store.get<DeviceNode>("nodes", nodeId);
    this.store.put("nodes", { ...node, enabled: false, connected: false });
    this.sockets.get(nodeId)?.terminate();
    this.unavailable(nodeId, "Node was revoked");
  }
  private unavailable(nodeId: string, reason: string) {
    for (const task of this.store.selectJson<NodeTask>(
      "SELECT body FROM e_node_tasks WHERE json_extract(body,'$.nodeId')=? AND json_extract(body,'$.status') IN ('queued','running')",
      [nodeId],
    )) {
      this.store.put("node-tasks", {
        ...task,
        status: task.status === "queued" ? "cancelled" : "unknown",
        error: reason,
        finishedAt: now(),
      });
      this.waiters.get(task.id)?.();
    }
  }
  heartbeat(nodeId: string) {
    const node = this.store.get<DeviceNode>("nodes", nodeId);
    invariant(node.enabled, "Node was revoked", 403);
    this.authorize?.(node);
    this.store.put("nodes", { ...node, connected: true, lastSeen: now() });
    return { ok: true, serverTime: now() };
  }
  claim(nodeId: string): NodeTask | undefined {
    this.heartbeat(nodeId);
    return this.store.transaction(() => {
      if (
        this.store
          .prepare(
            "SELECT 1 FROM e_node_tasks WHERE json_extract(body,'$.nodeId')=? AND json_extract(body,'$.status')='running' LIMIT 1",
          )
          .get(nodeId)
      )
        return;
      const task = this.store.selectJsonOne<NodeTask>(
        "SELECT body FROM e_node_tasks WHERE json_extract(body,'$.nodeId')=? AND json_extract(body,'$.status')='queued' AND json_extract(body,'$.deadline')>? ORDER BY rowid LIMIT 1",
        [nodeId, now()],
      );
      if (!task) return;
      return this.store.put("node-tasks", {
        ...task,
        status: "running" as const,
      });
    });
  }
  complete(nodeId: string, taskId: string, input: unknown) {
    const p = z
      .object({
        result: z.unknown().optional(),
        error: z.string().max(2000).optional(),
        ok: z.boolean(),
      })
      .strict()
      .parse(input);
    invariant(
      JSON.stringify(p).length <= 2 * 1024 * 1024,
      "Node result exceeds limit",
    );
    const task = this.store.get<NodeTask>("node-tasks", taskId);
    invariant(task.nodeId === nodeId, "Node task owner mismatch", 403);
    if (task.status === "completed" || task.status === "failed") return task;
    invariant(
      task.status === "running" || task.status === "unknown",
      "Node task is not running",
      409,
    );
    this.heartbeat(nodeId);
    const completed = this.store.put("node-tasks", {
      ...task,
      status: p.ok ? "completed" : "failed",
      result: p.result,
      error: p.error,
      finishedAt: now(),
    });
    this.waiters.get(taskId)?.();
    return completed;
  }
  async call(
    projectId: string,
    nodeId: string,
    capability: string,
    args: unknown,
    timeoutMs = 30000,
    signal?: AbortSignal,
  ) {
    const node = this.store.get<DeviceNode>("nodes", nodeId);
    invariant(!this.closed, "Node service closed", 503);
    signal?.throwIfAborted();
    invariant(
      Number.isFinite(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 120000,
      "Invalid node deadline",
    );
    invariant(
      Buffer.byteLength(JSON.stringify(args)) <= 2 * 1024 * 1024,
      "Node arguments exceed limit",
      413,
    );
    this.authorize?.(node, capability, args);
    invariant(
      node.enabled &&
        node.projectId === projectId &&
        node.capabilities.includes(capability),
      "Node capability denied",
      403,
    );
    const task: NodeTask = {
      id: id("node_task"),
      nodeId,
      capability,
      args,
      status: "queued",
      createdAt: now(),
      deadline: new Date(Date.now() + timeoutMs).toISOString(),
    };
    this.store.transaction(() => {
      const pending = this.store
        .prepare(
          "SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM e_node_tasks WHERE json_extract(body,'$.status') IN ('queued','running')",
        )
        .get() as { count: number; bytes: number };
      invariant(
        pending.count < this.options.maxPendingTasks &&
          pending.bytes + Buffer.byteLength(JSON.stringify(task)) <=
            this.options.maxPendingBytes,
        "Node task capacity reached",
        429,
        "node_capacity",
      );
      this.store.put("node-tasks", task);
    });
    try {
      this.dispatch(nodeId);
      while (true) {
        signal?.throwIfAborted();
        invariant(!this.closed, "Node service closed", 503);
        const live = this.store.get<DeviceNode>("nodes", nodeId);
        invariant(live.enabled, "Node was revoked", 403);
        this.authorize?.(live, capability, args);
        const current = this.store.get<NodeTask>("node-tasks", task.id);
        if (current.status === "completed") return current.result;
        if (current.status === "failed")
          throw new Error(current.error || "Node task failed");
        invariant(
          !["unknown", "cancelled"].includes(current.status),
          current.error || "Node action outcome is unknown",
          409,
        );
        invariant(
          Date.now() < Date.parse(task.deadline),
          "Node task deadline exceeded; inspect device before retry",
          504,
        );
        await this.waitForChange(
          task.id,
          Math.min(1000, Math.max(1, Date.parse(task.deadline) - Date.now())),
          signal,
        );
      }
    } catch (error) {
      const current = this.store.get<NodeTask>("node-tasks", task.id);
      if (["queued", "running"].includes(current.status))
        this.store.put("node-tasks", {
          ...current,
          status: current.status === "queued" ? "cancelled" : "unknown",
          error: errorText(error),
          finishedAt: now(),
        });
      const socket = this.sockets.get(nodeId);
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "cancel", taskId: task.id }));
      throw error;
    }
  }
  private waitForChange(
    taskId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.waiters.get(taskId) === wake) this.waiters.delete(taskId);
        if (error) reject(error);
        else resolve();
      };
      const wake = () => finish();
      const abort = () => finish(signal?.reason || new Error("Cancelled"));
      const timer = setTimeout(wake, timeoutMs);
      this.waiters.set(taskId, wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  /** Delete only confirmed terminal tasks; unknown outcomes remain for inspection. */
  prune(): Promise<number> {
    if (this.retentionWork) return this.retentionWork;
    const run = async () => {
      if (!this.options.retentionDays) return 0;
      const cutoff = new Date(
        Date.now() - this.options.retentionDays * 86_400_000,
      ).toISOString();
      let total = 0;
      while (!this.closed && !this.store.isClosed) {
        const removed = Number(
          this.store
            .prepare(
              "DELETE FROM e_node_tasks WHERE id IN (SELECT id FROM e_node_tasks WHERE json_extract(body,'$.status') IN ('completed','failed','cancelled') AND COALESCE(json_extract(body,'$.finishedAt'),json_extract(body,'$.createdAt'))<? LIMIT 500)",
            )
            .run(cutoff).changes,
        );
        total += removed;
        if (removed < 500) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return total;
    };
    this.retentionWork = run().finally(() => {
      this.retentionWork = undefined;
    });
    return this.retentionWork;
  }
  private dispatch(nodeId: string) {
    const socket = this.sockets.get(nodeId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const task = this.claim(nodeId);
    if (task) socket.send(JSON.stringify({ type: "task", task }));
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.websocket.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => ws.terminate());
      let nodeId: string | undefined;
      const timer = setTimeout(
        () => ws.close(1008, "Authentication required"),
        5000,
      );
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 20000);
      ws.on("message", (bytes) => {
        try {
          const message = JSON.parse(bytes.toString());
          if (!nodeId) {
            invariant(
              message.type === "auth" &&
                typeof message.nodeId === "string" &&
                typeof message.token === "string",
              "Authentication required",
              401,
            );
            const node = this.verify(message.nodeId, message.token);
            nodeId = node.id;
            clearTimeout(timer);
            const old = this.sockets.get(node.id);
            if (old)
              this.unavailable(
                node.id,
                "Browser connection replaced; inspect before retrying",
              );
            this.sockets.set(node.id, ws);
            old?.close();
            this.heartbeat(node.id);
            ws.send(JSON.stringify({ type: "ready", nodeId }));
            this.dispatch(node.id);
            return;
          }
          this.heartbeat(nodeId);
          if (message.type === "result") {
            this.complete(nodeId, message.taskId, {
              ok: message.ok,
              result: message.result,
              error: message.error,
            });
            ws.send(JSON.stringify({ type: "ack", taskId: message.taskId }));
            this.dispatch(nodeId);
          } else if (message.type === "pull") this.dispatch(nodeId);
          else if (message.type === "heartbeat")
            ws.send(JSON.stringify({ type: "heartbeat", serverTime: now() }));
          else throw new Error("Unknown node message");
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", error: errorText(error) }));
          if (!nodeId || !this.store.find<DeviceNode>("nodes", nodeId)?.enabled)
            ws.close(1008);
        }
      });
      ws.on("close", () => {
        clearTimeout(timer);
        clearInterval(ping);
        if (!this.closed && nodeId && this.sockets.get(nodeId) === ws) {
          this.sockets.delete(nodeId);
          const node = this.store.find<DeviceNode>("nodes", nodeId);
          if (node)
            this.store.put("nodes", {
              ...node,
              connected: false,
              lastSeen: undefined,
            });
          this.unavailable(
            nodeId,
            "Node disconnected; inspect the browser before retrying",
          );
        }
      });
    });
  }
  close() {
    this.closed = true;
    clearInterval(this.retentionTimer);
    for (const [nodeId, socket] of this.sockets) {
      socket.terminate();
      this.unavailable(nodeId, "Node service closed");
    }
    this.sockets.clear();
    for (const wake of this.waiters.values()) wake();
    this.websocket.close();
  }
}
