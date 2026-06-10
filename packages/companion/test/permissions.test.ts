import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionQueue, normalizeRisk, gate1Decision, type PermissionRequest } from "../src/permissions.js";

const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  requestMsgId: "33333333-3333-3333-3333-333333333333",
  fromPeerId: "B",
  action: "apply_patch",
  risk: "low",
  summary: "apply a small patch",
  payload: "--- a\n+++ b\n",
  ...over,
});

test("risk is re-normalized — the sender's claim is never trusted", () => {
  assert.equal(normalizeRisk("run_command", "low"), "high"); // executing is always high
  assert.equal(normalizeRisk("write_file", "low"), "medium"); // overwrite ≥ medium
  assert.equal(normalizeRisk("apply_patch", "low"), "low");
  assert.equal(normalizeRisk("fetch_url", "high"), "high");
});

test("gate-1 posture: none prompts everything, low auto-approves low, all auto-approves", () => {
  assert.equal(gate1Decision("low", "none"), "prompt");
  assert.equal(gate1Decision("low", "low"), "approve");
  assert.equal(gate1Decision("high", "low"), "prompt");
  assert.equal(gate1Decision("high", "all"), "approve");
});

test("approval yields an ApplyTask descriptor (companion never applies it itself)", () => {
  const q = new PermissionQueue(() => 0);
  const p = q.enqueue(req());
  assert.equal(q.pending().length, 1);

  const r = q.decide(p.id, "approve");
  assert.ok(r.ok && r.status === "approved");
  assert.ok(r.ok && r.task && r.task.action === "apply_patch");
  assert.ok(r.ok && r.task!.note.includes("Gate 2"));
  assert.equal(q.pending().length, 0); // no longer pending
});

test("denial yields no task; re-deciding is rejected", () => {
  const q = new PermissionQueue(() => 0);
  const p = q.enqueue(req({ action: "run_command", risk: "high" }));
  const d = q.decide(p.id, "deny");
  assert.ok(d.ok && d.status === "denied");
  assert.ok(d.ok && d.task === undefined);

  const again = q.decide(p.id, "approve");
  assert.ok(!again.ok && again.error === "already_denied");
});

test("deciding an unknown permission is rejected", () => {
  const q = new PermissionQueue(() => 0);
  const r = q.decide("perm-999", "approve");
  assert.ok(!r.ok && r.error === "unknown_permission");
});
