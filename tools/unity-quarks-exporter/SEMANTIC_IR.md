# Unity VFX semantic export contract

The exporter is a strict, bounded compiler. It does not promise to reproduce every
Unity Particle System or Shader Graph. It promises that every emitted effect uses
only semantics implemented by the Web runtime.

## Pipeline

1. Validate the complete particle hierarchy and every renderer material.
2. Reject unsupported or lossy constructs with stable, machine-readable diagnostic codes.
3. Lower accepted particle systems to the Quarks target representation.
4. Compile accepted materials to explicit `particle-material-program@2` operations.
5. Attach a `unity-vfx-ir@1` contract containing seed, fixed step, camera, and capture times.
6. Revalidate before writing. A rejected export deletes its stale effect JSON.

The legacy `cfxr` material object may remain in exported JSON as source metadata, but
the runtime only executes `vfxProgram`. It does not infer shader behavior from pixels,
property names, texture contents, HDR magnitude, or emitter names.

Graph edges retain their output slot and vector component. Dynamic alpha clipping is
emitted with an explicit component-qualified semantic such as `custom1.y`; a computed
threshold that cannot be reduced to the supported expression subset rejects live export.
TextureImporter behavior is part of the program too: `FromGrayScale` alpha is lowered to
an explicit scalar coverage channel because embedding the source image does not preserve
Unity's imported GPU alpha.

## Failure policy

Unsupported semantics are errors, not approximations. Batch export writes
`<effect>.json.diagnostics.json`, then invokes the `camera-baked@1` backend. The baked
program stores Unity-rendered RGBA frames plus the fixed reference camera and its explicit
view-dependent limitation. Only an effect for which both live compilation and baking fail
is rejected, and no stale JSON is left behind in that case.

Examples include Two Curves, unsupported Shader Graph nodes, Unity Noise/Collision,
multi-channel Custom Data, 3D modules collapsed by the old converter, and unsupported
flipbook time modes.

## Deterministic regression

Unity state references:

```bash
npm run regression:unity
```

Create or deliberately replace Web golden baselines:

```bash
npm run regression:semantic:update -- --effect=semantic_fixture
```

Compare without modifying baselines:

```bash
npm run regression:semantic -- --effect=semantic_fixture
```

Each effect is captured at contract-defined, frame-aligned times using its fixed seed,
fixed delta, and reference camera. The Web suite captures `raw`, `tonemap`, and `final`
buffers, repeats every capture to detect nondeterminism, compares PNG hashes and full
particle-state JSON to golden files, and optionally reports emitter-count deltas against
Unity reference states.

The intentionally small `Semantic Fixture` is excluded from the production manifest and
exists only as the live compiler/runtime conformance fixture. Real content uses live IR
when every source semantic has an exact lowering; otherwise it is automatically rendered
by Unity as `camera-baked@1` rather than being approximated by the generic shader.
