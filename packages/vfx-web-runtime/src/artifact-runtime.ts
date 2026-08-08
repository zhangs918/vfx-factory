/** Production-only facade. Keep runtime2/compiler comparison code out of this chunk. */
// The semantic executor remains the v3 default until every material/behavior
// operation has been compiled into the lightweight kernel. It consumes only
// prepared artifacts here; Unity source lowering remains in legacy-runtime.
export {
  QuarksEffectPlayer,
  type PlayerState,
  type PhysicsResolver,
  type QuarksEffectPlayerOptions,
  type LiveTweaks,
} from './QuarksEffectPlayer';
export { ArtifactQuarksPlayer } from './artifact-quarks-player';
export { V3ArtifactPlayer, type ArtifactRuntimeSink, type PreparedV3Effect } from './v3-artifact-player';
export { QuarksArtifactBackend } from './quarks-artifact-backend';
export {
  ThinArtifactBackend,
  assertEffectMaterialThinReady,
  isEffectMaterialThinReady,
} from './thin-artifact-backend';
