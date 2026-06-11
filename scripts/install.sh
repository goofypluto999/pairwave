#!/usr/bin/env bash
# Pairwave one-line installer (macOS / Linux / WSL / git-bash)
#
#   Person A:  curl -fsSL https://raw.githubusercontent.com/goofypluto999/pairwave/main/scripts/install.sh | bash -s -- init
#   Person B:  curl -fsSL https://raw.githubusercontent.com/goofypluto999/pairwave/main/scripts/install.sh | bash -s -- join "<invite-code>"
#
# Checks git+node, clones/updates Pairwave into ~/.pairwave/app, builds, installs a global
# `pairwave` command, then wires THE FOLDER YOU RAN IT FROM and prints next steps.
set -euo pipefail

say()  { printf '  \033[36m[pairwave]\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m[pairwave]\033[0m %s\n' "$*" >&2; exit 1; }

command -v git  >/dev/null || fail "git is required — https://git-scm.com"
command -v node >/dev/null || fail "Node.js 20+ is required — https://nodejs.org"
[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge 20 ] || fail "Node 20+ required (you have $(node -v))"

REPO="${PAIRWAVE_REPO:-https://github.com/goofypluto999/pairwave.git}"
APP="${HOME}/.pairwave/app"
PROJECT_DIR="$(pwd)"

if [ -d "$APP/.git" ]; then
  say "updating Pairwave in $APP"
  # Hard-sync to upstream — survives force-pushed/rewritten history. The app clone holds no user
  # data (your room lives in your project's .pairwave/). Re-clone if unrecoverable.
  git -C "$APP" fetch --quiet origin || true
  git -C "$APP" reset --hard origin/main --quiet 2>/dev/null || {
    say "re-cloning (upstream history changed)"; rm -rf "$APP"; git clone --quiet "$REPO" "$APP"; }
else
  say "installing Pairwave into $APP"
  mkdir -p "$(dirname "$APP")"
  git clone --quiet "$REPO" "$APP"
fi

say "building (first run takes ~30s)…"
( cd "$APP" && npm install --no-audit --no-fund >/dev/null && npm run build >/dev/null )

# If this machine's policies break npm's workspace links, fall back to real copies.
if ! node -e "process.exit(require('fs').existsSync('$APP/node_modules/@pairwave/protocol/package.json')?0:1)" 2>/dev/null; then
  say "workspace links unavailable on this machine — using copies instead"
  rm -rf "$APP/node_modules/@pairwave"; mkdir -p "$APP/node_modules/@pairwave"
  for p in protocol companion relay; do cp -R "$APP/packages/$p" "$APP/node_modules/@pairwave/$p"; done
fi

CLI="$APP/packages/cli/dist/index.js"
BIN_DIR="$(npm prefix -g)/bin"
mkdir -p "$BIN_DIR"
printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$CLI" > "$BIN_DIR/pairwave"
chmod +x "$BIN_DIR/pairwave"
say "installed global command: pairwave"

cd "$PROJECT_DIR"
node "$CLI" "${@:-init}"

echo ""
say "done. Open Claude Code in this folder, approve the 'pairwave' MCP server, type /pairwave"
say "later: pairwave status | pairwave relay | pairwave join <code>"
