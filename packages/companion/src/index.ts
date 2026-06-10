#!/usr/bin/env node
/**
 * pairwave-companion — the per-machine trusted process.  (SPEC §3.2)
 *
 * Boots the runtime from `.pairwave/` (PAIRWAVE_DIR env or ./​.pairwave), connects the relay,
 * serves the localhost dashboard, and speaks MCP to Claude Code over stdio.
 *
 * stdout is RESERVED for the MCP protocol — all human-facing logs go to stderr.
 * On SIGINT/SIGTERM (or stdio close) it sends a best-effort bye and writes the handoff file.
 */
import { join } from "node:path";
import { CompanionRuntime } from "./runtime.js";
import { startUiServer } from "./uiserver.js";
import { startMcpServer } from "./mcp.js";

const pairwaveDir = process.env.PAIRWAVE_DIR ?? join(process.cwd(), ".pairwave");

const log = (msg: string): void => void process.stderr.write(`[pairwave] ${msg}\n`);

let shuttingDown = false;
async function main(): Promise<void> {
  const rt = await CompanionRuntime.boot(pairwaveDir);
  rt.start();
  log(`room ${rt.cfg.roomId} · you are ${rt.cfg.name} (${rt.cfg.peerId}) · relay ${rt.cfg.relayUrl}`);

  const ui = await startUiServer(rt, rt.cfg.uiPort ?? 7591);
  log(`dashboard: ${ui.url}`);

  const shutdown = async (why: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${why}) — writing handoff…`);
    await rt.shutdown();
    await ui.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // MCP over stdio; when Claude Code closes the pipe, exit cleanly with a handoff.
  await startMcpServer(rt);
  await shutdown("stdio closed");
}

main().catch((e: Error) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
