# Runtime v3 migration status

The repository has an offline artifact boundary:

```text
Unity export → lowering/material IR → vfx-runtime-artifact@3
           → manifest + simulation + pipeline + GLSL + hashed resources
```

## Two preview paths only

| URL | Path | Reads |
|---|---|---|
| `/?frozen=1` (default production) | **New:** `V3ArtifactPlayer` → `ThinArtifactBackend` → `ArtifactQuarksPlayer` | `v3-artifacts` + `v3-code` + `v3-resources` |
| `/?frozen=1&compare=legacy` | **Old:** `QuarksEffectPlayer` on source JSON | `frozen-quarks` (or live `quarks/` if frozen omitted) |

There is no transitional “v3 shell + QuarksEffectPlayer” path. `?thinPlayer=1` is a deprecated no-op alias for the default thin path. `?v3=1` is ignored.

Status bar tags: `runtime=v3-thin` (new) or `runtime=legacy` / `runtime=legacy-frozen` (old).

## What `frozen` means

`frozen` is a **corpus directory switch**, not an architecture switch.

| Param | Source JSON root | Typical use |
|---|---|---|
| no `frozen` / frozen off | `/assets/quarks` | live Unity exports (small working set) |
| `frozen=1` | `/assets/frozen-quarks` | pinned snapshot used for regression and as the compile input for v3 |

v3 on-disk outputs (`v3-artifacts`, `v3-code`, `v3-resources`) are compiled from **frozen-quarks**. The thin path therefore always locks the frozen catalog so ids line up with the artifact manifest.

## Qualification

Production lists only thin-ready, qualified effects. `?candidate=1` or `?all=1` is required to inspect candidate/failed artifacts. Qualification is cumulative and requires a fixed seed, camera, viewport, post-processing mode, and capture times. Promotion consumes the machine-written regression report; a CLI ID alone cannot qualify an artifact. Thin qualification requires at least two distinct capture times.

```bash
npm run regression:runtime-v3 -- <effect-id> [...]
npm run promote:runtime-v3 -- <effect-id> [...]
```

Evidence loop (legacy oracle vs thin default; dual capture times):

```bash
VFX_CAPTURE_TIMES=0.25,0.5 \
npm run regression:runtime-v3:batch
```

`VFX_BATCH_SIZE`, `VFX_MAX_BATCHES`, and `VFX_LOOP_INTERVAL_MS` tune the loop;
the default interval is 60000 ms. Browser/network/harness failures remain
candidates and never become pixel failures. Set `VFX_THIN_PLAYER=0` only for
emergency opt-out of thin selection in batch tooling (preview itself stays thin).

## Artifact layout

The v3 artifact no longer carries the legacy `compatibility` payload. It contains
`simulation`, mandatory deterministic `metadata`, compiled `runtimeState`, pipelines and shader modules. Textures/geometries are
extracted to `public/assets/v3-resources/` using content hashes and are loaded through an
effect-scoped cache; geometry is hydrated only when a geometry binding is referenced.
`V3ArtifactPlayer` exposes only an `ArtifactRuntimeSink` seam. Preview injects
`ThinArtifactBackend` only. `QuarksArtifactBackend` remains in the package as a
deprecated tooling adapter and is not wired by the preview app.

The loader emits a `PreparedV3Effect` containing hydrated config, verified shader
sources, pipelines, resource bindings, and an independent geometry-data map.
Thin playback refuses global `cfxrState` and requires `artifact-shader@1` pipelines
plus offline emitter-sim bags.

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

Thin still uses three.quarks for particle simulation/batching; what was removed from
the production preview path is the CFXR semantic-bridge / inject player adapter.

## Stage-1 resource ABI

Large compiler-owned particle tables are no longer required to live inline in the
effect config. `unityInitialState` and `unityTrajectoryCache`, together with any
large `cfxrState` emitter table, are emitted as content-addressed JSON resources and
referenced by `*ResourceId` fields. `V3ArtifactPlayer` hydrates these references
before handing the Quarks-ready simulation to the backend and verifies their hashes.
This is an ABI boundary, not a compression pass: the online side only follows an
explicit resource binding and does not infer what the table means.
