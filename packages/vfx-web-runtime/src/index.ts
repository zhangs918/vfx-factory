/** Public playback boundary. Preview and host applications import only this facade. */
export {
  QuarksEffectPlayer,
  type VfxArtifactSource,
  type PlayerState,
  type PhysicsResolver,
  type QuarksEffectPlayerOptions,
  type LiveTweaks,
} from './QuarksEffectPlayer';

export { loadQuarksManifest, type QuarksManifestEntry, type QuarksManifest } from './manifest';
export { V3ArtifactPlayer, type ArtifactRuntimeSink, type PreparedV3Effect } from './v3-artifact-player';
export { QuarksArtifactBackend } from './quarks-artifact-backend';
export { V3ResourceCache } from './v3-resource-cache';

export { type ParticleStateSnapshot } from './particle-snapshot';

export {
  dumpLiveMaterialCapture,
  LIVE_MATERIAL_CAPTURE_SCHEMA,
  type LiveMaterialBatchStamp,
  type LiveMaterialCapture,
} from './live-material-stamp';

export { type VfxSemanticContract } from './artifact-contract';

export { CompiledEffectPlayer, type CompiledPlayerState } from './runtime2/CompiledEffectPlayer';
export type { RuntimeBackend, RuntimeHandle } from './runtime2/RuntimeBackend';
export { createRuntimeMaterial, type RuntimeTextureResolver } from './runtime2/RuntimeMaterialFactory';
export { createRuntimeSystemState, updateRuntimeSystem, type RuntimeParticle, type RuntimeParticleSystemState } from './runtime2/RuntimeProgramExecutor';
export { ThreeRuntimeBackend, type ThreeRuntimeContext } from './runtime2/ThreeRuntimeBackend';

export {
  type CfxrMaterialProps,
  type CfxrRuntimeProfile,
} from './cfxr-material-profile';
export { expandCfxrRingGeometry } from './cfxr-ring-geometry';
