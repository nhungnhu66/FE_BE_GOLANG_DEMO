#!/usr/bin/env bash
# Build binary debug local (Windows/Linux host hiện tại) — có doctor --full.
set -euo pipefail
cd "$(dirname "$0")"

restore_mod() {
  if [[ -f go.mod.decoy.bak ]]; then mv -f go.mod.decoy.bak go.mod; fi
  if [[ -f go.sum.decoy.bak ]]; then mv -f go.sum.decoy.bak go.sum; fi
}
trap restore_mod EXIT

cp go.mod go.mod.decoy.bak
cp go.sum go.sum.decoy.bak 2>/dev/null || true
cp go.local.mod go.mod
cp go.local.sum go.sum

go run -mod=mod ./tools/genlit

OUT=xkdemo-debug
if [[ "$(go env GOOS)" == "windows" ]]; then
  OUT=xkdemo-debug.exe
fi

go build -mod=mod -tags "release,full" -o "$OUT" ./cmd/gateway
echo "Xong: ./$OUT doctor --full"
