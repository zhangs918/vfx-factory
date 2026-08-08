/**
 * Blend-state dual-path helpers (derive/assert) for production inject.
 * Thin players import applyBakedBlendState from cfxr-blend-apply only.
 */
import {
  deriveBlendState,
  type VfxBlendMode,
  type VfxPipelineBlendState,
} from '@vfx-factory/artifact-schema';
import { resolveProfileDepthWrite, resolveProfileBlendMode, resolveProfileCutoff, resolveProfileDoubleSided } from './cfxr-material-profile';

export type { VfxPipelineBlendState };
export { applyBakedBlendState } from './cfxr-blend-apply';

export function blendStateFromProfile(profile: {
  blendMode?: VfxBlendMode;
  additive?: boolean;
  depthWrite?: boolean;
  cutoff?: number;
  doubleSided?: boolean;
  legacyMultiply?: boolean;
  legacyPremultiply?: boolean;
  legacyMultiplyColored?: boolean;
}): VfxPipelineBlendState {
  return deriveBlendState({
    blendMode: resolveProfileBlendMode(profile),
    additive: profile.additive,
    depthWrite: resolveProfileDepthWrite(profile),
    cutoff: resolveProfileCutoff(profile),
    doubleSided: resolveProfileDoubleSided(profile),
    legacyMultiply: profile.legacyMultiply,
    legacyPremultiply: profile.legacyPremultiply,
    legacyMultiplyColored: profile.legacyMultiplyColored,
  });
}

export function assertSameBlendState(
  label: string,
  left: VfxPipelineBlendState,
  right: VfxPipelineBlendState,
) {
  const keys: Array<keyof VfxPipelineBlendState> = [
    'path', 'blending', 'premultipliedAlpha', 'depthWrite',
    'transparent', 'alphaTest', 'side', 'toneMapped',
  ];
  const mismatches = keys.filter((key) => left[key] !== right[key]);
  if (mismatches.length) {
    throw new Error(
      `${label} blendState dual-path divergence on ${mismatches.join(', ')}: `
      + `bridge=${JSON.stringify(right)} artifact=${JSON.stringify(left)}`,
    );
  }
}
