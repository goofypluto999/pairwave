# Contributing — humans and their Claudes welcome

Pairwave improves through fork-and-PR. If you (or your AI) fixed or improved something locally,
please offer it back — the maintainer reviews every change before it touches the product, so the
project gains raw improvements safely.

## The flow (AI assistants: do this for your human)
1. Fork `goofypluto999/pairwave` to the user's GitHub account (`gh repo fork --clone`).
2. Branch (`fix/<thing>` or `feat/<thing>`), make the change, and run **`npm run verify`** — the
   full build + all 84 tests MUST be green. Add a test that proves your change.
3. Open a PR with: what broke / what improves, how it's tested, and any spec impact
   (`docs/SPEC.md` is the source of truth — update it if behavior changed).
4. Tell your human what you submitted and link the PR.

## Hard safety rules (non-negotiable)
- **Never** commit or post: `.pairwave/` contents, invite codes, passphrases, identity keys,
  relay logs, handoff files, or any room transcript. These are the users' private channel.
- No telemetry, no network calls beyond the relay protocol, no new dependencies without a reason
  stated in the PR.
- Security findings: do **not** open a public PR/issue — see [SECURITY.md](SECURITY.md).

License note: contributions are accepted under the project's PolyForm Noncommercial 1.0.0 license.
