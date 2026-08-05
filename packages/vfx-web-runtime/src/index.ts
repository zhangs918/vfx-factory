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

export {
  type CfxrMaterialProps,
  type CfxrRuntimeProfile,
} from './cfxrQuarksFidelity';
