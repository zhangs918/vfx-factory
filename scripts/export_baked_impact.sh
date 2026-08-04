#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNITY_PROJECT="$ROOT/.unity-batch"
UNITY_BIN="${UNITY_BIN:-/Applications/Unity/Hub/Editor/6000.5.6f1-arm64/Unity.app/Contents/MacOS/Unity}"
TARGET="${1:-impact}"
case "$TARGET" in
  impact) METHOD="BabylonQuarks.UnityExporter.BakedEffectExporter.BatchBakeImpactToWeb" ;;
  multiple-impact) METHOD="BabylonQuarks.UnityExporter.BakedEffectExporter.BatchBakeMultipleImpactToWeb" ;;
  *) echo "Unknown baked oracle target: $TARGET" >&2; exit 2 ;;
esac

"$ROOT/scripts/prepare_unity_batch_project.sh" >/dev/null
python3 "$ROOT/scripts/setup_quarks_exporter.py" "$UNITY_PROJECT" >/dev/null

# Rendering is required for camera-baked fallback; intentionally do not pass -nographics.
UNITY_BURST_DISABLE_COMPILATION=1 "$UNITY_BIN" --burst-disable-compilation -batchmode -quit \
  -projectPath "$UNITY_PROJECT" \
  -executeMethod "$METHOD" \
  -logFile "$UNITY_PROJECT/Logs/baked-impact.log"

if [[ "$TARGET" == "impact" ]]; then
  node "$ROOT/scripts/register_baked_impact.mjs"
fi
