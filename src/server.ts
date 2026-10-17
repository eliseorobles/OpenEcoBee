import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Controller } from "./controller.js";
import { createMcpServer } from "./tools.js";
export { createMcpServer } from "./tools.js";

export async function serveStdio(controller: Controller): Promise<McpServer> {
  const server = createMcpServer(controller);
  await server.connect(new StdioServerTransport());
  return server;
}

export function localRequestAllowed(req: IncomingMessage, port: number): boolean {
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return false;
  return true;
}

function respond(res: ServerResponse, code: number, text: string) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: text }));
}

export async function serveHttp(controller: Controller, port: number) {
  const http = createServer(async (req, res) => {
    if (!localRequestAllowed(req, port)) { respond(res, 403, "Local requests only."); return; }
    if (req.url === "/health" && req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, backend: controller.backend.kind })); return; }
    if (req.url !== "/mcp") { respond(res, 404, "Not found."); return; }
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); respond(res, 405, "Use MCP POST requests."); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { respond(res, 415, "Expected application/json."); return; }
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 65536) { respond(res, 413, "Request too large."); return; }
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { respond(res, 400, "Invalid JSON."); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer(controller);
    res.on("close", () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, parsed); }
    catch { if (!res.headersSent) respond(res, 500, "MCP request failed."); }
  });
  http.requestTimeout = 30000;
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(port, "127.0.0.1", () => { http.removeListener("error", reject); resolve(); }); });
  return http;
}
