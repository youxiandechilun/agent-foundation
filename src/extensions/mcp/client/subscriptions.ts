import { invariant } from "../../../core/util.js";
import {
  isRpcId,
  wireObject,
  wireMember,
  type MCPNotificationFilter,
  type MCPRequestOptions,
  type RpcId,
  type WireObject,
} from "../protocol.js";
import type { ModernMCPTasks } from "../tasks/modern.js";
import type { Pending } from "./requests.js";

export const subscriptionMethods = [
  "notifications/subscriptions/acknowledged",
  "notifications/tools/list_changed",
  "notifications/prompts/list_changed",
  "notifications/resources/list_changed",
  "notifications/resources/updated",
  "notifications/tasks",
];

export function receiveSubscription(
  method: string,
  params: WireObject,
  pending: ReadonlyMap<RpcId, Pending>,
  tasks: ModernMCPTasks,
  taskNegotiated: boolean,
): void {
  const key = wireMember(
      params,
      "_meta",
      "io.modelcontextprotocol/subscriptionId",
    ),
    sub = isRpcId(key) ? pending.get(key)?.subscription : undefined;
  invariant(sub, "Unsolicited MCP subscription notification", 502);
  if (method === "notifications/subscriptions/acknowledged") {
    invariant(!sub.acknowledged, "Duplicate subscription acknowledgement", 502);
    const actual = wireObject(params.notifications);
    invariant(actual, "Invalid subscription acknowledgement", 502);
    for (const [name, value] of Object.entries(actual)) {
      invariant(
        [
          "toolsListChanged",
          "promptsListChanged",
          "resourcesListChanged",
          "resourceSubscriptions",
          "taskIds",
        ].includes(name),
        "Unknown acknowledged notification filter",
        502,
      );
      if (name === "resourceSubscriptions" || name === "taskIds")
        invariant(
          Array.isArray(value) &&
            value.every(
              (v) => typeof v === "string" && sub.filter[name]?.includes(v),
            ),
          "Unrequested resource subscription",
          502,
        );
      else
        invariant(
          value === true &&
            sub.filter[name as keyof MCPNotificationFilter] === true,
          "Unrequested notification type",
          502,
        );
    }
    // Every member was checked against the requested filter above.
    sub.acknowledged = actual as MCPNotificationFilter;
    sub.onAck?.(sub.acknowledged);
  } else {
    invariant(
      sub.acknowledged,
      "Notification arrived before acknowledgement",
      502,
    );
    const expected: Record<string, string> = {
      "notifications/tools/list_changed": "toolsListChanged",
      "notifications/prompts/list_changed": "promptsListChanged",
      "notifications/resources/list_changed": "resourcesListChanged",
    };
    const target =
      method === "notifications/tasks" ? params.taskId : params.uri;
    invariant(
      method === "notifications/tasks"
        ? typeof target === "string" &&
            sub.acknowledged.taskIds?.includes(target)
        : method === "notifications/resources/updated"
          ? typeof target === "string" &&
            sub.acknowledged.resourceSubscriptions?.includes(target)
          : (sub.acknowledged as WireObject)[expected[method]] === true,
      "Notification was not subscribed",
      502,
    );
    if (method === "notifications/tasks") {
      invariant(
        taskNegotiated,
        "Task notification extension is not negotiated",
        502,
      );
      tasks.update(params);
    }
  }
}

interface SubscriptionHost {
  modern: boolean;
  taskNegotiated: boolean;
  timeout: number;
  request: (
    method: string,
    params: WireObject,
    options: MCPRequestOptions,
  ) => Promise<WireObject>;
}
export function listenNotifications(
  filter: MCPNotificationFilter,
  host: SubscriptionHost,
  signal?: AbortSignal,
) {
  invariant(host.modern, "Subscription streams require modern MCP", 400);
  invariant(
    Object.keys(filter).every((k) =>
      [
        "toolsListChanged",
        "promptsListChanged",
        "resourcesListChanged",
        "resourceSubscriptions",
        "taskIds",
      ].includes(k),
    ),
    "Invalid subscription filter",
  );
  if (filter.taskIds)
    invariant(
      host.taskNegotiated &&
        filter.taskIds.length <= 100 &&
        filter.taskIds.every(
          (v) => typeof v === "string" && v.length > 0 && v.length <= 512,
        ),
      "Invalid or unnegotiated task subscriptions",
    );
  invariant(
    !filter.resourceSubscriptions ||
      (filter.resourceSubscriptions.length <= 100 &&
        filter.resourceSubscriptions.every(
          (v) => typeof v === "string" && v.length <= 8192,
        )),
    "Invalid resource subscriptions",
  );
  const controller = new AbortController();
  let readyResolve!: (filter: MCPNotificationFilter) => void,
    readyReject!: (error: unknown) => void;
  const ready = new Promise<MCPNotificationFilter>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const ackTimeout = setTimeout(() => {
    readyReject(new Error("MCP subscription acknowledgement timed out"));
    controller.abort();
  }, host.timeout);
  const completion = host.request(
    "subscriptions/listen",
    { notifications: filter },
    {
      signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]),
      timeout: 24 * 60 * 60 * 1000,
      onSubscriptionAcknowledged: (actual) => {
        clearTimeout(ackTimeout);
        readyResolve(actual);
      },
    },
  );
  completion.then(
    () => {
      clearTimeout(ackTimeout);
      readyReject(new Error("MCP subscription closed before acknowledgement"));
    },
    (error) => {
      clearTimeout(ackTimeout);
      readyReject(error);
    },
  );
  // Keep a handled branch even when callers only await readiness.
  void completion.catch(() => undefined);
  void ready.catch(() => undefined);
  return { ready, completion, close: () => controller.abort() };
}
