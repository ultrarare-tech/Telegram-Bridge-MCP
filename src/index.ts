import "dotenv/config";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getSecurityConfig, getApi, resolveChat, installOutboundProxy, sendServiceMessage } from "./telegram.js";
import { clearCommandsOnShutdown } from "./shutdown.js";
import { BUILT_IN_COMMANDS, applySessionLogConfig, doTimelineDump } from "./built-in-commands.js";
import { startPoller, stopPoller, drainPendingUpdates, waitForPollerExit, onFirstSuccessfulPoll } from "./poller.js";
import { startInjectServer } from "./inject-server.js";
import { startHealthCheck } from "./health-check.js";
import { startHttpMcpServer } from "./http-server.js";
import { setAuthHook } from "./session-gate.js";
import { touchSession } from "./session-manager.js";
import { createOutboundProxy } from "./outbound-proxy.js";
import { loadConfig, getSessionLogMode, sessionLogLabel, isDebugConfig } from "./config.js";
import { timelineSize } from "./message-store.js";
import { initDebugLog } from "./debug-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { name: string; version: string };
process.stderr.write(`[info] [${pkg.name}] v${pkg.version} starting...\n`);

// --- Startup deduplication via PID lockfile ---
// Use first 8 chars of bot token as a per-bot hash so multiple bots can coexist.
const _botToken = process.env.BOT_TOKEN ?? "";
const _tokenHash = _botToken.slice(0, 8) || "default";
const _lockfilePath = `/tmp/telegram-bridge-${_tokenHash}.pid`;

function _releaseLockfile(): void {
  try {
    if (existsSync(_lockfilePath)) unlinkSync(_lockfilePath);
  } catch { /* best effort */ }
}

// Check for an existing instance and send SIGTERM if alive.
if (existsSync(_lockfilePath)) {
  let existingPid: number | null = null;
  try {
    const raw = readFileSync(_lockfilePath, "utf-8").trim();
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) existingPid = parsed;
  } catch { /* stale or unreadable lockfile — proceed */ }

  if (existingPid !== null) {
    let isAlive = false;
    try {
      process.kill(existingPid, 0);
      isAlive = true;
    } catch { /* ESRCH — process is dead */ }

    if (isAlive) {
      process.stderr.write(`[startup] found existing instance PID ${existingPid}, sending SIGTERM...\n`);
      try {
        process.kill(existingPid, "SIGTERM");
      } catch { /* already dead by the time we got here */ }

      // Wait up to 3 seconds for the old process to exit.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        let stillAlive = false;
        try { process.kill(existingPid, 0); stillAlive = true; } catch { /* dead */ }
        if (!stillAlive) break;
        // Busy-wait in 100 ms increments — this is startup code, acceptable.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      process.stderr.write(`[startup] old instance terminated, continuing startup\n`);
    } else {
      process.stderr.write(`[startup] stale lockfile for PID ${existingPid}, ignoring\n`);
    }
  }
}

// Write our PID to the lockfile before starting the poller.
try {
  writeFileSync(_lockfilePath, String(process.pid), "utf-8");
} catch (e) {
  process.stderr.write(`[startup] warning: could not write lockfile ${_lockfilePath}: ${String(e)}\n`);
}
// --- End startup deduplication ---

// Initialize security config early so warnings surface at startup
getSecurityConfig();

// Load persistent MCP config
loadConfig();

// Initialize debug logging from config (or env var fallback)
initDebugLog(isDebugConfig());
if (isDebugConfig()) process.stderr.write("[info] debug logging enabled\n");

// Warn if TTS/STT remote hosts are using plain HTTP (credentials and audio exposed in transit)
if (process.env.TTS_HOST && !process.env.TTS_HOST.startsWith("https://")) {
  process.stderr.write("[warn] TTS_HOST is not using HTTPS — credentials and audio may be exposed in transit.\n");
}
if (process.env.STT_HOST && !process.env.STT_HOST.startsWith("https://")) {
  process.stderr.write("[warn] STT_HOST is not using HTTPS — credentials and audio may be exposed in transit.\n");
}

let _shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    process.stderr.write(`[shutdown] received ${sig}\n`);
    if (_shuttingDown) return;
    _shuttingDown = true;
    stopPoller();
    const shutdownSequence = (async () => {
      // Wait for the poll loop to finish (completes in-flight transcriptions)
      await waitForPollerExit();
      // Drain any updates received since the last poll iteration
      const drained = await drainPendingUpdates();
      if (drained > 0) process.stderr.write(`[shutdown] drained ${drained} pending update(s)\n`);
      // Dump session log before exit (if not disabled)
      if (getSessionLogMode() !== null && timelineSize() > 0) {
        try { await doTimelineDump(); } catch { /* best effort */ }
      }
      await sendServiceMessage("🔴 Offline").catch((e: unknown) => {
        process.stderr.write(`[shutdown] sendServiceMessage error: ${String(e)}\n`);
      });
    })();
    const timeout = new Promise<void>((r) => setTimeout(r, 10000));
    void Promise.race([shutdownSequence, timeout])
      .finally(() => {
        _releaseLockfile();
        process.stderr.write("[shutdown] telegram-bridge shutting down gracefully\n");
        clearCommandsOnShutdown().finally(() => process.exit(0));
      });
  });
}

// Install the outbound proxy before any API calls
installOutboundProxy(createOutboundProxy);

// Apply session log config (wires up auto-dump if configured)
applySessionLogConfig();

// Start the HTTP MCP server — each connecting Claude session gets its own
// McpServer+transport pair; all share the same module-level Telegram state.
const _mcpPort = parseInt(process.env.MCP_PORT ?? "3001", 10);
startHttpMcpServer(_mcpPort);

// Register built-in commands and start the background poller after connecting.
// Both are best-effort — don't block startup.
void (async () => {
  const chatId = resolveChat();
  if (typeof chatId !== "number") return;
  try {
    await getApi().setMyCommands([...BUILT_IN_COMMANDS], {
      scope: { type: "chat", chat_id: chatId },
    });
  } catch { /* ignore */ }
})();

// Defer the "Online" announcement until after the first successful getUpdates.
// This prevents duplicate announcements when the old process is still long-polling.
const logStatus = sessionLogLabel();
onFirstSuccessfulPoll(() => {
  void sendServiceMessage(`🟢 Online\nSession record: ${logStatus}\n/session to change settings`).catch(() => {});
});

// Brief delay before starting the poller to let the old process's long-poll expire
// after we sent it SIGTERM above. This reduces update-ID gaps from concurrent polls.
await new Promise<void>(r => setTimeout(r, 2000));

startPoller();
process.stderr.write("[info] background poller started\n");

startInjectServer();

startHealthCheck();
setAuthHook(touchSession);
process.stderr.write("[info] health check started\n");
