# `@vfx-factory/web-runtime`

Public playback API for compiled VFX artifacts. It owns simulation, material
program execution, renderer backends, clocks, scene services, and snapshots.

The implementation now lives inside this package. The Preview App imports only
the facade from `src/index.ts`; it must not depend on the runtime's internal
modules. Host applications provide optional physics through
`QuarksEffectPlayerOptions` rather than changing a global resolver at import
time.
