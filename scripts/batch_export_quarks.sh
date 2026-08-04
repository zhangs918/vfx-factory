#!/usr/bin/env bash
# Batch-export VFX Prefabs → public/assets/quarks/
# Usage:
#   npm run export:quarks              # Free Slash (default)
#   npm run export:quarks -- cfxr      # CFXR
#   npm run export:quarks -- slash     # Free Slash
#   npm run export:quarks:all-assets  # every imported Unity package
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNITY_PROJECT="$ROOT/.unity-batch"
OUT="$ROOT/public/assets/quarks"
TARGET="${1:-slash}"

UNITY_BIN="${UNITY_BIN:-/Applications/Unity/Hub/Editor/6000.5.6f1-arm64/Unity.app/Contents/MacOS/Unity}"
if [[ ! -x "$UNITY_BIN" ]]; then
  echo "ERROR: Unity not found at $UNITY_BIN (set UNITY_BIN=...)"
  exit 1
fi

METHOD=""
case "$TARGET" in
  all-assets|all|everything)
    # The disposable project mirrors unity-ref/Assets, including newly imported
    # marketplace packages. The exporter discovers particle prefabs itself.
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportAllAssetPrefabsToWeb"
    ;;
  slash|free-slash|freeslash)
    SRC="$ROOT/downloads/Free Slash VFX"
    LINK="$UNITY_PROJECT/Assets/Free Slash VFX"
    if [[ ! -d "$SRC" ]]; then
      echo "ERROR: Free Slash missing at: $SRC"
      exit 1
    fi
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportFreeSlashToWeb"
    ;;
  impact-live)
    SRC="$ROOT/downloads/Free Slash VFX"
    LINK="$UNITY_PROJECT/Assets/Free Slash VFX"
    if [[ ! -d "$SRC" ]]; then
      echo "ERROR: Free Slash missing at: $SRC"
      exit 1
    fi
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportImpactLiveToWeb"
    ;;
  multiple-impact-live)
    SRC="$ROOT/downloads/Free Slash VFX"
    LINK="$UNITY_PROJECT/Assets/Free Slash VFX"
    if [[ ! -d "$SRC" ]]; then
      echo "ERROR: Free Slash missing at: $SRC"
      exit 1
    fi
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportMultipleImpactLiveToWeb"
    ;;
  slash-electric-live)
    SRC="$ROOT/downloads/Free Slash VFX"
    LINK="$UNITY_PROJECT/Assets/Free Slash VFX"
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportSlashElectricLiveToWeb"
    ;;
  slash-fire-live)
    SRC="$ROOT/downloads/Free Slash VFX"
    LINK="$UNITY_PROJECT/Assets/Free Slash VFX"
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportSlashFireLiveToWeb"
    ;;
  multiple-slashes-live)
    SRC="$ROOT/downloads/Free Slash VFX"
    LINK="$UNITY_PROJECT/Assets/Free Slash VFX"
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportMultipleSlashesLiveToWeb"
    ;;
  slash-water-live)
    SRC="$ROOT/downloads/Free Slash VFX"
    LINK="$UNITY_PROJECT/Assets/Free Slash VFX"
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportSlashWaterLiveToWeb"
    ;;
  projectile-fire-live|slash-projectile-fire-live)
    SRC="$ROOT/downloads/Free Slash VFX"
    LINK="$UNITY_PROJECT/Assets/Free Slash VFX"
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportProjectileFireLiveToWeb"
    ;;
  projectile-earth-live|slash-projectile-earth-live)
    SRC="$ROOT/downloads/Free Slash VFX"
    LINK="$UNITY_PROJECT/Assets/Free Slash VFX"
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportProjectileEarthLiveToWeb"
    ;;
  cfxr)
    # Unity-ref is the authoritative interactive project. The downloads mirror is
    # optional and only used when the package has not been imported into Unity yet.
    if [[ -d "$ROOT/unity-ref/Assets/JMO Assets/Cartoon FX Remaster" ]]; then
      SRC="$ROOT/unity-ref/Assets/JMO Assets/Cartoon FX Remaster"
      LINK="$UNITY_PROJECT/Assets/JMO Assets/Cartoon FX Remaster"
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfxrToWeb"
    elif [[ -d "$ROOT/downloads/JMO Assets/Cartoon FX Remaster" ]]; then
      SRC="$ROOT/downloads/JMO Assets/Cartoon FX Remaster"
      LINK="$UNITY_PROJECT/Assets/JMO Assets/Cartoon FX Remaster"
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfxrToWeb"
    elif [[ -d "$ROOT/unity-ref/Assets/JMO Assets/Cartoon FX (legacy)" ]]; then
      SRC="$ROOT/unity-ref/Assets/JMO Assets/Cartoon FX (legacy)"
      LINK="$UNITY_PROJECT/Assets/JMO Assets/Cartoon FX (legacy)"
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfxLegacyToWeb"
    else
      echo "ERROR: no Cartoon FX package found in unity-ref or downloads"
      exit 1
    fi
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    ;;
  cfx-legacy|cartoon-fx|cartoon-fx-legacy)
    SRC="$ROOT/unity-ref/Assets/JMO Assets/Cartoon FX (legacy)"
    LINK="$UNITY_PROJECT/Assets/JMO Assets/Cartoon FX (legacy)"
    if [[ ! -d "$SRC" ]]; then
      echo "ERROR: Cartoon FX legacy pack missing at: $SRC"
      exit 1
    fi
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfxLegacyToWeb"
    ;;
  cfx3-fire-explosion-live)
    SRC="$ROOT/unity-ref/Assets/JMO Assets/Cartoon FX (legacy)"
    LINK="$UNITY_PROJECT/Assets/JMO Assets/Cartoon FX (legacy)"
    if [[ ! -d "$SRC" ]]; then
      echo "ERROR: Cartoon FX legacy pack missing at: $SRC"
      exit 1
    fi
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfx3FireExplosionLiveToWeb"
    ;;
  cfx3-electric-ground-live)
    SRC="$ROOT/unity-ref/Assets/JMO Assets/Cartoon FX (legacy)"
    LINK="$UNITY_PROJECT/Assets/JMO Assets/Cartoon FX (legacy)"
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfx3ElectricGroundLiveToWeb"
    ;;
  cfx2-bats-cloud-live|cfx2-pickup-curve-batch-live|cfx2-regression-batch5-live|cfx-legacy-regression-batch4-live|cfx2-regression-batch5-state-trace|cfx2-pickup-state-trace|cfx2-big-splash-live|cfx2-ww-explosion-live|cfx2-wandering-spirits-live|cfx-magical-source-live|cfx-firework-trails-live|cfx-tornado-live|cfx3-vortex-ground-live|cfx4-fire-live|cfx3-fire-shield-live)
    SRC="$ROOT/unity-ref/Assets/JMO Assets/Cartoon FX (legacy)"
    LINK="$UNITY_PROJECT/Assets/JMO Assets/Cartoon FX (legacy)"
    mkdir -p "$(dirname "$LINK")"
    ln -sfn "$SRC" "$LINK"
    if [[ "$TARGET" == "cfx2-pickup-curve-batch-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfx2PickupCurveBatchLiveToWeb"
    elif [[ "$TARGET" == "cfx2-regression-batch5-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfx2RegressionBatch5LiveToWeb"
    elif [[ "$TARGET" == "cfx-legacy-regression-batch4-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfxLegacyRegressionBatch4LiveToWeb"
    elif [[ "$TARGET" == "cfx2-regression-batch5-state-trace" ]]; then
      METHOD="BabylonQuarks.UnityExporter.RegressionCapture.BatchCaptureCfx2RegressionBatch5States"
    elif [[ "$TARGET" == "cfx2-pickup-state-trace" ]]; then
      METHOD="BabylonQuarks.UnityExporter.RegressionCapture.BatchCaptureCfx2PickupRegressionStates"
    elif [[ "$TARGET" == "cfx2-bats-cloud-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfx2BatsCloudLiveToWeb"
    elif [[ "$TARGET" == "cfx2-big-splash-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfx2BigSplashLiveToWeb"
    elif [[ "$TARGET" == "cfx2-ww-explosion-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfx2WwExplosionLiveToWeb"
    elif [[ "$TARGET" == "cfx2-wandering-spirits-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfx2WanderingSpiritsLiveToWeb"
    elif [[ "$TARGET" == "cfx-magical-source-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfxMagicalSourceLiveToWeb"
    elif [[ "$TARGET" == "cfx-firework-trails-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfxFireworkTrailsLiveToWeb"
    elif [[ "$TARGET" == "cfx-tornado-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfxTornadoLiveToWeb"
    elif [[ "$TARGET" == "cfx3-vortex-ground-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfx3VortexGroundLiveToWeb"
    elif [[ "$TARGET" == "cfx4-fire-live" ]]; then
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfx4FireLiveToWeb"
    else
      METHOD="BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfx3FireShieldLiveToWeb"
    fi
    ;;
  *)
    echo "Usage: $0 [all-assets|slash|impact-live|multiple-impact-live|multiple-slashes-live|slash-electric-live|slash-fire-live|slash-water-live|projectile-fire-live|projectile-earth-live|cfxr|cfx-legacy|cfx3-fire-explosion-live]"
    exit 1
    ;;
esac

"$ROOT/scripts/prepare_unity_batch_project.sh" >/dev/null
python3 "$ROOT/scripts/setup_quarks_exporter.py" "$UNITY_PROJECT"

mkdir -p "$OUT"
LOG="$UNITY_PROJECT/Logs/batch-export-quarks.log"
mkdir -p "$(dirname "$LOG")"

echo "Exporting ($TARGET) → $OUT"
UNITY_BURST_DISABLE_COMPILATION=1 "$UNITY_BIN" \
  --burst-disable-compilation \
  -batchmode -quit \
  -projectPath "$UNITY_PROJECT" \
  -executeMethod "$METHOD" \
  -logFile "$LOG"

echo "Done. Candidate manifest: $OUT/manifest.candidates.json"
ls -1 "$OUT"/*.json 2>/dev/null | wc -l | awk '{print $1 " json file(s)"}'
cat "$OUT/manifest.candidates.json"
