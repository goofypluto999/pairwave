import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeInvite, decodeInvite, type Invite } from "../src/invite.js";

const INV: Invite = {
  v: 1,
  roomId: "rm-0123456789abcdef",
  relayUrl: "ws://127.0.0.1:8787",
  saltB64: "AAAAAAAAAAAAAAAAAAAAAA==",
  passphrase: "a-strong-passphrase-with-length",
};

test("invite round-trips exactly", () => {
  const code = encodeInvite(INV);
  assert.ok(code.startsWith("pw1."));
  assert.deepEqual(decodeInvite(code), INV);
  assert.deepEqual(decodeInvite(`  ${code}  `), INV); // tolerant of copy-paste whitespace
});

test("corrupted and foreign codes are rejected with clear messages", () => {
  assert.throws(() => decodeInvite("not-an-invite"), /expected it to start with pw1\./);
  assert.throws(() => decodeInvite("pw1.%%%%"), /corrupted|malformed/);
  const weak = encodeInvite({ ...INV, passphrase: "short" });
  assert.throws(() => decodeInvite(weak), /malformed|incompatible/);
});
