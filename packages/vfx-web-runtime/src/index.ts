/**
 * Public playback boundary. The implementation is still physically located
 * under src/effects during the incremental migration; consumers must import
 * only this facade. The next extraction phase moves the implementation behind
 * this API without changing the Preview App.
 */
export {
  QuarksEffectPlayer,
  loadQuarksManifest,
  type QuarksManifestEntry,
  type QuarksManifest,
  type VfxSemanticContract,
  type ParticleStateSnapshot,
} from '../../../src/effects/QuarksEffectPlayer';

export {
  type CfxrMaterialProps,
  type CfxrRuntimeProfile,
} from '../../../src/effects/cfxrQuarksFidelity';
