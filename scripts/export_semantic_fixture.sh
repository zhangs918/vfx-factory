#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNITY_PROJECT="$ROOT/.unity-batch"
UNITY_BIN="${UNITY_BIN:-/Applications/Unity/Hub/Editor/6000.5.6f1-arm64/Unity.app/Contents/MacOS/Unity}"

"$ROOT/scripts/prepare_unity_batch_project.sh" >/dev/null
python3 "$ROOT/scripts/setup_quarks_exporter.py" "$UNITY_PROJECT" >/dev/null

"$UNITY_BIN" -batchmode -nographics -quit \
  -projectPath "$UNITY_PROJECT" \
  -executeMethod BabylonQuarks.UnityExporter.SemanticFixture.ExportSemanticFixtureToWeb \
  -logFile "$UNITY_PROJECT/Logs/semantic-fixture.log"

node "$ROOT/scripts/register_semantic_fixture.mjs"
