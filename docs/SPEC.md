# Pairwave — Specification

**Version:** draft 0.2 · **Status:** for review · **License:** PolyForm Noncommercial 1.0.0

This document is the source of truth for the design. The hard part of this project is not the
plumbing — it is the **execution model and protocol discipline**: how an inherently turn-based agent
"talks back," when each side processes the channel, how context is established, how code is shared
without side effects, how every action is gated, and how a session resumes. Code in `packages/`
implements this spec; where they disagree, the spec wins until updated.

> Notation: **MUST / MUST NOT / SHOULD / MAY** in the RFC-2119 sense.

### What changed in 0.3 (the implementation pass — spec updated to match shipped reality)
- **§7.3** — `action.result` is a non-hop **receipt**: it never counts toward, and is never blocked
  by, the agent hop cap. The e2e suite proved the alternative deadlocks the requester (a receipt for
  a human-approved action is not autonomous chatter; loops stay impossible because `action.request`
  still counts).
- **§3.3** — the dashboard ships as a **zero-build static page** served by the companion
  (`packages/companion/ui/index.html`), not a Vite/React SPA: nothing to compile or break on
  install. Same three-pane layout, popups, SAS banner, SSE live updates (+ `?nosse` poll-only mode).
- **§4.5** — one resend path: every unconfirmed publish lives in the **durable outbox**
  (confirmed by the relay echo), re-published on (re)join. The relay client holds no second queue.
- **§12** — dropped envelopes and relay rejections are surfaced (stderr + UI counter), never silent.
- §16's remaining open questions were resolved: notifications = dashboard badge/popups (no native
  toast dep in v1); packaging = CLI installs the skill + wires `.mcp.json`; relay hosting = any
  cheap host or a tunnel (documented in README).

### What changed in 0.2 (the design-hardening pass)
- **§4 Execution model (NEW)** — Pairwave is async/turn-based by default; "live mode" is opt-in and
  bounded. This replaces the earlier, false assumption that both agents are always-on daemons.
- **§9.2** — resolved *who applies shared code*: companion has least privilege (no project/shell
  access); two distinct permission gates.
- **§9.3** — summary split into a free **Activity Ledger** + an on-demand **Narrative Summary**;
  added sender-supplied `headline`.
- **§3.3** — UI is explicitly two local mirrors, not a shared website.
- **§10** — **SAS verification** + persistent identity keys promoted to v1.
- **§5.4** — message graph is a **hash-DAG** with deterministic fork-merge (concurrency).
- **§8 Enforcement (NEW)**, **§12 Failure modes (NEW)**, reconnect/resync (§11), history TTL (§13.x).

---

## 1. Goals and non-goals

### 1.1 Goals
- **G1 — Two humans, two machines.** Each with their own Claude Code, own laptop/network.
- **G2 — Free + self-hostable.** No paid service required. E2E encryption makes even a shared/public
  relay safe.
- **G3 — Safe by construction.** Relay can't read or forge. Nothing touches a user's disk or shell
  without explicit consent. Secrets are scanned out before leaving.
- **G4 — Easy to adopt.** One command to init/join; the skill bootstraps the rest.
- **G5 — Curated, not chatty.** Typed, timestamped, provenance-tagged artifacts; a shared Charter
  (task, purpose, rules, MUST-NOTs) loaded by both Claudes before any exchange.
- **G6 — Trackable.** A signed, hash-linked transcript and a live structured ledger.
- **G7 — Resumable.** Disconnect produces a per-side handoff file; reconnect restores full context.
- **G8 — Transparent.** Free for noncommercial use (PolyForm NC 1.0), no telemetry, no hidden calls, documented limits, no surprise spend.

### 1.2 Non-goals (v1)
- **Not always-on autonomy.** v1 is **async/turn-based** (§4). Real-time is an opt-in, bounded mode.
- **Not >2 participants.** Protocol generalizes to N; v1 targets exactly 2 for tractable turns.
- **Not a CRDT live editor.** We exchange artifacts/context, not keystrokes.
- **Not anonymity.** The relay sees room id, sizes, timing, and presence (§13).
- **Not endpoint security.** If a machine is compromised, its key/plaintext are exposed.
- **Not forward secrecy in v1.** Static key from passphrase; ratchet is a later phase (§13.4).

