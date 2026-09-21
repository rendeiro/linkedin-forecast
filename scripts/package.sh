#!/bin/sh
# Build and zip the unpacked extension: dist/ -> linkedin-forecast-<version>.zip
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run build >/dev/null
V=$(node -p "require('./package.json').version")
OUT="linkedin-forecast-$V.zip"
rm -f "$OUT"
(cd dist && zip -qr "../$OUT" .)
echo "$OUT"
