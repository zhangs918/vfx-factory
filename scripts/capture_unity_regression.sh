#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNITY_PROJECT="$ROOT/.unity-batch"
UNITY_BIN="${UNITY_BIN:-/Applications/Unity/Hub/Editor/6000.5.6f1-arm64/Unity.app/Contents/MacOS/Unity}"

"$ROOT/scripts/prepare_unity_batch_project.sh" >/dev/null
python3 "$ROOT/scripts/setup_quarks_exporter.py" "$UNITY_PROJECT"

UNITY_BURST_DISABLE_COMPILATION=1 "$UNITY_BIN" \
  --burst-disable-compilation \
  -batchmode -nographics -quit \
  -projectPath "$UNITY_PROJECT" \
  -executeMethod BabylonQuarks.UnityExporter.RegressionCapture.BatchCaptureFreeSlashRegressionStates \
  -logFile "$UNITY_PROJECT/Logs/regression-capture.log"
