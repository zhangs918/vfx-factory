#!/usr/bin/env python3
"""Copy Unity Quarks exporter Editor scripts into a Unity project Assets folder."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "tools/unity-quarks-exporter/Editor"


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/setup_quarks_exporter.py /path/to/UnityProject")
        print("Copies Editor scripts → Assets/QuarksExporter/Editor/")
        return 1

    unity = Path(sys.argv[1]).expanduser().resolve()
    assets = unity / "Assets"
    if not assets.is_dir():
        print(f"ERROR: not a Unity project (missing Assets/): {unity}")
        return 1

    if not SRC.is_dir():
        print(f"ERROR: exporter missing: {SRC}")
        return 1

    dest = assets / "QuarksExporter" / "Editor"
    dest.mkdir(parents=True, exist_ok=True)
    for f in SRC.iterdir():
        if f.is_file():
            target = dest / f.name
            # Do not preserve an older timestamp from the disposable project's seeded
            # Library. Unity's incremental compiler keys script imports by timestamp;
            # preserving it can silently run yesterday's exporter assembly.
            shutil.copyfile(f, target)
            target.touch()
            print("copied", f.name)

    print(f"\nOK → {dest}")
    print("Open Unity, wait for compile, then: Tools → Quarks → Export Selected Effect to JSON")
    print("Save JSON to: public/assets/quarks/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
