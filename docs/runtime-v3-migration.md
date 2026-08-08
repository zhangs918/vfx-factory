# Runtime v3 migration status

The repository now has an offline artifact boundary:

```text
Unity export → lowering/material IR → vfx-runtime-artifact@3
           → manifest + simulation + pipeline + GLSL + hashed resources
```

The browser uses the v3 artifact path by default; `?compare=legacy` is the
explicit diagnostic oracle. Production lists only compiled, qualified effects.
`?candidate=1` or `?all=1` is required to inspect candidate/failed artifacts.
Qualification is cumulative and requires a fixed seed, camera, viewport,
post-processing mode, and capture times. Promotion consumes the machine-written
regression report; a CLI ID alone cannot qualify an artifact. Thin qualification
requires at least two distinct capture times. The single-effect commands are:

```bash
npm run regression:runtime-v3 -- <effect-id> [...]
npm run promote:runtime-v3 -- <effect-id> [...]
```

For artifact-only coverage, run the evidence loop explicitly in thin mode. It
selects only offline-stamped `capabilities.thinPlayer` entries, compares both
times exactly, validates the entire asset corpus after every batch, then waits
60 seconds before scanning the latest manifest again:

```bash
VFX_THIN_PLAYER=1 \
VFX_CAPTURE_TIMES=0.25,0.5 \
npm run regression:runtime-v3:batch
```

`VFX_BATCH_SIZE`, `VFX_MAX_BATCHES`, and `VFX_LOOP_INTERVAL_MS` tune the loop;
the default interval is 60000 ms. Browser/network/harness failures remain
candidates and never become pixel failures.

As of 2026-08-08, all 435 artifacts compile and 2,590 reachable external
resources pass integrity/closure validation. The offline capability stamp marks
45 effects as thin-capable: 43 have `thinPlayer=true` two-time exact-zero evidence
and 2 have real pixel failures. Other effects are not advertised by
`?v3=1&thinPlayer=1`; `?candidate=1` is required for diagnostic inspection.

The v3 artifact no longer carries the legacy `compatibility` payload. It contains
`simulation`, mandatory deterministic `metadata`, compiled `runtimeState`, pipelines and shader modules. Textures/geometries are
extracted to `public/assets/v3-resources/` using content hashes and are loaded through an
effect-scoped cache; geometry is hydrated only when a geometry binding is referenced.
`V3ArtifactPlayer` exposes only an `ArtifactRuntimeSink` seam, so the artifact loader no
longer depends on the concrete legacy player. The current application injects an adapter
to the three.quarks backend; this is the intentional production runtime. The old frozen/source
path is available only with `?compare=legacy` (or explicit runtime-v2 flags) for diagnostics.

The loader now emits a `PreparedV3Effect` containing hydrated config, verified shader
sources, pipelines, resource bindings, and an independent geometry-data map. Legacy conversion lives only in
`QuarksArtifactBackend`.
The stable production path is `?frozen=1&v3=1`: artifact loading followed by the
three.quarks adapter.
`QuarksArtifactBackend` passes the prepared compiled payload through
`QuarksEffectPlayer.loadCompiledArtifact`; the backend no longer constructs the
legacy `webRuntime` envelope itself.
The Quarks and thin backends both consume compiled GLSL and therefore request
hash-verified external shader modules through the runtime sink seam. A backend
that genuinely does not execute artifact GLSL may leave `needsShaders` unset.

Resource loading verifies the artifact's SHA-256 against fetched bytes. The
offline validator performs the same check for the current reachable resource
closure and rejects orphan, missing, conflicting, or unreferenced index entries.

The schema validator also verifies that every pipeline has fixed blend/depth state,
every shader contains executable vertex/fragment entry points, and every resource is a
split content-addressed URI. Invalid artifacts fail before any renderer is touched.

Generated v3 effects also have a physical code/config directory under
`public/assets/v3-code/<effect-id>/` containing `config.json` and one vertex/fragment GLSL
pair per material. Each file is hash-addressed in the artifact's `files` section and is
verified by the loader before playback. Every released artifact, including candidates,
omits embedded `simulation`, `runtimeState`, and shader source copies; its final JSON hash
is stamped in the manifest and verified before parsing. Use `npm run compile:runtime-v3:release` to reproduce this
layout through an isolated, validated staging tree and rollback-capable promotion.
The asset validator rejects any released artifact that regains those embedded fields.
Promotion only updates evidence and disposition; release owns physical stripping.
Manifest and ledger publication uses an
atomic temporary-file rename so readers never observe partial JSON.
Each external config contains only `quarksConfig` (the Quarks-ready serialized
simulation), compiled runtime state, and metadata; no renderer-specific native plan is
generated for production playback.

The mature three.quarks backend remains intentional: removing it would require
reimplementing a large Unity particle feature set and would reintroduce regressions.

## Stage-1 resource ABI

Large compiler-owned particle tables are no longer required to live inline in the
effect config. `unityInitialState` and `unityTrajectoryCache`, together with any
large `cfxrState` emitter table, are emitted as content-addressed JSON resources and
referenced by `*ResourceId` fields. `V3ArtifactPlayer` hydrates these references
before handing the Quarks-ready simulation to the backend and verifies their hashes.
This is an ABI boundary, not a compression pass: the online side only follows an
explicit resource binding and does not infer what the table means.
