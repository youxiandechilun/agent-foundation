import type { Server } from "node:http";
export function startFilesystemMCP(
  root: string,
  port?: number,
  token?: string,
): Promise<{ server: Server; url: string; close(): Promise<void> }>;
