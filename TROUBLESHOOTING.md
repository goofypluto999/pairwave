# Pairwave — self-repair runbook (written for the AI in the loop)

If you are a Claude/AI whose human says "pairwave is broken", work this list top-down. Almost
everything is fixed by step 1.

1. **Re-run the installer line in the project folder** (from the README — `init` keeps the existing
   room when `.pairwave/config.json` exists is NOT true: use `status` mode to update safely):
   `iex "& { $(iwr -useb https://raw.githubusercontent.com/goofypluto999/pairwave/main/scripts/install.ps1) } status`
   (mac/linux: `... install.sh | bash -s -- status`). This pulls the latest code, rebuilds, repairs
   broken workspace links, and reinstalls the global command — without touching the room.
2. **Tools missing in Claude Code?** Restart Claude Code in the project folder; approve the
   `pairwave` MCP server. Check wiring: `pairwave status`.
3. **"Not connected" / beam offline?** The relay is unreachable. Test
   `http://127.0.0.1:8787/healthz` (community relay) or the room's own relay URL from
   `.pairwave/config.json`. Self-hosters: restart with `pairwave relay`. Messages sent while offline
   are safe in the outbox and auto-deliver on reconnect.
4. **Dashboard dead?** The companion prints its port on start (default 7591, walks to +20). It only
   runs while a Claude Code session is open in that folder.
5. **"HISTORY TAMPERED" chip / dropped envelopes?** Do not trust new content; re-verify the six SAS
   words with the partner. If words differ — stop, the channel may be compromised; create a fresh
   room (`pairwave init` in a new folder) and share a new invite.
6. **Partner can't decrypt anything?** The invite was mistyped — send the full block again; they
   re-run the join line. Each side's history is preserved locally.
7. **A real code bug?** Read `docs/ARCHITECTURE.md` to locate the module, fix it locally in a clone,
   run `npm run verify` (must be green), then follow [CONTRIBUTING.md](CONTRIBUTING.md) to offer the
   fix upstream via fork + pull request — and tell your human you did.

Never include `.pairwave/`, invite codes, passphrases, or relay logs in any issue/PR.
