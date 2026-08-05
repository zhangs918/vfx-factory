/** Public playback boundary. Preview and host applications import only this facade. */
export {
  QuarksEffectPlayer,
  loadQuarksManifest,
  type QuarksManifestEntry,
  type QuarksManifest,
  type VfxArtifactSource,
  type PlayerState,
  type ParticleStateSnapshot,
  type PhysicsResolver,
  type QuarksEffectPlayerOptions,
} from './QuarksEffectPlayer';

export { type VfxSemanticContract } from './artifact-contract';

export {
  type CfxrMaterialProps,
  type CfxrRuntimeProfile,
} from './cfxrQuarksFidelity';
