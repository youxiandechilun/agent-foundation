import http from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export async function startFilesystemMCP(root, port = 0, token) {
  const actual = await realpath(root);
  const server = http.createServer(async (req, res) => {
    if (req.headers.origin) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }
    let message;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 100000) throw Error("Request too large");
        chunks.push(chunk);
      }
      message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      let result;
      if (message.method === "initialize")
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "foundation-http-filesystem", version: "1.0.0" },
        };
      else if (message.method === "tools/list")
        result = {
          tools: [
            {
              name: "read_text",
              description:
                "Read actual UTF-8 file under the configured directory",
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
                additionalProperties: false,
              },
            },
          ],
        };
      else if (message.method === "tools/call") {
        const file = await realpath(
          path.resolve(actual, message.params.arguments.path),
        );
        const relative = path.relative(actual, file);
        if (
          relative === ".." ||
          relative.startsWith(".." + path.sep) ||
          path.isAbsolute(relative)
        )
          throw Error("Path denied");
        result = {
          content: [
            {
              type: "text",
              text: (await readFile(file, "utf8")).slice(0, 32000),
            },
          ],
        };
      } else if (message.method === "ping") result = {};
      else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not supported" },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch (error) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message?.id ?? null,
          error: { code: -32000, message: error.message },
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const api = await startFilesystemMCP(
    process.argv[2] || process.cwd(),
    Number(process.argv[3] || 4318),
    process.env.MCP_EXAMPLE_TOKEN,
  );
  console.log(api.url);
}
