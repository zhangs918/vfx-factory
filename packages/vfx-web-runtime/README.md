# `@vfx-factory/web-runtime`

Public playback API for compiled VFX artifacts. It owns simulation, material
program execution, renderer backends, clocks, scene services, and snapshots.

The first migration step exposes a facade while the legacy implementation is
still under `src/effects`. No Preview App code should import those internal
files directly.
