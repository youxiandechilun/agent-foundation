import type { IncomingMessage, ServerResponse } from "node:http";
import type { Kernel } from "../core/kernel.js";
import { AppError, invariant } from "../core/util.js";

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
  invariant(
    Number(req.headers["content-length"] || 0) <= max,
    "Request too large",
    413,
  );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    invariant(size <= max, "Request too large", 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
