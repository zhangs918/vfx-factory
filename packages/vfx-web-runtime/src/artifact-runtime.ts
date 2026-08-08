/** Production-only facade. Keep runtime2/compiler comparison code out of this chunk. */
// Thin ArtifactQuarksPlayer is the preview/production default. QuarksEffectPlayer remains
// exported for live-tweak helpers and for QuarksArtifactBackend (deprecated transitional
// adapter; preview no longer wires it — use ?compare=legacy for the old path).
export {
  QuarksEffectPlayer,
  type PlayerState,
  type PhysicsResolver,
  type QuarksEffectPlayerOptions,
  type LiveTweaks,
} from './QuarksEffectPlayer';
export { ArtifactQuarksPlayer } from './artifact-quarks-player';
export { V3ArtifactPlayer, type ArtifactRuntimeSink, type PreparedV3Effect } from './v3-artifact-player';
/** @deprecated Preview uses ThinArtifactBackend only. Kept for tooling that still stamps via bridge. */
export { QuarksArtifactBackend } from './quarks-artifact-backend';
export {
  ThinArtifactBackend,
  assertEffectMaterialThinReady,
  isEffectMaterialThinReady,
} from './thin-artifact-backend';
export {
  detectAuthoredParticleUpAxis,
  type StagePresentationMode,
  type StagePresentationOptions,
} from './stage-presentation';
