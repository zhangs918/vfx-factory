# VFX Factory

Unity ParticleSystem / Shader semantics compiler and an editable WebGL runtime
built on Three.js and three.quarks.

The repository contains the compiler, runtime, Unity project skeleton, semantic
contracts, and regression tooling. It intentionally does **not** redistribute
Unity Asset Store packages, imported source assets, generated Web payloads, or
rendered comparison baselines.

## Setup

```bash
npm install
npm run dev
```

Open `unity-ref` with the Unity version recorded in
`unity-ref/ProjectSettings/ProjectVersion.txt`, then import source VFX packages
you are licensed to use into `unity-ref/Assets`.

Install/update the exporter and export assets with:

```bash
npm run setup:quarks-exporter
npm run export:quarks:all-assets
```

Generated effects are written to `public/assets/quarks` and remain local.

## Validation

```bash
npm run build
npm run validate:live-ir
npm run validate:candidate-ir
npm run smoke:candidate-runtime
npm run validate:runtime-v3-assets
```

Build and publish runtime-v3 assets with:

```bash
npm run compile:runtime-v3:release
```

The release command compiles into an isolated staging tree, verifies hashes,
resource closure, schemas, code/config splits, and dispositions, then promotes
all three generated directories with rollback. Generated corpora remain ignored
and are deployed separately from the Vite application bundle.

### Preview paths (two only)

| URL | Meaning |
|---|---|
| `/?frozen=1` | **New:** thin player reads offline `v3-*` artifacts |
| `/?frozen=1&compare=legacy` | **Old:** QuarksEffectPlayer on frozen source JSON |

`frozen=1` selects the pinned `/assets/frozen-quarks` source corpus (compile input
for v3). Omitting it uses live `/assets/quarks`. It is not an architecture switch.

Run the thin qualification loop (legacy oracle vs default thin):

```bash
VFX_CAPTURE_TIMES=0.25,0.5 \
  npm run regression:runtime-v3:batch
```

Each batch consumes machine-readable pixel evidence, validates all generated
assets, and waits 60 seconds before rescanning. Default `/?frozen=1` lists only
entries with both an offline thin capability stamp and thin-player qualification
evidence; use `?candidate=1` to inspect the rest.

See [docs/runtime-v3-migration.md](docs/runtime-v3-migration.md),
[docs/VFX_SEMANTIC_ARCHITECTURE.md](docs/VFX_SEMANTIC_ARCHITECTURE.md),
and [tools/unity-quarks-exporter/SEMANTIC_IR.md](tools/unity-quarks-exporter/SEMANTIC_IR.md)
for the semantic architecture and supported production paths.
