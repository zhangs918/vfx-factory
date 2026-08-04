#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/unity-ref"
TARGET="$ROOT/.unity-batch"

if [[ ! -d "$SOURCE/Assets" || ! -d "$SOURCE/ProjectSettings" || ! -d "$SOURCE/Packages" ]]; then
  echo "ERROR: source Unity project is incomplete: $SOURCE"
  exit 1
fi

# Dedicated, disposable Unity project. Only this exact target is synchronized/deleted;
# its Library is intentionally retained between runs for fast incremental imports.
mkdir -p "$TARGET/Assets" "$TARGET/ProjectSettings" "$TARGET/Packages"

# Seed the disposable project's AssetDatabase from the proven interactive import once.
# Several marketplace packs arrive through external links; a cold -nographics import can
# list their files yet leave PrefabImporter assets unresolved. APFS clone-copy is fast and
# keeps the two Library directories independent after this point.
if [[ ! -f "$TARGET/.library-seeded" && -d "$SOURCE/Library" ]]; then
  STALE_LIBRARY="$TARGET/Library.stale"
  if [[ -e "$STALE_LIBRARY" ]]; then
    echo "ERROR: unexpected stale batch Library target: $STALE_LIBRARY"
    exit 1
  fi
  if [[ -d "$TARGET/Library" ]]; then mv "$TARGET/Library" "$STALE_LIBRARY"; fi
  cp -cR "$SOURCE/Library" "$TARGET/Library"
  rm -f "$TARGET/Library/EditorInstance.json"
  if [[ -d "$STALE_LIBRARY" ]]; then rm -rf "$STALE_LIBRARY"; fi
  touch "$TARGET/.library-seeded"
fi
# Fresh Unity projects do not reliably index external directory symlinks. Copy the
# project-owned Assets first, then materialize each available downloaded pack.
rsync -a --delete --exclude 'Free Slash VFX' --exclude 'JMO Assets' "$SOURCE/Assets/" "$TARGET/Assets/"
if [[ -d "$ROOT/downloads/Free Slash VFX" ]]; then
  mkdir -p "$TARGET/Assets/Free Slash VFX"
  rsync -a --delete "$ROOT/downloads/Free Slash VFX/" "$TARGET/Assets/Free Slash VFX/"
fi
if [[ -d "$ROOT/downloads/JMO Assets/Cartoon FX Remaster" ]]; then
  mkdir -p "$TARGET/Assets/JMO Assets/Cartoon FX Remaster"
  rsync -a --delete "$ROOT/downloads/JMO Assets/Cartoon FX Remaster/" "$TARGET/Assets/JMO Assets/Cartoon FX Remaster/"
elif [[ -d "$SOURCE/Assets/JMO Assets/Cartoon FX Remaster" ]]; then
  mkdir -p "$TARGET/Assets/JMO Assets/Cartoon FX Remaster"
  rsync -a --delete "$SOURCE/Assets/JMO Assets/Cartoon FX Remaster/" "$TARGET/Assets/JMO Assets/Cartoon FX Remaster/"
fi
if [[ -d "$SOURCE/Assets/JMO Assets/Cartoon FX (legacy)" ]]; then
  mkdir -p "$TARGET/Assets/JMO Assets/Cartoon FX (legacy)"
  rsync -a --delete "$SOURCE/Assets/JMO Assets/Cartoon FX (legacy)/" "$TARGET/Assets/JMO Assets/Cartoon FX (legacy)/"
fi
rsync -a --delete "$SOURCE/ProjectSettings/" "$TARGET/ProjectSettings/"
rsync -a --delete "$SOURCE/Packages/" "$TARGET/Packages/"

printf '%s\n' "$TARGET"
