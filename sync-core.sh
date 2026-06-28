#!/usr/bin/env bash
# sync-core.sh · copy the shared bot "brain" from the canonical LINE repo (webhook-kohtalu)
# into fb-chat-service/core/. webhook-kohtalu = SOURCE OF TRUTH for the brain.
# Do NOT hand-edit core/* — edit in webhook-kohtalu then re-run:  bash sync-core.sh
set -euo pipefail
SRC="${1:-../webhook-kohtalu}"
DST="$(cd "$(dirname "$0")" && pwd)/core"
FILES=(ai-reply.js availability-checker.js availability-orchestrator.js customer-history.js
  image-lint.js image-map.js knowledge-base.js lead-profile.js pricing-loader.js
  room-resolver.js stay-date.js test-mode.js)
mkdir -p "$DST"
for f in "${FILES[@]}"; do cp "$SRC/$f" "$DST/$f"; echo "  synced $f"; done
# image-map.js scans public/images via fs.readdirSync to build its URL maps. The image BYTES are
# served by webhook's BASE_URL, so the core only needs the FILENAME LISTING — mirror the structure
# as 0-byte stub files (KB, not the 690MB of real photos). Re-generated on every sync.
SRC_IMG="$SRC/public/images"; DST_IMG="$DST/public/images"
if [ -d "$SRC_IMG" ]; then
  rm -rf "$DST_IMG"
  ( cd "$SRC_IMG" && find . -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) -print0 \
    | while IFS= read -r -d '' f; do mkdir -p "$DST_IMG/$(dirname "$f")"; : > "$DST_IMG/$f"; done )
  echo "  mirrored image listing → core/public/images ($(find "$DST_IMG" -type f | wc -l | tr -d ' ') stubs)"
fi
echo "Done ($(date '+%Y-%m-%d %H:%M')) from $SRC"
