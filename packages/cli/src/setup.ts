/**
 * Project wiring — everything `init` / `join` touches, and nothing else.  (SPEC §13.1)
 *
 *   <project>/.pairwave/config.json      room config (created)
 *   <project>/.mcp.json                  pairwave MCP server entry (merged, never clobbered)
 *   <project>/.claude/skills/pairwave/   the /pairwave skill (copied)
 *   <project>/.gitignore                 ensures `.pairwave/` is ignored (appended if missing)
 *
 * All JSON merging is read-modify-write that preserves unknown fields; a malformed existing
 * .mcp.json aborts with a clear message rather than overwriting someone's file.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { saveConfig, type RoomConfig } from "@pairwave/companion/dist/persist.js";
import { encodeInvite, type Invite } from "./invite.js";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

export function defaultName(): string {
  try {
    return userInfo().username || "me";
  } catch {
    return "me";
  }
}

/** Locate the companion's executable for the .mcp.json entry. */
export function companionEntryPath(): string {
  const pkgJson = require.resolve("@pairwave/companion/package.json");
  return join(dirname(pkgJson), "dist", "index.js");
}

export function newInvite(relayUrl: string): Invite {
  return {
    v: 1,
    roomId: "rm-" + randomBytes(8).toString("hex"),
    relayUrl,
    saltB64: randomBytes(16).toString("base64"),
    passphrase: randomBytes(24).toString("base64url"),
  };
}

export type WireResult = { configPath: string; mcpJsonPath: string; skillPath: string; uiNote: string };

/** Write config + wire .mcp.json + install the skill + protect .gitignore. Idempotent. */
export function wireProject(projectDir: string, invite: Invite, name: string): WireResult {
  const pairwaveDir = join(projectDir, ".pairwave");

  // 1. room config
  const cfg: RoomConfig = {
    v: 1,
    roomId: invite.roomId,
    relayUrl: invite.relayUrl,
    saltB64: invite.saltB64,
    passphrase: invite.passphrase,
    peerId: "p-" + randomBytes(4).toString("hex"),
    name,
  };
  saveConfig(pairwaveDir, cfg);

  // 2. .mcp.json (merge; abort on unparseable rather than clobber)
  const mcpJsonPath = join(projectDir, ".mcp.json");
  let mcp: Record<string, unknown> = {};
  if (existsSync(mcpJsonPath)) {
    try {
      mcp = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
    } catch {
      throw new Error(`${mcpJsonPath} exists but is not valid JSON — fix or remove it, then re-run.`);
    }
  }
  const servers = (mcp.mcpServers ?? {}) as Record<string, unknown>;
  servers.pairwave = {
    command: "node",
    args: [companionEntryPath()],
    env: { PAIRWAVE_DIR: pairwaveDir },
  };
  mcp.mcpServers = servers;
  writeFileSync(mcpJsonPath, JSON.stringify(mcp, null, 2) + "\n", "utf8");

  // 3. the /pairwave skill
  const skillSrc = join(HERE, "..", "skill", "SKILL.md");
  const skillDir = join(projectDir, ".claude", "skills", "pairwave");
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  copyFileSync(skillSrc, skillPath);

  // 4. keep secrets out of git
  const gitignorePath = join(projectDir, ".gitignore");
  const ignoreLine = ".pairwave/";
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (!current.split(/\r?\n/).some((l) => l.trim() === ignoreLine)) {
    writeFileSync(gitignorePath, current + (current.endsWith("\n") || current === "" ? "" : "\n") + ignoreLine + "\n", "utf8");
  }

  return {
    configPath: join(pairwaveDir, "config.json"),
    mcpJsonPath,
    skillPath,
    uiNote: "http://127.0.0.1:7591 (the companion prints the exact port when it starts)",
  };
}

export { encodeInvite, pathToFileURL };
