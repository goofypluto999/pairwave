import { test } from "node:test";
import assert from "node:assert/strict";
import { scanForSecrets, hasSecrets } from "../src/secrets.js";

test("flags an AWS access key", () => {
  const f = scanForSecrets("here is the key AKIAIOSFODNN7EXAMPLE in config");
  assert.ok(f.some((x) => x.rule === "aws_access_key"));
});

test("flags a Stripe live key", () => {
  assert.ok(hasSecrets("STRIPE=sk_live_abcdef0123456789ABCDEF"));
});

test("flags a private key block", () => {
  assert.ok(hasSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk...\n"));
});

test("flags a secret assignment", () => {
  const f = scanForSecrets('PASSWORD = "hunter2-correct-horse"');
  assert.ok(f.some((x) => x.rule === "secret_assignment"));
});

test("does not flag ordinary prose or code", () => {
  assert.equal(hasSecrets("The quick brown fox jumps over the lazy dog."), false);
  assert.equal(hasSecrets("const total = price * quantity; // running tally of the key metric"), false);
});

test("findings are masked, never the raw secret", () => {
  const f = scanForSecrets("token=supersecretvalue12345");
  assert.ok(f.length > 0);
  assert.ok(!f[0]!.preview.includes("supersecretvalue12345"));
});