---

## 2. Roles and definitions

| Term | Meaning |
|------|---------|
| **Peer** | One human + their Claude Code + their Companion. Exactly two per room in v1. |
| **Relay** | Untrusted server. Routes encrypted envelopes by `roomId`, orders them, stores ciphertext, reports presence. |
| **Companion** | Local process on each machine. Holds the session key + identity key. Bridges Claude Code (MCP) ⇄ relay (E2E) ⇄ local UI. The trust boundary. **No access to the project tree or shell.** |
| **Room** | A channel identified by `roomId`. One collaboration. |
| **Charter** | The agreed task, purpose, scope, rules, MUST-NOTs both Claudes load before substantive exchange. §6. |
| **Engagement point** | A moment a side's Claude consults the channel (§4.2). |
| **Live mode** | Opt-in bounded polling so a side reacts in near-real-time (§4.3). |
| **Floor** | Authority to push substantive artifacts. One holder at a time (§7). |
| **Activity Ledger** | Free, deterministic, always-current structured state for the UI rail (§9.3). |
| **Narrative Summary** | On-demand LLM prose recap, written by a peer's own Claude (§9.3). |
| **SAS** | Short Authentication String — out-of-band fingerprint check defeating invite-channel MITM (§10). |
| **Artifact** | A typed payload: decision, context bundle, code, action request, etc. (§5.3). |
| **Handoff** | Per-peer markdown snapshot written at disconnect, reloaded on resume (§11). |

---

## 3. Architecture

Three TypeScript packages + one skill (`packages/`, `skill/`).

### 3.1 Relay (`@pairwave/relay`) — untrusted
- WebSocket fan-out by `roomId`; assigns a monotonic `seq`; stamps `tsRelay` (untrusted ordering aid).
- REST history replay (`GET /rooms/:roomId/messages?sinceSeq=`) for reconnect/resume.
- Emits **presence** control frames (peer connected/last-seen seq) — relay-level metadata, not message
  content (§5.5).
- Persists **envelopes only** (ciphertext) with a per-room **TTL** (§13.3). Holds no keys, no plaintext.
- Could be operated by a stranger and learn only traffic shape + presence.

### 3.2 Companion (`@pairwave/companion`) — trusted, local, least-privilege
- Holds the **session key** (from the room passphrase) and the peer's **identity keypair** (§10).
- Connects to the relay over WSS; **seals** outbound / **opens + verifies** inbound.
- Exposes an **MCP server (stdio)** to Claude Code: the `pair_*` tools (§14).
- Exposes a **localhost-only** HTTP/WS API for the local UI (plaintext stays on the box).
- Owns local state under `.pairwave/`: charter, verified message log, Activity Ledger, permission
  queue, **quarantine** for shared code, handoff files.
- **Least privilege:** the Companion writes ONLY inside `.pairwave/`. It **never** writes the project
  tree and **never** executes shell commands. Applying shared code is done by the receiving Claude
  through its own tools (§9.2).

### 3.3 Web UI (`@pairwave/ui`) — two local mirrors (not a shared site)
There is **no single shared website**. Each peer runs **their own** local UI, served by **their own**
Companion at `http://127.0.0.1:<port>`, decrypting locally. The two UIs mirror the same channel
(same messages + ledger); they differ only in "what's addressed to me / my pending permissions / my
floor + verification status." A shared hosted UI is rejected for v1 because it would require the
server (or a third party) to hold the session key, breaking E2E. (A future in-browser-E2E hosted UI
is possible with a documented tradeoff — not v1.)
- Left **Activity Ledger rail** (§9.3); center transcript (with chain badge); right artifact/diff panel.
- **Permission popups** (§9.1), **floor indicator**, **SAS verification** banner (§10).

### 3.4 Skill (`skill/pairwave/SKILL.md`)
The `/pair` (alias of `/pairwave`) workflow. Encodes the operating contract: engagement behavior,
bootstrap order, SAS step, turn rules, message format, the two-gate apply flow, and resume. The skill
makes good behavior *likely*; the Companion makes bad behavior *impossible* (§8).

---

## 4. Execution model & timing (the resolved blocker)

