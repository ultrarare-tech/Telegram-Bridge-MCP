/**
 * HTTP MCP server — hosts the Telegram Bridge MCP over Streamable HTTP transport.
 *
 * Listens on 127.0.0.1 only (localhost). Each connecting Claude Code session
 * gets its own McpServer + StreamableHTTPServerTransport pair, but all share
 * the same underlying Telegram bot state (session manager, message store, etc.)
 * via module-level singletons.
 *
 * Routes:
 *   POST /mcp  — new session initialization or messages for existing session
 *   GET  /mcp  — SSE stream for an existing session (mcp-session-id required)
 *   DELETE /mcp — terminate a session
 *
 * Set MCP_PORT env var to override default port 3001.
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createMcpServer } from "./server.js";

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
}

const sessions = new Map<string, SessionEntry>();

const DEFAULT_PORT = 3001;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.trim() ? JSON.parse(raw) : undefined);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

export function startHttpMcpServer(port: number = DEFAULT_PORT): void {
  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Only handle /mcp
    if (req.url !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Route to an existing session
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, { error: "Session not found" });
          return;
        }
        let body: unknown = undefined;
        if (req.method === "POST") {
          body = await readJsonBody(req);
        }
        await session.transport.handleRequest(req, res, body);
        return;
      }

      // New connection — must be a POST (initialize request)
      if (req.method !== "POST") {
        sendJson(res, 400, { error: "New sessions must be initialized with POST" });
        return;
      }

      const body = await readJsonBody(req);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport });
          process.stderr.write(`[http] MCP session connected: ${id} (total: ${sessions.size})\n`);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          process.stderr.write(`[http] MCP session closed: ${id} (total: ${sessions.size})\n`);
        },
      });

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      process.stderr.write(`[http] request error: ${String(err)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  });

  httpServer.listen(port, "127.0.0.1", () => {
    process.stderr.write(`[info] MCP HTTP server listening on http://127.0.0.1:${port}/mcp\n`);
    process.stderr.write(`[info] Connect clients to: http://127.0.0.1:${port}/mcp\n`);
  });

  httpServer.on("error", (err: Error & { code?: string }) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(`[error] Port ${port} already in use. Set MCP_PORT to use a different port.\n`);
      process.exit(1);
    }
    process.stderr.write(`[error] MCP HTTP server error: ${err.message}\n`);
  });
}
