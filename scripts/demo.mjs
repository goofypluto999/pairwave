/**
 * Pairwave local demo — no friend required.
 *
 * Boots: a relay + two companions ("Alice" and you, "Bob") in a temp directory, walks the real
 * protocol (hello → SAS → charter → floor → context/decision → shared code → an action request that
 * lands in YOUR permission queue), then serves Bob's dashboard so you can click through it.
 *
 *   node scripts/demo.mjs        → prints the dashboard URL (default http://127.0.0.1:7591)
 *
 * Everything lives in a temp dir and is deleted on Ctrl+C. Nothing touches your projects.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRelay } from "@pairwave/relay/dist/server.js";
import { CompanionRuntime } from "@pairwave/companion/dist/runtime.js";
import { saveConfig } from "@pairwave/companion/dist/persist.js";
import { startUiServer } from "@pairwave/companion/dist/uiserver.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = await createRelay({ port: 0 });
const relayUrl = `ws://127.0.0.1:${relay.port}`;
const roomId = "rm-demo-" + randomBytes(6).toString("hex");
const saltB64 = randomBytes(16).toString("base64");
const passphrase = randomBytes(24).toString("base64url");

const dirA = mkdtempSync(join(tmpdir(), "pw-demo-alice-"));
const dirB = mkdtempSync(join(tmpdir(), "pw-demo-bob-"));
saveConfig(dirA, { v: 1, roomId, relayUrl, saltB64, passphrase, peerId: "p-alice", name: "Alice" });
saveConfig(dirB, { v: 1, roomId, relayUrl, saltB64, passphrase, peerId: "p-bob", name: "Bob" });

const alice = await CompanionRuntime.boot(dirA);
const bob = await CompanionRuntime.boot(dirB);
alice.start();
bob.start();
await wait(700);

// SAS confirmed (in real use the humans compare the words first — the banner shows them)
alice.confirmVerification();
// Bob (you) stays UNVERIFIED so the SAS banner is visible in the dashboard. Click it to verify.

await alice.proposeCharter({
  title: "Demo: wire the settings page",
  purpose: "Show what a live Pairwave session looks like",
  scope: ["settings page", "user preferences API"],
  mustNots: ["no secrets", "no production deploys"],
  autoApprove: "none",
});
await wait(400);
await bob.acceptCharter();
await wait(400);
bob.confirmVerification(); // verify AFTER charter so the early banner moment is still honest above

await alice.send("turn.claim", {}, "human");
await wait(300);
await alice.send("chat", { text: "Hey! Sending over the prefs work — check your rail." }, "human");
await alice.send(
  "context",
  { headline: "Prefs API shape locked", text: "GET/PUT /api/prefs — flat JSON, server validates keys.", claim: "fact" },
  "agent",
);
await alice.send(
  "decision",
  { headline: "LocalStorage fallback", decision: "Cache prefs in localStorage when offline", rationale: "survives flaky wifi" },
  "agent",
);
const code = await alice.send(
  "code",
  {
    headline: "prefs.ts — typed client",
    language: "typescript",
    content: `export type Prefs = { theme: "dark" | "light"; pageSize: number };\n\nexport async function loadPrefs(): Promise<Prefs> {\n  const res = await fetch("/api/prefs");\n  return res.json();\n}\n`,
    isPatch: false,
    pathHint: "src/lib/prefs.ts",
  },
  "agent",
);
await wait(300);
// A human beat — also resets the agent hop counter (the anti-loop cap is real: without this,
// the next agent message would be the 4th in a row and the companion would refuse it).
await alice.send("chat", { text: "Mind approving the file write when the popup shows?" }, "human");
if (code.ok) {
  const req = await alice.send(
    "action.request",
    {
      action: "write_file",
      risk: "low",
      summary: "Create src/lib/prefs.ts from the shared artifact",
      payload: "(artifact content — shown from quarantine on approval)",
      targetPath: "src/lib/prefs.ts",
      fromCodeMsgId: code.message.msgId,
    },
    "agent",
  );
  if (!req.ok) console.error("demo: action.request blocked:", req.code, req.reason);
}
// The shared brain: either side contributes anytime (not floor-gated) — note Bob writes too.
await alice.remember({
  headline: "Prefs API lives at /api/prefs",
  content: "GET/PUT /api/prefs — flat JSON, keys validated server-side.",
  tags: ["api", "prefs"],
  entryKind: "fact",
  origin: "human",
});
await wait(200);
await bob.remember({
  headline: "Bob owns the settings toggle UI",
  content: "The settings-page toggle component is Bob's; Alice owns the prefs API.",
  tags: ["ownership"],
  entryKind: "insight",
  origin: "human",
});
// Shared git repo — clean split, no overlaps, a push to pull.
await alice.gitSetup({ repo: "github.com/acme/settings-app", branch: "feat/prefs", strategy: "shared-branch" });
await wait(150);
await alice.gitClaim(["src/lib/prefs.ts", "src/api/**"]);
await bob.gitClaim(["src/components/SettingsToggle.tsx"]);
await wait(150);
await bob.gitAnnounceCommit({ sha: "9f3c1a2b7d", branch: "feat/prefs", message: "scaffold settings toggle", paths: ["src/components/SettingsToggle.tsx"] });
await alice.send("question", { text: "Do you want pageSize in the first cut, or theme only?" }, "human");
await wait(500);

const ui = await startUiServer(bob, Number(process.env.PORT ?? 7591));
console.log("");
console.log(`  Pairwave demo dashboard (you are Bob): ${ui.url}`);
console.log(`  Things to try: the SAS verify banner, the permission popup (Alice's write_file`);
console.log(`  request), the floor button, and the chat composer. Ctrl+C cleans everything up.`);
console.log("");

const cleanup = async () => {
  await bob.shutdown().catch(() => {});
  await alice.shutdown().catch(() => {});
  await ui.close().catch(() => {});
  await relay.close().catch(() => {});
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
