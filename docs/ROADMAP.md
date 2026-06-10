# Pairwave — Roadmap

Phased so each step is independently testable and the risky/novel parts (execution model,
turn-taking, permissions, resume) are proven before polish. Nothing here is built yet beyond Phase 0.

Legend: ☐ todo · ◐ partial · ☑ done

---

## Phase 0 — Spec & scaffold  ☑ (this repo, SPEC draft 0.2)
- ☑ Architecture, wire format, threat model (`docs/SPEC.md`)
- ☑ Protocol types as code (`packages/protocol/src/*`), typechecks clean
- ☑ Skill operating contract (`skill/pairwave/SKILL.md`)
- ☑ Monorepo scaffold + stubs
- ☑ **Design-hardening pass (0.2):** execution model (§4), who-applies-code (§9.2), summary split
  (§9.3), UI topology (§3.3), SAS + key persistence (§10), hash-DAG (§5.4), enforcement (§8),
  failure modes (§12), history TTL (§13.3)
- ☐ Reviewer sign-off on §4 (execution model), §7 (turn-taking), §9 (permissions)

## Phase 1 — Crypto + protocol core  ☑ (12/12 tests green, typecheck clean)
- ☑ `crypto.ts`: Argon2id KDF, XChaCha20-Poly1305 AEAD (roomId-bound), Ed25519 sign/verify, **SAS** word list
- ☑ `dag.ts`: BLAKE2b hashing, DAG `verify` + fork-merge + deterministic `topoOrder`
- ☑ `buildMessage`/`seal`/`open` with fail-closed verification (decrypt → hash → roomId → sig → Zod)
- ☑ Identity key **generation** (`generateIdentity`) (SPEC §10) — fs **persistence** deferred to Phase 3 boot
- ☑ Zod-validate every decrypted Message (`open` uses `safeParse`; rejects malformed/forged)
- ☑ Tests: round-trip, ciphertext/content tamper, wrong-key, cross-room replay, bad-sig, SAS determinism + MITM-differs, DAG verify/order/tamper/gap
- ☑ **Verified:** flipped byte / wrong key / cross-room / forged sig all fail closed; forked history orders deterministically.
- ⚠ Known issue: libsodium-wrappers-sumo@0.7.16 ESM entry is broken → we load its CJS build via `createRequire` (see `src/sodium.ts`). Pins crypto to Node for now (fine for v1; UI doesn't import crypto).

## Phase 2 — Relay (untrusted bus)  ☑ (6/6 tests green, typecheck clean)
- ☑ WS fan-out by roomId + per-room monotonic `seq` (client↔relay frames in `protocol/transport.ts`)
- ☑ REST history replay (`GET /rooms/:id/messages?sinceSeq=`) + `/healthz`
- ☑ Presence + pong **ControlFrame** (SPEC §5.5) + ws-level heartbeat (unref'd)
- ☑ Append-only `MemoryStore` with per-room **TTL** prune (SPEC §13.3); `burn` purge (best-effort)
- ☑ Structural proof the relay decrypts **nothing**: it never imports a key/`open`; store holds only the 6 envelope fields; test asserts plaintext is unrecoverable from stored ciphertext
- ☑ 2-party room cap, frame validation (rejects junk), ciphertext size cap
- ☑ **Verified:** sealed message survives a real WS round-trip and decrypts only with the key; presence flips 1→2→1; seq monotonic; REST replay; burn empties history.
- ◐ Durability: in-memory store only (history evaporates on restart — privacy-friendly default). A JSONL/SQLite `Store` can drop in behind the same interface later.

## Phase 3 — Companion (the hard one)  ◐ (building in verifiable chunks)
- ☑ **Chunk 1 — Floor state machine** (`floor.ts`): pure `deriveFloor` (log → floor/turn/hop) + hard
  `evaluateSend` enforcement (out-of-turn, maxHops, invalid yield/claim). Added `origin` (human/agent)
  to the protocol for hop counting. **8/8 tests green.**
- ☑ **Chunk 2 — Permissions + safe code sharing** (`permissions.ts`, `quarantine.ts`, `secrets.ts`):
  Gate-1 posture (`none`/`low`/`all`), receiver-side risk re-normalization (run_command→high), approval
  yields an `ApplyTask` descriptor (companion never writes/execs); inert quarantine under
  `.pairwave/<room>/quarantine/`; outbound secret scan (AWS/Stripe/GitHub/OpenAI/Slack/JWT/private-key/
  assignment). **13 new tests (21 companion total).**
- ☑ **Chunk 3 — Activity Ledger + charter/SAS bootstrap gate** (`ledger.ts`, `bootstrap.ts`): free
  left-rail data; `gateSend` composes the SAS+charter gate over floor enforcement. (7 tests)
- ☑ **Chunk 3.5 — CompanionCore engine** (`engine.ts`): the I/O-free brain composing every module —
  `send` (gate → secret-scan → sign → seal) + `ingest` (decrypt → verify → dedupe) + floor/ledger/
  bootstrap views + charter helpers. **End-to-end test: two companions agree a charter, hand off the
  floor, exchange a gated artifact, block a secret, reject a tampered envelope — all via real crypto.** (5 tests)
- ☑ **Chunk 4 — live wiring** (`persist.ts`, `relayclient.ts`, `runtime.ts`): identity keys
  (~/.pairwave, 0600), crash-safe JSON (tmp+rename), durable log.jsonl, outbox-until-echo resend,
  reconnect with `sinceSeq` replay, TOFU pinning + key-change detection, charter-policy adoption,
  Gate-1 auto/manual flow, inbox, live-mode state, change events.
- ☑ **Chunk 5 — MCP server** (`mcp.ts`): 17 `pair_*` tools, testable dispatch + stdio wiring;
  stdout reserved for protocol; stderr logging. **← usable inside Claude Code.**
- ☑ **Bugs the e2e caught and fixed:** charter helpers bypassed the publish path (never hit the
  wire); doubled hello publishes (two resend queues → one durable outbox); `action.result`
  hop-blocked → receipt deadlock (now a non-hop receipt, SPEC 0.3).
- **Verify (phase):** scripted two-Companion run exercises verify → charter → floor → a two-gate action; out-of-turn/secret sends are *rejected*.

## Phase 4 — Install & skill  ☑
- ☑ `pairwave init` / `join <invite>` / `relay` / `status` (`packages/cli`): invite codec (versioned,
  validated), config + identity, `.mcp.json` merge (never clobbers; refuses malformed), skill install
  to `.claude/skills/pairwave/`, `.gitignore` protection. 5 tests incl. idempotency.
- ☑ Live mode = `pair_live_mode` state + skill-side polling contract (bounded, cost-stated) (SPEC §4.3)
- ☑ `SKILL.md` finalized against the real 17-tool surface (shipped in the cli package)
- ◐ Not yet published to npm — install is clone+`npm run verify` (README quickstart). Publishing is a
  release step, not a code gap.

## Phase 5 — Web UI (two local mirrors)  ☑
- ☑ Zero-build static dashboard served by the companion (SPEC 0.3 §3.3): activity rail, transcript
  (origin + kind chips), permission popups w/ risk + payload preview + always-allow, SAS banner,
  key-change warning, floor control, human chat composer, handoff button, SSE + `?nosse`
- ☑ **Browser-verified live** (preview): state chips, auto-opened permission popup, Approve-once →
  approved-task card with the exact `pair_apply` instruction, human chat onto the encrypted wire
- ☐ Diff *rendering* for patches is plain `<pre>` (payload shown verbatim) — pretty diff view is a
  nice-to-have, not a gap in function

## Phase 6 — Resume loop  ☑
- ☑ Handoff writer (charter, ledger, open threads, artifact index, full transcript table, resume
  steps) + `handoff-latest.md`; automatic on shutdown/stdio close; `pair_resume` loads it
- ☑ **Verified:** e2e test boots a fresh runtime over the same dir — charter, ledger, SAS state all
  restored from the durable log; demo + UI exercise the button

## Phase 7 — Hardening & release  ◐
- ☑ Security disclosure note (README); honest threat model (SPEC §15); MIT license
- ☐ npm publish; reference relay deploy guide beyond README's VPS/tunnel note
- ☐ Post-v1 crypto: Double-Ratchet (forward secrecy), relay write-tokens, N-party rooms (SPEC §13.4)

---

## Risk register
| Risk | Status | Mitigation |
|------|--------|------------|
| "Two Claudes talk" assumed always-on daemons | **resolved (design)** | async/turn-based + engagement points + bounded live mode (SPEC §4) |
| Two agents loop and burn tokens | mitigated | maxHops + quiet-by-default + maxTurnsPerTask, hard-enforced (§7.3, §8) |
| Shared code causes side effects | resolved (design) | inert quarantine + two-gate apply + least-privilege Companion (§9.2) |
| Relay operator snoops/forges | mitigated | E2E AEAD + Ed25519 sigs + hash-DAG; relay sees only ciphertext (§15) |
| Invite-channel MITM | resolved (design) | SAS verification, promoted to v1 (§10) |
| "Free live summary" overclaimed | resolved | ledger (free) vs narrative (LLM, on-demand) split (§9.3) |
| Concurrent-message ordering under untrusted relay | resolved (design) | hash-DAG + deterministic fork-merge (§5.4) |
| Secret pasted into channel | mitigated | outbound secret scan blocks send (§9.4) |
| Lost session context | resolved (design) | per-peer handoff `.md` + resume (§11) |
