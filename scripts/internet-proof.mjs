// THE MONEY TEST: two companions exchange a verified, E2E-encrypted message through the PUBLIC
// community relay over the real internet — exactly what a Gio+Joao session does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CompanionRuntime } from "@pairwave/companion/dist/runtime.js";
import { saveConfig } from "@pairwave/companion/dist/persist.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RELAY = "ws://127.0.0.1:8787";
const roomId = "rm-proof-" + randomBytes(6).toString("hex");
const saltB64 = randomBytes(16).toString("base64");
const passphrase = randomBytes(24).toString("base64url");

const dirA = mkdtempSync(join(tmpdir(), "pw-net-A-"));
const dirB = mkdtempSync(join(tmpdir(), "pw-net-B-"));
saveConfig(dirA, { v: 1, roomId, relayUrl: RELAY, saltB64, passphrase, peerId: "p-gio", name: "Gio" });
saveConfig(dirB, { v: 1, roomId, relayUrl: RELAY, saltB64, passphrase, peerId: "p-joao", name: "Joao" });

const A = await CompanionRuntime.boot(dirA);
const B = await CompanionRuntime.boot(dirB);
A.start(); B.start();
await wait(2500); // real internet round-trips

console.log("peers via PUBLIC relay — A sees:", A.peers().map((p) => p.name), "| B sees:", B.peers().map((p) => p.name));
const sasA = (await A.sasWords())?.join(" ");
const sasB = (await B.sasWords())?.join(" ");
console.log("SAS identical across internet:", sasA === sasB, `(${sasA})`);

const r = await A.send("chat", { text: "internet proof: hello Joao, via the community relay" }, "human");
console.log("send:", r.ok ? "ok" : r);
await wait(2000);
const got = B.core.messages().find((m) => m.kind === "chat");
console.log("B decrypted over internet:", got ? `"${got.body.text}"` : "NOT RECEIVED");

await A.shutdown(); await B.shutdown();
rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true });
process.exit(got && sasA === sasB ? 0 : 1);
