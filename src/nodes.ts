import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { Store } from "./store.js";
import {
  id,
  hash,
  now,
  invariant,
  delay,
  errorText,
  registerSecret,
} from "./util.js";

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
}
export class NodeManager {
  readonly websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
  });
  private sockets = new Map<string, WebSocket>();
  private closed = false;
  constructor(
    readonly store: Store,
    private authorize?: (
      node: DeviceNode,
      capability?: string,
      args?: unknown,
    ) => void,
  ) {}
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
    for (const task of this.store.list<NodeTask>("node-tasks"))
      if (task.nodeId === nodeId && ["queued", "running"].includes(task.status))
        this.store.put("node-tasks", {
          ...task,
          status: task.status === "queued" ? "cancelled" : "unknown",
          error: reason,
        });
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
          .list<NodeTask>("node-tasks")
          .some((t) => t.nodeId === nodeId && t.status === "running")
      )
        return;
      const task = this.store
        .list<NodeTask>("node-tasks")
        .find(
          (t) =>
            t.nodeId === nodeId &&
            t.status === "queued" &&
            Date.parse(t.deadline) > Date.now(),
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
    return this.store.put("node-tasks", {
      ...task,
      status: p.ok ? "completed" : "failed",
      result: p.result,
      error: p.error,
    });
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
    this.store.put("node-tasks", task);
    this.dispatch(nodeId);
    try {
      while (true) {
        signal?.throwIfAborted();
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
        await delay(30, signal);
      }
    } catch (error) {
      const current = this.store.get<NodeTask>("node-tasks", task.id);
      if (["queued", "running"].includes(current.status))
        this.store.put("node-tasks", {
          ...current,
          status: current.status === "queued" ? "cancelled" : "unknown",
          error: errorText(error),
        });
      const socket = this.sockets.get(nodeId);
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "cancel", taskId: task.id }));
      throw error;
    }
  }
  private dispatch(nodeId: string) {
    const socket = this.sockets.get(nodeId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const task = this.claim(nodeId);
    if (task) socket.send(JSON.stringify({ type: "task", task }));
  }
  upgrade(req: IncomingMessage, socket: any, head: Buffer) {
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
    for (const [nodeId, socket] of this.sockets) {
      socket.terminate();
      this.unavailable(nodeId, "Node service closed");
    }
    this.sockets.clear();
    this.websocket.close();
  }
}
