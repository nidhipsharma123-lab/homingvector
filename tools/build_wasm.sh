#!/usr/bin/env bash
# Build sim/tscore.wasm from the TurtleShield decision core AT A COMMITTED SHA, never the working
# tree: that repo is shared, and uncommitted edits from another session must not ship on this page.
# Writes sim/provenance.json naming the sha, every product file compiled with its sha256, and the
# wasm's own sha256, so the page can state exactly which product code it runs.
set -euo pipefail
SITE="$(cd "$(dirname "$0")/.." && pwd)"
PRODUCT="${PRODUCT:-$HOME/swarmos-work}"
REV="${REV:-HEAD}"
WASI="${WASI:-$(ls -d "$HOME"/hv-tools/wasi-sdk-*-linux | tail -1)}"
EIGEN="${EIGEN:-/usr/include/eigen3}"
SHA=$(git -C "$PRODUCT" rev-parse "$REV")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FILES="core/task/task.cpp core/task/score.cpp core/task/cbba.cpp core/hal/capability_profile.cpp core/hal/kinematic_envelope.cpp core/health/degradation.cpp core/health/failure_response.cpp core/health/quorum_policy.cpp core/nav/spoof_detector.cpp core/world/belief.cpp core/common/time.cpp core/common/log.cpp core/world/track_fusion.cpp"
git -C "$PRODUCT" archive "$SHA" core tests/task_fixtures.h | tar -x -C "$TMP"
SRCS=""; for f in $FILES; do [ -f "$TMP/$f" ] && SRCS="$SRCS $TMP/$f"; done
# Anything that can steer toward or act on an object is excluded BY PATH and then checked by symbol.
"$WASI/bin/clang++" --target=wasm32-wasip1 -std=c++20 -O2 -fno-exceptions -DNDEBUG -DEIGEN_NO_DEBUG \
  -DEIGEN_DONT_VECTORIZE -I"$TMP" -I"$EIGEN" -mexec-model=reactor -Wl,--strip-debug -Wl,--gc-sections \
  $SRCS "$SITE/sim/harness.cpp" -o "$SITE/sim/tscore.wasm"
if strings "$SITE/sim/tscore.wasm" | grep -qiE 'terminal_guidance|seeker|approach_geometry'; then
  echo "[build_wasm] REFUSING: guidance symbols present in tscore.wasm"; rm -f "$SITE/sim/tscore.wasm"; exit 1
fi
python3 - "$SITE" "$SHA" "$TMP" $SRCS <<'P'
import sys, json, hashlib, os
site, sha, tmp, *srcs = sys.argv[1:]
h = lambda p: hashlib.sha256(open(p,'rb').read()).hexdigest()
json.dump({"product_repo": "TurtleShield", "product_sha": sha,
           "product_files": {os.path.relpath(s, tmp): h(s) for s in srcs},
           "harness_sha256": h(f"{site}/sim/harness.cpp"),
           "wasm_sha256": h(f"{site}/sim/tscore.wasm"),
           "wasm_bytes": os.path.getsize(f"{site}/sim/tscore.wasm")},
          open(f"{site}/sim/provenance.json","w"), indent=1)
P
echo "[build_wasm] tscore.wasm $(stat -c %s "$SITE/sim/tscore.wasm") bytes from TurtleShield ${SHA:0:7}"
