# Compiler / Runtime split migration

The repository is being split into two independently usable systems:

```text
Unity project → unity-vfx-compiler → vfx-artifact@1 → vfx-web-runtime → Preview App
```

## Current checkpoints

### Phase 1 — protocol freeze

- `packages/vfx-artifact-schema` defines the `vfx-artifact@1` envelope.
- `readVfxArtifact` accepts the current `unity-vfx-ir@1` as an explicit legacy
  migration path.
- The player validates every loaded effect through this boundary.
- Rejected new artifacts cannot be played.

### Phase 2 — runtime facade

- `packages/vfx-web-runtime` is the only public import surface for playback.
- The Preview App imports the facade, not `src/effects/*` directly.
- Implementation files remain in their legacy location until the facade has
  stable tests; this keeps the migration behavior-preserving.

### Phase 3 — compiler registry (next)

- Move Unity export code behind `unity-vfx-compiler`.
- Split material compilers and ParticleSystem module compilers.
- Emit the new artifact envelope while temporarily retaining the legacy JSON
  backend for comparison.

### Phase 4 — dual-link validation

- Compare legacy and new artifacts against fixed Unity oracle captures.
- Promote only artifacts whose live runtime and diagnostics qualify.
- Remove the legacy player/import path after all production effects migrate.

The protocol package must remain free of Unity, Three.js, DOM, and Quarks
dependencies. Compiler and runtime communicate only through versioned artifact
data and diagnostics.