A Claude Code session is **turn-driven**: the model acts when its human sends a message, when a tool
returns, or when an external pacer (a scheduled wake-up / loop tick) re-invokes it. It does **not**
sit idle and spontaneously react to an inbound network message. Pairwave is designed around that
reality instead of pretending otherwise.

### 4.1 Async-first
The channel is an **asynchronous shared workspace**. Messages are durable: the Companion persists the
inbox, so nothing is lost while a side's Claude is "asleep." Back-and-forth happens at engagement
points, not in real time — unless a side opts into live mode (§4.3).

### 4.2 Engagement points (when a side processes the channel)
A side's Claude consults the channel (`pair_inbox` / `pair_status`) when:
1. `/pair` is invoked (bootstrap or resume).
2. Its human engages and the turn relates to the collaboration (the skill instructs Claude to check
   the inbox first at these turns).
3. The human acts on a **notification**: the Companion raises an OS toast + UI badge when items
   arrive that need this side (a question to me, an action request to me, a floor grant). The
   notification wakes the *human*, who pulls their Claude in — keeping a human in the loop by default.

Nothing requires polling every turn; the durable inbox + notification is the "you have mail" signal.

### 4.3 Live mode (opt-in, bounded, cost-visible)
A side MAY enable live mode (`pair_live_mode on`) for near-real-time exchange. The skill then uses a
scheduled wake-up / loop to call `pair_inbox` every `LiveModePolicy.pollSec` (floor 30s) and act if it
holds the floor or is addressed. Bounds (enforced by the Companion + skill):
- Auto-stops after `liveModeMaxMinutes` (default 20) or after `idleStopPolls` empty polls (default 4).
- `FloorPolicy.maxHops` still caps agent→agent exchanges (§7.3).
- **Cost is the polling side's own.** Each poll is a model turn billed to that side's Claude. The UI
  shows live-mode status + poll count so cost is never hidden. Pairwave never spends on your behalf or
  the peer's.

### 4.4 Non-blocking sends
A peer never blocks waiting for the other to be awake. After sending (e.g. an `action.request`), a
Claude `pair_yield`s and tells its human "sent; awaiting peer." The reply/result arrives as an inbox
item at the other side's next engagement point or live poll.

### 4.5 Presence, heartbeat, reconnect/resync
- Companion↔relay WS ping/pong every 20s; 3 misses (~60s) ⇒ disconnected ⇒ reconnect with backoff.
- On reconnect: replay history `sinceSeq`, re-verify the DAG (§5.4), recompute floor (§7.4), continue.
- Peer presence comes from relay control frames (§5.5). Floor auto-releases if the holder goes absent
  (§7.2). Idle beyond `handoffOnIdle` (default 5 min) ⇒ write handoff (§11).

---

## 5. Wire format

Two nested layers. The relay sees only the **Envelope**; the **Message** is the encrypted payload.
Plus a relay-level **ControlFrame** for presence (no content).

### 5.1 Envelope (relay-visible) — `packages/protocol/src/envelope.ts`
```
RelayEnvelope { v:1, roomId, seq, tsRelay, nonce, ciphertext }
```
Relay reads `roomId`, `seq`, `tsRelay`, and the size/timing of `ciphertext`. Nothing else.

### 5.2 Message (encrypted) — `packages/protocol/src/messages.ts`
Decrypted and **verified** (signature + DAG link) by the receiving Companion before the UI or Claude
sees it.
```
Message {
  v:1, msgId, roomId,
  sender:{ peerId, name, pubKey },   // Ed25519
  ts,                                 // ISO-8601 UTC — REQUIRED on every message
  tsMono?,
  parents: base64[],                  // hashes of the message(s) this one builds on (DAG; §5.4)
  hash,                               // = H(canonical(message without hash+sig))
  sig,                                // = Ed25519_sign(senderPrivKey, hash)
  kind, turn, body
}
```

