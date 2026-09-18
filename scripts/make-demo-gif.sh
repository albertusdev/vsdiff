#!/usr/bin/env bash
# Regenerate docs/media: screenshots + demo.gif, recorded by the harness.
# Requires the serve-web harness running (node scripts/web.mjs start) + ffmpeg.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/packages/e2e"
rm -rf test-results/media-*
VSDIFF_MEDIA=1 npx playwright test tests/media.spec.ts
VIDEO=$(find test-results -name "*.webm" | head -1)
[ -n "$VIDEO" ] || { echo "no video captured" >&2; exit 1; }
PALETTE=$(mktemp --suffix=.png)
ffmpeg -y -loglevel error -ss 5 -t 24 -i "$VIDEO" -vf "crop=1140:874:0:26,fps=5,scale=900:-1:flags=lanczos,palettegen" "$PALETTE"
ffmpeg -y -loglevel error -ss 5 -t 24 -i "$VIDEO" -i "$PALETTE" \
  -filter_complex "crop=1140:874:0:26,fps=5,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse" \
  "$ROOT/docs/media/demo.gif"
rm -f "$PALETTE"
echo "wrote docs/media/demo.gif ($(du -h "$ROOT/docs/media/demo.gif" | cut -f1))"
