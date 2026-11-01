#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
port="${DEMO_PORT:-8791}"
saves="$(realpath "${1:-$repo/docs/demo/demo-saves.json}")"
dir="$(mktemp -d -t content-hoarder-demo.XXXXXX)"

cd "$dir"
export CONTENT_HOARDER_DB="$dir/app.db"
export CONTENT_HOARDER_OFFLINE=1

bun run "$repo/src/cli.ts" init-db
bun run "$repo/src/cli.ts" import "$saves"
echo "Demo library: $dir (delete it when you are done)"
exec bun run "$repo/src/cli.ts" serve --host 127.0.0.1 --port "$port"
