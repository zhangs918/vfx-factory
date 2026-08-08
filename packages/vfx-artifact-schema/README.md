# `@vfx-factory/artifact-schema`

The protocol boundary between the Unity compiler and playback runtimes.

`vfx-artifact@1` is the target envelope. During migration, `readVfxArtifact`
also accepts the existing `unity-vfx-ir@1` JSON and reports it as
`kind: "legacy-unity-ir"`. No renderer or Unity dependency belongs in this
package.

The package exposes the protocol at both compile time and runtime:

- `src/index.ts` supplies TypeScript types and guards for the Vite/TS build.
- `index.mjs` supplies the dependency-free Node entrypoint used by export and
  validation scripts.
- `readVfxArtifact` / `assertVfxArtifact` validate the artifact envelope and
  explicitly support the legacy `unity-vfx-ir@1` migration format.
- `isParticleMaterialProgram` validates the explicit material semantic IR.
- `VFX_RUNTIME_ARTIFACT_V3` and `assertVfxRuntimeArtifactV3` define the final
  offline artifact boundary, including deterministic metadata, execution
  ownership, split code hashes, resource hashes, and qualification evidence.

The TypeScript and dependency-free Node implementations are checked for parity
by `npm run check:schema-runtime` and that check is part of the production build.

Compiler and player code should import `@vfx-factory/artifact-schema`; they
must not reach into `src/` through a relative path outside this workspace's
schema implementation and parity test.
