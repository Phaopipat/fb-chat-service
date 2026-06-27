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
echo "Done ($(date '+%Y-%m-%d %H:%M')) from $SRC"
