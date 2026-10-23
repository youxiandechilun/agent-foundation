import type { IncomingMessage, ServerResponse } from "node:http";
import type { Kernel } from "../core/kernel.js";
import { AppError, invariant } from "../core/util.js";
import type { EntityFilter, Table } from "../storage/entity-query.js";

export interface ApiResult {
  data: unknown;
  status?: number;
}

/** true means a binary response or event stream has already been written. */
export type HttpResult = ApiResult | true | undefined;

export interface ApiContext {
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

export async function body(req: IncomingMessage, max: number) {
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