### 5.3 Message kinds
| `kind` | Who may send | Purpose | Permission? |
|--------|--------------|---------|-------------|
| `system.hello` | on join | Identity, pubKey, capabilities | no |
| `system.charter` | bootstrap | Propose/accept the shared Charter | no |
| `system.bye` | on leave | Graceful disconnect ⇒ handoff | no |
| `chat` | any time | Freeform prose (human or Claude) | no |
| `context` | floor-holder | Curated context bundle (+ `headline`, provenance) | no |
| `code` | floor-holder | **Inert** code/patch (+ `headline`); lands in quarantine | on *apply* (§9.2) |
| `decision` | any | Tracked decision (+ `headline`) | no |
| `question` | any | Question to the other peer | no |
| `answer` | any | Reply referencing a `question` | no |
| `action.request` | any | "Please apply/write/run/fetch on your side" | **yes** (§9.1) |
| `action.result` | any | Outcome of an approved action | no |
| `turn.yield` / `turn.claim` | per §7 | Floor control | no |
| `summary` | any | A ledger snapshot or narrative summary | no |

`headline` (≤80 chars, sender-written) lets the Activity Ledger show real one-liners at zero extra
cost — the sender's Claude is already composing the message.

### 5.4 Integrity is a hash-**DAG** (not a strict chain)
Each message commits to its `parents` (hashes of the messages its sender had at send time). Normally
one parent ⇒ a chain. Two near-simultaneous messages may share a parent ⇒ a **fork**; the next message
lists **both** as parents ⇒ a **merge**. Properties:
- **Tamper-evidence:** any altered byte breaks `hash`/`sig`; missing parents are detectable.
- **Deterministic display order:** topological sort, ties broken by `(ts, msgId)` — identical on both
  sides without trusting the relay. The relay's `seq` is a transport hint only.
- Forks are rare in practice (only the floor-holder pushes substantive kinds; `chat`/`question` can
  overlap but merge harmlessly).

### 5.5 ControlFrame (relay-level, not encrypted message content)
```
ControlFrame { v:1, roomId, type:"presence"|"pong", peerCount, lastSeq, tsRelay }
```
Carries no message content — only connection metadata the relay inherently has.

---

## 6. Charter — shared context before any exchange

