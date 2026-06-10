/**
 * @pairwave/relay CLI entry.  (SPEC §3.1)
 * Boots the untrusted relay. Stores ciphertext only; holds no keys.
 */
import { createRelay } from "./server.js";

const port = Number(process.env.PORT ?? "8787") || 8787;

const relay = await createRelay({ port });
console.log(`[pairwave-relay] listening on :${relay.port}`);
console.log(`[pairwave-relay] untrusted bus — ciphertext only, no keys, no plaintext.`);

const shutdown = async (): Promise<void> => {
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
