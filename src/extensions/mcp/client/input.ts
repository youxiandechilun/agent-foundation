import { invariant, errorText, abortable } from "../../../core/util.js";
import {
  MCPTaskReceiverError,
  type MCPTaskReceiver,
} from "../tasks/receiver.js";
import {
  RELATED_TASK,
  taskMetadata,
  type MCPTaskContexts,
} from "../tasks/context.js";
import {
  MCPProtocolError,
  wireObject,
  wireMember,
  type MCPRequestContext,
  type RpcId,
  type RpcMessage,
  type WireObject,
} from "../protocol.js";
import type { MCPClientOptions } from "../client.js";
import type { Pending } from "./requests.js";

interface InputHost {
  pending: ReadonlyMap<RpcId, Pending>;
  taskContexts: MCPTaskContexts;
  signal: AbortSignal;
  timeout: number;
  receiver?: MCPTaskReceiver;
  handlers?: MCPClientOptions["handlers"];
  protocolVersion: () => string;
  closed: () => boolean;
  fail: (error: unknown) => Promise<void>;
  send: (message: RpcMessage, signal: AbortSignal) => Promise<void>;
}
/** Associates server input with exactly one live originating request or task. */
export class MCPClientInput {
  private incoming = new Map<RpcId, AbortController>();
  constructor(private host: InputHost) {}
  cancel(requestId: RpcId): void {
    this.incoming
      .get(requestId)
      ?.abort(new Error("Server cancelled client input"));
  }
  async receive(message: RpcMessage, parentId?: RpcId) {
    const requestId = message.id!,
      params: WireObject = wireObject(message.params) ?? {};
    if (this.incoming.has(requestId)) {
      await this.host.fail(new MCPProtocolError("Duplicate server request ID"));
      return;
    }
    const controller = new AbortController();
    this.incoming.set(requestId, controller);
    const parents = [...this.host.pending.values()].filter((p) =>
      ["tools/call", "resources/read", "prompts/get"].includes(
        p.context.method,
      ),
    );
    const ordinaryParent =
      parentId === undefined
        ? parents.length === 1 && this.host.taskContexts.size === 0
          ? parents[0]
          : undefined
        : this.host.pending.get(parentId);
    const taskOperation = [
      "tasks/get",
      "tasks/result",
      "tasks/cancel",
      "tasks/list",
    ].includes(message.method!);
    let related: string | undefined;
    let invalidRelated: unknown;
    try {
      related = taskOperation ? undefined : taskMetadata(params);
    } catch (error) {
      invalidRelated = error;
    }
    const parent = related ? undefined : ordinaryParent;
    const context = related
      ? this.host.taskContexts.get(related)
      : parent?.context;
    const signal = AbortSignal.any([
      this.host.signal,
      controller.signal,
      AbortSignal.timeout(this.host.timeout),
      ...(context ? [context.signal] : []),
    ]);
    try {
      if (invalidRelated || (related && !context))
        throw new MCPProtocolError(
          "Unknown, expired or invalid related task",
          -32602,
        );
      invariant(
        this.incoming.size <= 16,
        "Too many concurrent server input requests",
        429,
      );
      let result: unknown;
      if (taskOperation) {
        if (!this.host.receiver || this.host.protocolVersion() !== "2025-11-25")
          throw new MCPProtocolError(
            "Client task receiver is not enabled",
            -32601,
          );
        if (
          message.method === "tasks/result" &&
          typeof params.taskId === "string"
        )
          related = params.taskId;
        result = await this.host.receiver.handle(
          message.method!,
          params,
          signal,
        );
      } else if (params.task !== undefined) {
        if (!(
          this.host.receiver &&
          this.host.protocolVersion() === "2025-11-25" &&
          this.host.receiver.supports(message.method!) &&
          this.host.handlers?.[
            message.method! as keyof NonNullable<MCPClientOptions["handlers"]>
          ]
        ))
          throw new MCPProtocolError(
            "Client task capability not enabled",
            -32601,
          );
        invariant(
          context &&
            ["tools/call", "resources/read", "prompts/get"].includes(
              context.method,
            ),
          "Client task requires an originating host request",
          403,
        );
        signal.throwIfAborted();
        const { task: _, ...input } = params;
        result = this.host.receiver.create(
          message.method!,
          params,
          {
            ...context,
            signal: AbortSignal.any([this.host.signal, context.signal]),
          },
          (taskContext) =>
            this.handleInput(message.method!, input, taskContext),
        );
      } else
        result =
          message.method === "ping"
            ? {}
            : await this.handleInput(message.method!, params, {
                requestId: context?.requestId ?? requestId,
                method: context?.method || "",
                params: context?.params || {},
                localContext: context?.localContext,
                signal,
              });
      signal.throwIfAborted();
      await this.host.send(
        {
          jsonrpc: "2.0",
          id: requestId,
          result: related
            ? {
                ...wireObject(result),
                _meta: {
                  ...wireObject(wireMember(result, "_meta")),
                  [RELATED_TASK]: { taskId: related },
                },
              }
            : result,
        },
        this.host.signal,
      );
    } catch (error) {
      if (!this.host.closed())
        await this.host.send(
          {
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code:
                error instanceof MCPProtocolError &&
                typeof error.code === "number"
                  ? error.code
                  : error instanceof MCPTaskReceiverError
                    ? error.code
                    : -32603,
              message: errorText(error),
              ...(related
                ? { data: { _meta: { [RELATED_TASK]: { taskId: related } } } }
                : {}),
            },
          },
          this.host.signal,
        );
    } finally {
      this.incoming.delete(requestId);
    }
  }
  async handleInput(
    method: string,
    params: unknown,
    context: MCPRequestContext,
  ) {
    const handler =
      ["roots/list", "sampling/createMessage", "elicitation/create"].includes(
        method,
      ) &&
      this.host.handlers &&
      Object.hasOwn(this.host.handlers, method)
        ? this.host.handlers[
            method as keyof NonNullable<MCPClientOptions["handlers"]>
          ]
        : undefined;
    if (!handler)
      throw new MCPProtocolError("Client capability not supported", -32601);
    invariant(
      method === "roots/list" ||
        ["tools/call", "resources/read", "prompts/get"].includes(
          context.method,
        ),
      "Client input has no unambiguous originating request",
      403,
    );
    context.signal.throwIfAborted();
    return await abortable(handler(params, context), context.signal);
  }
}
