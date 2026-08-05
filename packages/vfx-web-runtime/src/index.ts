/** Public playback boundary. Preview and host applications import only this facade. */
export {
  QuarksEffectPlayer,
  type VfxArtifactSource,
  type PlayerState,
  type PhysicsResolver,
  type QuarksEffectPlayerOptions,
} from './QuarksEffectPlayer';

export { loadQuarksManifest, type QuarksManifestEntry, type QuarksManifest } from './manifest';

export { type ParticleStateSnapshot } from './particle-snapshot';

export { type VfxSemanticContract } from './artifact-contract';

export { CompiledEffectPlayer, type CompiledPlayerState } from './runtime2/CompiledEffectPlayer';
export type { RuntimeBackend, RuntimeHandle } from './runtime2/RuntimeBackend';
export { createRuntimeMaterial, type RuntimeTextureResolver } from './runtime2/RuntimeMaterialFactory';
export { createRuntimeSystemState, updateRuntimeSystem, type RuntimeParticle, type RuntimeParticleSystemState } from './runtime2/RuntimeProgramExecutor';
export { ThreeRuntimeBackend, type ThreeRuntimeContext } from './runtime2/ThreeRuntimeBackend';

export {
  type CfxrMaterialProps,
  type CfxrRuntimeProfile,
} from './cfxrQuarksFidelity';
