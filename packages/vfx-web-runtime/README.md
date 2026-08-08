# `@vfx-factory/web-runtime`

Public playback API for compiled VFX artifacts. It owns simulation, material
program execution, renderer backends, clocks, scene services, and snapshots.

The implementation now lives inside this package. The Preview App imports only
the declared package facades: `artifact-runtime`, `legacy-runtime`, and
`manifest`; it does not depend on internal source paths. Host applications provide optional physics through
`QuarksEffectPlayerOptions` rather than changing a global resolver at import
time.

`artifact-runtime` is the production boundary. `legacy-runtime` is a separate,
lazy diagnostic chunk, while the thin player import graph is checked to exclude
the semantic bridge and global CFXR state services.

The runtime's semantic adapter registry is packaged under `src/semantic-adapters.ts`;
consumers do not need the Preview App's `config/` directory.
