#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
port="${DEMO_PORT:-8791}"
extra=""
media="$repo/docs/demo/media"
dir="$(mktemp -d -t content-hoarder-demo.XXXXXX)"

if [ -n "${1:-}" ]; then extra="$(realpath "$1")"; fi

if [ ! -f "$media/reddit-image-01.jpg" ]; then
  echo "Demo media is missing. Run: bun run \"$repo/scripts/demo-media.ts\"" >&2
  exit 1
fi

cd "$dir"
export CONTENT_HOARDER_DB="$dir/app.db"
export CONTENT_HOARDER_OFFLINE=1

bun run "$repo/src/cli.ts" init-db
bun run "$repo/src/cli.ts" import "$repo/docs/demo/demo-saves.json"
bun run "$repo/src/cli.ts" import "$repo/docs/demo/youtube-watch-later.json"
bun run "$repo/src/cli.ts" import "$repo/docs/demo/hackernews-favorites.html"
bun run "$repo/src/cli.ts" import "$repo/docs/demo/bookmarks.html"
bun run "$repo/src/cli.ts" import "$repo/docs/demo/keep"

if [ -n "$extra" ]; then bun run "$repo/src/cli.ts" import "$extra"; fi

media_log="$dir/media.log"

bun run "$repo/scripts/demo-media.ts" --serve >"$media_log" 2>&1 &
media_pid=$!
trap 'kill "${app_pid:-}" "$media_pid" 2>/dev/null || true' EXIT INT TERM

media_ready=0
for _ in {1..100}; do
  if ! kill -0 "$media_pid" 2>/dev/null; then break; fi
  if bun -e 'const r = await fetch("http://127.0.0.1:8790/reddit-image-01.jpg"); process.exit(r.ok && (r.headers.get("content-type") ?? "").startsWith("image/jpeg") ? 0 : 1)' 2>/dev/null; then
    media_ready=1
    break
  fi
  sleep 0.1
done

if [ "$media_ready" -ne 1 ]; then
  echo "Demo media server did not start on http://127.0.0.1:8790/ (is the port in use?)." >&2
  if [ -s "$media_log" ]; then cat "$media_log" >&2; fi
  kill "$media_pid" 2>/dev/null || true
  exit 1
fi

bun run "$repo/src/cli.ts" serve --host 127.0.0.1 --port "$port" &
app_pid=$!

echo "Demo library: $dir (delete it when you are done)"
echo "Demo media:   http://127.0.0.1:8790/ (from docs/demo/media)"
echo "App:          http://127.0.0.1:$port/"

while kill -0 "$app_pid" 2>/dev/null && kill -0 "$media_pid" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$media_pid" 2>/dev/null; then
  echo "Demo media server stopped. Stopping the demo." >&2
  if [ -s "$media_log" ]; then cat "$media_log" >&2; fi
  kill "$app_pid" 2>/dev/null || true
  exit 1
fi

wait "$app_pid"
