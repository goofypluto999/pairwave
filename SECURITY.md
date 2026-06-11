# Security Policy

## Model in one paragraph
Rooms are end-to-end encrypted (Argon2id key from a 192-bit invite passphrase; XChaCha20-Poly1305
with roomId as associated data). Every message is Ed25519-signed against a pinned peer identity and
hash-DAG-linked (tamper-evident on arrival and on reload). Humans verify a six-word SAS fingerprint
out-of-band before substantive exchange. The relay is untrusted by design — it stores and forwards
ciphertext only and enforces a 2-peer room cap. The companion has no project-tree or shell access;
all actions pass a danger guard plus two human permission gates. Full detail:
[docs/SPEC.md §15](docs/SPEC.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Reporting a vulnerability
Open a **GitHub private security advisory** on this repo (preferred), or an issue titled
`[security]` with **no exploit details**. If a malicious relay can read or forge content, that is a
critical bug — report it immediately. Please never include real invite codes, keys, or transcripts.

## Known, documented limits (v1)
Relay sees metadata (room id, sizes, timing, presence) · forward secrecy is session/room-level
(ephemeral ECDH content key, deleted on burn) — per-message ratchet (post-compromise security)
planned) · a compromised endpoint or a malicious *trusted peer* is out of scope.
