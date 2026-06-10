/**
 * Quarantine for shared code artifacts.  (SPEC §9.2, §4.4)
 *
 * A received `code` message lands here as INERT data — written under `.pairwave/<room>/quarantine/`,
 * never into the project tree, never executed. Using it requires an explicit action.request that
 * passes the permission gate; only then does the RECEIVER's own Claude apply it via its own tools.
 * The base directory is injectable so tests run against a temp dir (and to prove it never targets
 * the project).
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type QuarantinedArtifact = {
  msgId: string;
  roomId: string;
  /** Absolute path to the stored inert content. */
  path: string;
  language: string;
  isPatch: boolean;
  pathHint?: string | undefined;
};

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function quarantineDir(baseDir: string, roomId: string): string {
  return join(baseDir, sanitize(roomId), "quarantine");
}

const EXT: Record<string, string> = {
  typescript: "ts",
  ts: "ts",
  javascript: "js",
  js: "js",
  python: "py",
  py: "py",
  json: "json",
  bash: "sh",
  shell: "sh",
};

function extFor(language: string | undefined): string {
  return EXT[(language ?? "text").toLowerCase()] ?? "txt";
}

/** Persist a code artifact inert on disk. Returns its location — nothing runs, nothing else changes. */
export function quarantineCode(
  baseDir: string,
  roomId: string,
  msgId: string,
  body: { content: string; language?: string; isPatch?: boolean; pathHint?: string },
): QuarantinedArtifact {
  const dir = join(quarantineDir(baseDir, roomId), sanitize(msgId));
  mkdirSync(dir, { recursive: true });
  const ext = body.isPatch ? "patch" : extFor(body.language);
  const file = join(dir, `artifact.${ext}`);
  writeFileSync(file, body.content, { encoding: "utf8" });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify(
      {
        msgId,
        roomId,
        language: body.language ?? "text",
        isPatch: !!body.isPatch,
        pathHint: body.pathHint ?? null,
      },
      null,
      2,
    ),
  );
  return {
    msgId,
    roomId,
    path: file,
    language: body.language ?? "text",
    isPatch: !!body.isPatch,
    pathHint: body.pathHint,
  };
}

export function readQuarantined(artifact: QuarantinedArtifact): string {
  return readFileSync(artifact.path, "utf8");
}
