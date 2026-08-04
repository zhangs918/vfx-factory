# `@vfx-factory/unity-vfx-compiler`

Compiler boundary for Unity ParticleSystem, materials, Shader Graphs, meshes,
controllers, and regression oracles. The current Unity implementation remains
under `tools/unity-quarks-exporter/Editor` while its pipeline is migrated into
the package in stages.

Its only playback-facing dependency is `@vfx-factory/artifact-schema`; it must
never depend on Three.js, the browser, or Preview App code.
