/**
 * Inject server — minimal HTTP endpoint for injecting service messages
 * directly into a named session's queue without Telegram involvement.
 *
 * Binds to 127.0.0.1 only. Single route: POST /inject
 * Body: { session_name: string, text: string, event_type?: string }
 *
 * Set INJECT_PORT env var to override default port 9099.
 * Set INJECT_SECRET env var to require Authorization header.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { listSessions } from "./session-manager.js";
import { deliverServiceMessage } from "./session-queue.js";
import { dlog } from "./debug-log.js";

const DEFAULT_PORT = 9099;

interface InjectBody {
  session_name: string;
  text: string;
  event_type?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

export function startInjectServer(): void {
  const port = parseInt(process.env.INJECT_PORT ?? String(DEFAULT_PORT), 10);
  const secret = process.env.INJECT_SECRET ?? "";

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Auth check
    if (secret) {
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${secret}` && auth !== secret) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    // Route check
    if (req.method !== "POST" || req.url !== "/inject") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    // Parse body
    let body: InjectBody;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw) as InjectBody;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    if (!body.session_name || typeof body.session_name !== "string") {
      sendJson(res, 400, { error: "Missing or invalid session_name" });
      return;
    }
    if (!body.text || typeof body.text !== "string") {
      sendJson(res, 400, { error: "Missing or invalid text" });
      return;
    }

    // Resolve session_name to SID
    const sessions = listSessions();
    const match = sessions.find(
      (s) => s.name.toLowerCase() === body.session_name.toLowerCase(),
    );
    if (!match) {
      sendJson(res, 404, { error: `Session not found: ${body.session_name}` });
      return;
    }

    const eventType = body.event_type ?? "inbox_nudge";
    const delivered = deliverServiceMessage(match.sid, body.text, eventType);
    if (!delivered) {
      sendJson(res, 404, { error: `Queue not found for session: ${body.session_name}` });
      return;
    }

    dlog("service", `inject → session=${body.session_name} sid=${match.sid}`, { eventType });
    sendJson(res, 200, { ok: true });
  });

  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`[info] inject server listening on 127.0.0.1:${port}\n`);
  });

  server.on("error", (err: Error) => {
    process.stderr.write(`[warn] inject server error: ${err.message}\n`);
  });
}
