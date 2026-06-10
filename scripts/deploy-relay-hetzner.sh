#!/usr/bin/env bash
# Deploy the Pairwave relay on this box, fully isolated under ~/pairwave (no sudo, no system changes).
set -euo pipefail

mkdir -p ~/pairwave && cd ~/pairwave

if [ ! -d node ]; then
  wget -q https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz
  tar -xf node-v20.18.1-linux-x64.tar.xz
  rm node-v20.18.1-linux-x64.tar.xz
  mv node-v20.18.1-linux-x64 node
fi
export PATH="$HOME/pairwave/node/bin:$PATH"

if [ ! -d app ]; then
  if command -v git >/dev/null; then
    git clone -q https://github.com/goofypluto999/pairwave.git app
  else
    wget -q -O app.tgz https://codeload.github.com/goofypluto999/pairwave/tar.gz/refs/heads/main
    mkdir app && tar -xzf app.tgz -C app --strip-components=1 && rm app.tgz
  fi
else
  (cd app && git pull -q --ff-only || true)
fi

cd app
npm install --no-audit --no-fund >/dev/null 2>&1
npm run build >/dev/null 2>&1
echo BUILD_OK

# survive reboots without touching systemd
RELAY_CMD="PATH=$HOME/pairwave/node/bin:\$PATH PORT=8787 nohup $HOME/pairwave/node/bin/node $HOME/pairwave/app/packages/relay/dist/index.js >> $HOME/pairwave/relay.log 2>&1 & # pairwave-relay"
(crontab -l 2>/dev/null | grep -v pairwave-relay; echo "@reboot $RELAY_CMD") | crontab -

# (re)start now
pkill -f "packages/relay/dist/index.js" 2>/dev/null || true
sleep 1
PORT=8787 nohup node packages/relay/dist/index.js >> "$HOME/pairwave/relay.log" 2>&1 &
sleep 3
curl -s http://127.0.0.1:8787/healthz && echo " LOCAL_HEALTH_OK"
