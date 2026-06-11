#!/usr/bin/env node
/**
 * pairwave — the one-command setup CLI.  (SPEC §13.1)
 *
 *   pairwave init   [--relay <ws-url>] [--name <you>]   create a room here; prints the invite code
 *   pairwave join   <invite-code> [--name <you>]        join a friend's room from here
 *   pairwave relay  [--port <n>]                        run the (untrusted, ciphertext-only) relay
 *   pairwave companion                                  run the companion (normally Claude Code does)
 *   pairwave status                                     show this project's pairwave wiring
 */
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { decodeInvite } from "./invite.js";
import { newInvite, wireProject, defaultName, companionEntryPath, encodeInvite } from "./setup.js";
import { loadConfig } from "@pairwave/companion/dist/persist.js";

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

const out = (s: string): void => void process.stdout.write(s + "\n");

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0] ?? 0);
}

function printNextSteps(projectDir: string, invite?: string): void {
  out("");
  out("  Wired into this project:");
  out("    .pairwave/config.json        room config (git-ignored)");
  out("    .mcp.json                    'pairwave' MCP server for Claude Code");
  out("    .claude/skills/pairwave/     the /pairwave skill");
  out("");
  if (invite) {
    out("  ============ COPY THE WHOLE BLOCK BELOW AND SEND IT TO YOUR FRIEND ============");
    out("  (over a TRUSTED channel — Signal/WhatsApp/in person; it contains the room key)");
    out("");
    out("  ---8<------------------------------------------------------------------------");
    out("  Let's pair our Claudes. Two steps, ~2 minutes:");
    out("");
    out("  STEP 1 — in your project folder, paste this into your terminal (or paste it");
    out("  into Claude Code and say \"run this\"):");
    out("");
    out("  Windows:");
    out(`    iex "& { $(iwr -useb https://raw.githubusercontent.com/goofypluto999/pairwave/main/scripts/install.ps1) } join ${invite}"`);
    out("");
    out("  Mac / Linux:");
    out(`    curl -fsSL https://raw.githubusercontent.com/goofypluto999/pairwave/main/scripts/install.sh | bash -s -- join "${invite}"`);
    out("");
    out("  STEP 2 — when it finishes: open Claude Code in that same folder and type");
    out("");
    out("      /pairwave");
    out("");
    out("  Your Claude takes it from there (it'll ask you to confirm six safety words");
    out("  with me, then we're connected — you get a live dashboard too).");
    out("  ---8<------------------------------------------------------------------------");
    out("");
    out(`  (Friend already has Pairwave? They can just run: pairwave join ${invite} )`);
    out("");
    out("  YOUR next step: open Claude Code in THIS folder and type  /pairwave");
    out("");
  }
  out("  Then on each side:");
  out("    1. Make sure a relay is reachable (host runs: pairwave relay).");
  out("    2. Open Claude Code in this folder and approve the 'pairwave' MCP server.");
  out("    3. Type /pairwave — the skill takes it from there (SAS verify → charter → collaborate).");
  out("    4. Dashboard: the companion prints its http://127.0.0.1:<port> when it starts.");
}

async function main(): Promise<void> {
  if (nodeMajor() < 20) {
    out(`Pairwave needs Node 20+ (you have ${process.versions.node}).`);
    process.exit(1);
  }
  const projectDir = process.cwd();

  switch (cmd) {
    case "init": {
      // No central server: every pair brings its own relay (local/LAN, or their own free Render
      // deploy — see README). Default is local; init prints exactly what to do for remote pairs.
      const relayUrl = flag("relay") ?? "ws://127.0.0.1:8787";
      const invite = newInvite(relayUrl);
      const name = flag("name") ?? defaultName();
      wireProject(projectDir, invite, name);
      out(`Pairwave room created: ${invite.roomId}  (relay: ${relayUrl}, you: ${name})`);
      if (/^wss?:\/\/(127\.0\.0\.1|localhost)/i.test(relayUrl)) {
        out("");
        out("  NOTE: a localhost relay only works on YOUR machine (or LAN via your IP).");
        out("  For a friend on another network, omit --relay to use the community relay,");
        out("  or self-host (pairwave relay / the Deploy to Render button in the README).");
      }
      printNextSteps(projectDir, encodeInvite(invite));
      return;
    }

    case "join": {
      const code = argv[1];
      if (!code) {
        out(`Usage: pairwave join <invite-code> [--name <you>]`);
        process.exit(1);
      }
      const invite = decodeInvite(code);
      const name = flag("name") ?? defaultName();
      wireProject(projectDir, invite, name);
      out(`Joined Pairwave room: ${invite.roomId}  (relay: ${invite.relayUrl}, you: ${name})`);
      printNextSteps(projectDir);
      return;
    }

    case "relay": {
      const port = flag("port") ?? "8787";
      const relayPkg = require.resolve("@pairwave/relay/package.json");
      const entry = join(dirname(relayPkg), "dist", "index.js");
      // Show every address a peer could use, so "what do I put in --relay?" answers itself.
      const { networkInterfaces } = await import("node:os");
      const lanIps = Object.values(networkInterfaces())
        .flat()
        .filter((i) => i && i.family === "IPv4" && !i.internal)
        .map((i) => (i as { address: string }).address);
      out(`Relay starting on port ${port}. Reachable as:`);
      out(`  this machine:        ws://127.0.0.1:${port}`);
      for (const ip of lanIps) out(`  same wifi/network:   ws://${ip}:${port}`);
      out(`  different networks:  use the free hosted relay instead (Deploy to Render button in the README)`);
      out("");
      const child = spawn(process.execPath, [entry], {
        stdio: "inherit",
        env: { ...process.env, PORT: port },
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      return;
    }

    case "companion": {
      const entry = companionEntryPath();
      const child = spawn(process.execPath, [entry], {
        stdio: "inherit",
        env: { ...process.env, PAIRWAVE_DIR: process.env.PAIRWAVE_DIR ?? join(projectDir, ".pairwave") },
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      return;
    }

    case "status": {
      const cfg = loadConfig(join(projectDir, ".pairwave"));
      if (!cfg) {
        out("Not set up here. Run: npx pairwave init   (or: npx pairwave join <code>)");
        return;
      }
      out(`room:    ${cfg.roomId}`);
      out(`relay:   ${cfg.relayUrl}`);
      out(`you:     ${cfg.name} (${cfg.peerId})`);
      out(`mcp:     ${existsSync(join(projectDir, ".mcp.json")) ? ".mcp.json wired" : ".mcp.json MISSING — re-run init/join"}`);
      out(`skill:   ${existsSync(join(projectDir, ".claude", "skills", "pairwave", "SKILL.md")) ? "/pairwave installed" : "skill MISSING — re-run init/join"}`);
      return;
    }

    default:
      out("pairwave — connect two people's Claude Code sessions over an E2E-encrypted channel (MIT)");
      out("");
      out("  pairwave init   [--relay <ws-url>] [--name <you>]   create a room; prints the invite");
      out("  pairwave join   <invite-code> [--name <you>]        join with a friend's invite");
      out("  pairwave relay  [--port <n>]                        run the ciphertext-only relay");
      out("  pairwave status                                     show this project's wiring");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e: Error) => {
  out(`error: ${e.message}`);
  process.exit(1);
});
