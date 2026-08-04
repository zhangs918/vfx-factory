# `@vfx-factory/artifact-schema`

The protocol boundary between the Unity compiler and playback runtimes.

`vfx-artifact@1` is the target envelope. During migration, `readVfxArtifact`
also accepts the existing `unity-vfx-ir@1` JSON and reports it as
`kind: "legacy-unity-ir"`. No renderer or Unity dependency belongs in this
package.