How we satisfy "give full context before using the skill … both Claudes know the task, purpose,
boundaries, MUST-NOTs." Fields: `title, purpose, scope[], outOfScope[], mustNots[],
responseContract[], autoApprove, floorPolicy, liveModePolicy, participants[], createdAt, charterHash`.

### 6.1 Agreement handshake (gates the channel)
1. `/pair` ⇒ each Companion exchanges `system.hello` (identity + pubKey).
2. **SAS verification (§10)** — humans compare the fingerprint out-of-band and confirm before trusting.
3. Initiator proposes `system.charter`; the other human reviews in the UI and accepts (or edits ⇒
   re-proposes).
4. **Substantive kinds (`context`, `code`, `action.request`) are blocked until both sides
   acknowledge the same `charterHash` AND SAS is verified.** `chat` is allowed during negotiation.
5. The agreed Charter is injected into each Claude by the skill.

### 6.2 Response contract (empirical, current, grounded)
Loaded into both Claudes. Every substantive message MUST: carry a UTC timestamp (automatic); **label
claims** (`fact`/`inference`/`assumption`); **cite provenance** (file+lines or URL); **flag
staleness/uncertainty**; be **curated** (minimum payload + one-line rationale + `headline`).

---

## 7. Turn-taking — the floor (works in async and live mode)

The floor is **authority to push substantive artifacts**, independent of the execution model. It stops
two sides from pushing conflicting context and bounds agent↔agent exchange.

### 7.1 Rules
- Only the **floor-holder's** Claude MAY emit `context`, `code`, `decision`, `action.request`,
  `summary`. The non-holder may emit only `chat`, `question`, `answer`, `turn.claim`.
- `TurnMeta` `{ floor, turnId, hop }` rides on every message (`turn.ts`).

### 7.2 Transitions
- **Yield:** holder sends `turn.yield` ⇒ floor moves (or `none`).
- **Claim:** non-holder sends `turn.claim`; holder SHOULD yield. If not within `claimTimeoutSec`
  (default 60) the floor auto-yields to the claimant.
- **Absence:** if the holder is absent (presence lost) past `claimTimeoutSec`, floor auto-releases to
  `none`; the present side may claim.
- **Human precedence:** a human typing on a side pauses that side's Claude from auto-emitting.
- **Simultaneous claim** (a fork): resolved deterministically — lower `(ts, msgId)` wins; the other
  re-claims.

### 7.3 Anti-loop guardrails (also cost control)
- **`maxHops`** (default 3): consecutive agent→agent messages with no human in between. On reaching
  it, the holder MUST `turn.yield` + request a human ack. Hard-enforced by the Companion (§8).
- **`maxTurnsPerTask`** (default 20): soft cap; on hit, the skill summarizes and asks the humans.
- **Rate limit** (default 1 substantive msg / 2s per peer).
- **Quiet by default:** a Claude acts when it holds the floor, is directly addressed, or its human
  tells it to — never auto-replies to everything.

### 7.4 Floor is a pure function of the log
Floor state is derived by replaying `turn.*` messages in DAG order — so after any reconnect both
sides recompute the identical floor without a central authority.

---

## 8. Enforcement — hard (Companion) vs soft (skill)

A 10/10 bar means misbehavior is *impossible*, not merely discouraged. We split responsibilities:

| Rule | Enforced by | How |
|------|-------------|-----|
| Floor (only holder pushes substantive kinds) | **Companion (hard)** | `pair_send` etc. reject out-of-turn kinds with an error, no send. |
| `maxHops` / rate limit | **Companion (hard)** | Counts hops; refuses the over-limit push until a human msg or yield. |
| No secrets outbound | **Companion (hard)** | Secret scan blocks the send (§9.4). |
| No project/shell side effects from a peer | **Companion (hard)** | Companion has no project/shell access; applying goes via the receiver's Claude + its own permissions (§9.2). |
| Charter `scope` / `mustNots` adherence | **Skill (soft)** | LLM-level; probabilistic. Surfaced to humans; not structurally enforceable. |
| Message format / grounding | **Skill (soft)** | Response contract (§6.2). |

We state plainly: semantic rules (scope, tone) are LLM-guided and probabilistic; structural rules
(turn, kind, rate, secrets, side effects) are mechanically enforced.

---

## 9. Safety subsystems

### 9.1 Permission gate (the pop-up)
Any `action.request` (and any local apply of a quarantined `code` artifact) creates a **pending
permission**. The UI popup shows: **what** (action + exact payload: diff preview / verbatim command /
path / URL), **who** (verified peer), **risk** (`low`/`medium`/`high`), and choices **Approve once ·
Deny · Always allow this kind** (session). Posture via `Charter.autoApprove`: `none` (default, every
action prompts) · `low` (auto low-risk) · `all` (auto everything — explicit, persistently shown,
revocable).

### 9.2 Applying shared code — two distinct gates, least privilege (resolved)
The Companion never writes the project tree or runs commands. Flow:
1. Peer sends `code` ⇒ it lands **inert** in the receiver's `.pairwave/<room>/quarantine/`. Nothing
   changes on disk.
2. To use it, an `action.request` (`apply_patch`/`write_file`/`run_command`) passes **Gate 1 —
   Pairwave** ("do I accept this *request* from my peer into my workspace?"; this is where
   `autoApprove` applies).
3. On accept, the artifact becomes a task for the **receiver's own Claude**, which performs the edit
   via its normal `Edit`/`Write`/`Bash` tools — passing **Gate 2 — Claude Code's own permission
   prompt** ("allow this specific disk write / command?").

The two gates are different decisions (trust the request vs. allow the disk op), so they are not
redundant. Even with `autoApprove:all`, Gate 2 (Claude Code) still applies — defense in depth.
`run_command` requests are never executed by the Companion; they're surfaced as a suggested action
for the receiver's human/Claude to run under Claude Code's Bash permission.

### 9.3 Activity Ledger (free) vs Narrative Summary (LLM) — honest split
- **Activity Ledger** — deterministic, zero-cost, always current. Derived purely from typed messages:
  `headlines` of recent context/decisions, `openQuestions` (unanswered `question`s), `decisions`,
  `sharedArtifacts` (+ quarantine paths), `pendingPermissions`, participants, floor + verification
  state, counts, last-activity. This is the left rail. It is an *activity view*, not NLP topic
  modelling — we don't claim more than it does.
- **Narrative Summary** — real prose, written on demand by a peer's **own** Claude via
  `pair_summarize` (runs in the session you already have open — no separate billed service; explicit,
  so no surprise spend). Auto-offered at milestones (before handoff, on `maxTurnsPerTask`).
Both feed the handoff (§11).

### 9.4 Outbound secret scan
Before any Message is sealed, the Companion scans the body for keys/tokens/private-keys/`.env`-shaped
content/high-entropy strings. On a hit it **blocks the send** and warns the human (redact or override
per item). Enforces the standing key-hygiene rule at the protocol layer.

---

## 10. Identity, verification & keys (v1)

- **Persistent identity.** On first `init`/`join`, the Companion generates a long-lived Ed25519
  identity keypair = the peer's stable identity across sessions/rooms. Stored per-OS with tight perms:
  Windows `%APPDATA%\pairwave\identity.key` (DPAPI-wrapped where available); macOS Keychain /
  `~/Library/Application Support/pairwave`; Linux `~/.config/pairwave/identity.key` (0600).
  OS-keystore integration is a hardening item; v1 minimum is a 0600 file.
- **Session key.** Argon2id(passphrase, roomSalt) ⇒ 32-byte symmetric key. Never leaves the Companion.
- **SAS verification (defeats invite-channel MITM).** After both join, each UI shows a short
  fingerprint (e.g. 6 words) derived from both identity pubkeys + room salt. The humans compare it
  out-of-band (read aloud on a call / over Signal) and confirm. Until confirmed, the peer shows
  **unverified** and substantive exchange is blocked (§6.1). Pinned thereafter; a later key change ⇒
  loud warning + re-verify (possible MITM or reinstall).

---

## 11. Sessions, disconnect, and resume

### 11.1 When a handoff is written
On graceful `/pair end` / `system.bye`; on detected idle/disconnect past `handoffOnIdle` (5 min); or
on demand (`pair_handoff`).

### 11.2 Contents (per-peer, local — relay never holds plaintext)
Written to `.pairwave/<roomId>/handoff-<ISO-ts>.md` + a stable `handoff-latest.md` on **each** side:
Charter; full **timestamped, attributed transcript** (decrypted, local); final Activity Ledger +
latest Narrative Summary; open questions; decisions; shared-artifact index (+ quarantine paths); final
floor + verification state; DAG-verification result; `resumeHints` (what each side was mid-doing).

### 11.3 Resume
`/pair` (or `--resume`) for the same room ⇒ load `handoff-latest.md`, re-verify the DAG, re-inject
Charter + ledger + open threads, **diff recorded decisions against current project state** and report
drift, then re-announce readiness so both sides continue with full continuation. Handoff files are
git-ignored (decrypted content).

---

## 12. Failure modes & edge cases (must be handled, not crash)

| Situation | Behavior |
|-----------|----------|
| Charter never agreed (timeout) | Channel stays **chat-only**; substantive kinds remain blocked; UI shows "awaiting charter." |
| SAS not verified | Peer shown **unverified**; substantive kinds blocked; `chat` allowed. |
| Message fails to decrypt (wrong key / corruption) | Quarantine the envelope; surface "couldn't decrypt N messages"; never crash; keep processing others. |
| Bad signature / DAG break | Mark the message **untrusted** in the UI with the break location; do not act on it. |
| Both claim floor at once | Deterministic tiebreak `(ts, msgId)`; loser re-claims (§7.2). |
| Floor-holder disconnects | Floor auto-releases after `claimTimeoutSec`; other side may claim (§7.4). |
| Peer offline when addressed | Item waits durably in inbox; sender is told "awaiting peer" (§4.4). |
| Relay drops/reorders/withholds | Detectable via missing parents / seq gaps; UI flags a gap; replay on reconnect. |
| Live mode runaway | Bounded by `liveModeMaxMinutes`, `idleStopPolls`, `maxHops` (§4.3). |
| Peer key changed | Loud "identity changed" warning; re-verify SAS before trusting (§10). |

---

## 13. Setup, hosting, retention

### 13.1 Install (target UX; Phase 4)
- `npx pairwave init` — generate `roomId` + passphrase ⇒ print one **invite code** (`roomId.passphrase`,
  base32) to share out-of-band; choose relay (local relay + free tunnel, or paste a hosted URL);
  generate identity key; write `.pairwave/config.json`; register the Companion in the project
  `.mcp.json`; install the `/pair` skill.
- `npx pairwave join <invite-code>` — same wiring on the friend's machine.
- Inside Claude Code: `/pair` ⇒ bootstrap (§6) incl. SAS.
No account, no signup, no key escrow.

### 13.2 Hosting the relay
Either run the local relay behind a free tunnel, or deploy the tiny reference relay to a free/cheap
host. Because content is E2E, the relay operator is untrusted either way.

### 13.3 History retention (decided)
Relay keeps **encrypted** history with a per-room TTL: `historyTtlDays` default **7**; `0` =
ephemeral (no-store). A `pair burn` requests room purge — **best-effort only**, since the relay is
untrusted (stated honestly).

### 13.4 Planned hardening (post-v1)
Double-Ratchet (forward secrecy + post-compromise security); optional relay write-tokens (anti-spam,
no E2E impact); N-party rooms.

---

## 14. MCP tools (signatures in `packages/companion/src/tools.ts`)

| Tool | What it does |
|------|--------------|
| `pair_status` | Room, peers, verification + floor state, pending permissions, Activity Ledger snapshot, live-mode status. |
| `pair_verify` | Show/confirm the SAS fingerprint for the peer. |
| `pair_charter` | Read / propose / accept the Charter. |
| `pair_send` | Send chat/context/decision/question/answer. Enforces floor + secret scan. |
| `pair_share_code` | Send an inert `code` artifact (lands in peer quarantine). |
| `pair_request_action` | Send an `action.request` (peer-side gated, §9.2). |
| `pair_read` / `pair_inbox` | Read recent verified messages / items needing me. |
| `pair_respond_permission` | Approve/deny a pending permission (Gate 1). |
| `pair_apply` | Pull an accepted artifact from quarantine so this Claude can apply it via its own tools (Gate 2). |
| `pair_claim` / `pair_yield` | Floor control. |
| `pair_live_mode` | Turn bounded live polling on/off (§4.3). |
| `pair_summarize` | Write a Narrative Summary (this Claude generates it). |
| `pair_handoff` / `pair_resume` | Write / load the handoff and re-establish context. |

---

## 15. Threat model

### 15.1 Protected against
- **Malicious/compromised relay or operator:** sees only `roomId`, ciphertext, sizes, timing,
  presence. Can't read (AEAD), can't forge (Ed25519 sigs), can't silently tamper (hash-DAG + sigs).
  Drop/reorder/withhold is **detectable** (missing parents / seq gaps).
- **Network eavesdroppers:** WSS + E2E AEAD.
- **Invite-channel MITM:** SAS verification (§10).
- **Impersonation between peers:** per-message Ed25519 sigs, pinned identity.
- **Accidental secret leakage:** outbound scan (§9.4).
- **Side effects from shared code:** inert quarantine + two-gate apply + least-privilege Companion
  (§9.2).

### 15.2 NOT protected against (v1, documented)
Metadata privacy (room id, sizes, timing, presence); compromised endpoints; forward secrecy (static
key — rotate rooms; ratchet later); a *malicious peer* (Pairwave protects the channel + your machine
via the gates, not against a friend who lies); relay DoS.

### 15.3 Crypto choices
AEAD XChaCha20-Poly1305; KDF Argon2id; signatures Ed25519; hashing BLAKE2b; SAS from BLAKE2b over both
pubkeys + room salt, rendered as a word list.

---

## 16. Open questions (remaining after 0.2)
1. **Notifications transport:** OS toast library vs. rely on the UI badge + a CLI line for v1?
   (Leaning: UI badge + optional toast; avoid a heavy native dep.)
2. **Skill packaging:** standalone skill + MCP server, or a single Claude Code *plugin* bundling both?
3. **Relay reference deploy:** which free host do we document first (Fly / Render / a tunnel-only path)?

Resolved in 0.2 and no longer open: execution/wake-up model (§4), who applies code (§9.2), summary
realism (§9.3), UI topology (§3.3), peer verification + key persistence (§10), concurrent ordering
(§5.4), history retention (§13.3), enforcement split (§8).

See `docs/ROADMAP.md` for the phased plan.
