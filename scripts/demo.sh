#!/usr/bin/env bash
# Start a throwaway demo library: a fresh database in a new temp folder, filled with the
# 24 synthetic saves in docs/demo/demo-saves.json. It runs from that folder, so no .env
# (and no Reddit/Karakeep credentials) is loaded, and it never opens data/app.db.
# Walkthrough and safety checklist: docs/DEMO.md.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
port="${DEMO_PORT:-8791}"
dir="$(mktemp -d -t content-hoarder-demo.XXXXXX)"

cd "$dir"
export CONTENT_HOARDER_DB="$dir/app.db"
export CONTENT_HOARDER_OFFLINE=1

bun run "$repo/src/cli.ts" init-db
bun run "$repo/src/cli.ts" import "$repo/docs/demo/demo-saves.json"
echo "Demo library: $dir (delete it when you are done)"
exec bun run "$repo/src/cli.ts" serve --host 127.0.0.1 --port "$port"
