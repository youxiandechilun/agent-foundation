import type { IncomingMessage, ServerResponse } from "node:http";
import type { Kernel } from "../core/kernel.js";
import { AppError, invariant } from "../core/util.js";
import type { EntityFilter, Table } from "../storage/entity-query.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { jsonChunks } from "../sessions/json-stream.js";
import type { Capacity } from "../runtime/capacity.js";

export interface ApiResult {
  data: unknown;
  status?: number;
}
/** Internal streaming response; never materializes the complete exported document. */
export class JsonStreamResponse {
  constructor(
    readonly chunks: AsyncIterable<string>,
    readonly close: () => void,
    readonly signal?: AbortSignal,
  ) {}
}

export async function respondChunkStream(
  req: IncomingMessage,
  res: ServerResponse,
  response: JsonStreamResponse,
  status = 200,
) {
  const transfer = requestSignal(req, res);
  try {
    const signal = AbortSignal.any([
      transfer.signal,
      ...(response.signal ? [response.signal] : []),
    ]);
    signal.throwIfAborted();
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    await pipeline(Readable.from(response.chunks, { objectMode: false }), res, {
      signal,
    });
  } finally {
    response.close();
    transfer.close();
  }
}

/** true means a binary response or event stream has already been written. */
export type HttpResult = ApiResult | true | undefined;

export interface ApiContext {
  signal?: AbortSignal;
  k: Kernel;
  url: URL;
  method: string | undefined;
  parts: string[];
  json: () => ReturnType<typeof json>;
}

export interface HttpContext extends ApiContext {
  req: IncomingMessage;
  res: ServerResponse;
}

function declaredLength(req: IncomingMessage, max: number) {
  const declared =
    req.headers["content-length"] === undefined
      ? undefined
      : Number(req.headers["content-length"]);
  invariant(
    declared === undefined ||
      (Number.isSafeInteger(declared) && declared >= 0 && declared <= max),
    "Request too large",
    413,
  );
  return declared;
}

/** One parser lease covers both incoming bytes and the handler using the decoded object. */
export function jsonReader(
  req: IncomingMessage,
  res: ServerResponse,
  max: number,
  capacity: Capacity,
) {
  let pending: ReturnType<typeof json> | undefined;
  let release: (() => void) | undefined;
  let handlerSettled = false,
    parserSettled = true,
    transportSettled = req.aborted || res.destroyed || res.writableFinished;
  const cleanup = () => {
    if (!handlerSettled || !parserSettled || !transportSettled) return;
    req.off("aborted", transportDone);
    res.off("finish", transportDone);
    res.off("close", transportDone);
    release?.();
    release = undefined;
    pending = undefined;
  };
  const transportDone = () => {
    transportSettled = true;
    cleanup();
  };
  const read = () => {
    if (pending) return pending;
    // Chunked requests conservatively reserve their complete per-route limit.
    // Admission happens before body() allocates a declared-length Buffer.
    invariant(
      !handlerSettled && !req.aborted && !res.destroyed,
      "HTTP transfer cancelled",
      400,
    );
    release = capacity.reserve(declaredLength(req, max) ?? max);
    req.once("aborted", transportDone);
    res.once("finish", transportDone);
    res.once("close", transportDone);
    parserSettled = false;
    pending = json(req, max).finally(() => {
      parserSettled = true;
      cleanup();
    });
    return pending;
  };
  return Object.assign(read, {
    /** Disconnect ends transport waiting, but cannot release a live host callback. */
    settle() {
      handlerSettled = true;
      cleanup();
    },
  });
}

export async function body(req: IncomingMessage, max: number) {
  const declared = declaredLength(req, max);
  const chunks: Buffer[] = [];
  const target =
    declared === undefined ? undefined : Buffer.allocUnsafe(declared);
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    invariant(size <= max, "Request too large", 413);
    invariant(!target || size <= target.length, "Request length changed", 400);
    if (target) (chunk as Buffer).copy(target, size - chunk.length);
    else chunks.push(chunk as Buffer);
  }
  invariant(
    declared === undefined || size === declared,
    "Request length changed",
    400,
  );
  return target ?? Buffer.concat(chunks, size);
}
export function requestSignal(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableFinished)
      controller.abort(new Error("HTTP transfer cancelled"));
  };
  req.once("aborted", abort);
  res.once("close", abort);
  if (req.aborted || res.destroyed) abort();
  return {
    signal: controller.signal,
    close: () => {
      req.off("aborted", abort);
      res.off("close", abort);
    },
  };
}
export async function json(req: IncomingMessage, max = 8 * 1024 * 1024) {
  const bytes = await body(req, max);
  try {
    return bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
  } catch {
    throw new AppError(400, "invalid_json", "Invalid JSON body");
  }
}
export function respond(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
/** Large portable bundles retain the v1 wire format without a second whole JSON string. */
export async function respondJsonStream(
  req: IncomingMessage,
  res: ServerResponse,
  data: unknown,
  status = 200,
) {
  const transfer = requestSignal(req, res);
  function* chunks() {
    let buffer = "";
    for (const part of jsonChunks(data)) {
      buffer += part;
      if (buffer.length >= 65536) {
        yield buffer;
        buffer = "";
      }
    }
    if (buffer) yield buffer;
  }
  try {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    await pipeline(Readable.from(chunks()), res, { signal: transfer.signal });
  } finally {
    transfer.close();
  }
}
export function cursor(value: string | null | undefined) {
  const n = Number(value || 0);
  invariant(Number.isSafeInteger(n) && n >= 0, "Invalid event cursor");
  return n;
}
export function entityList<T>(
  context: Pick<ApiContext, "k" | "url">,
  kind: Table,
  key: string,
  filter: EntityFilter = {},
) {
  const page = context.k.store.page<T>(
    kind,
    filter,
    cursor(context.url.searchParams.get("after")),
    Number(context.url.searchParams.get("limit") ?? 100),
  );
  return { [key]: page.items, cursor: page.cursor, hasMore: page.hasMore };
}
