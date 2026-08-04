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
```

See [docs/VFX_SEMANTIC_ARCHITECTURE.md](docs/VFX_SEMANTIC_ARCHITECTURE.md)
and [tools/unity-quarks-exporter/SEMANTIC_IR.md](tools/unity-quarks-exporter/SEMANTIC_IR.md)
for the semantic architecture and supported production paths.

