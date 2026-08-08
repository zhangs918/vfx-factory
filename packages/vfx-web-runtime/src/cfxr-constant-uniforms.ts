/**
 * Constant fragment uniform dual-path helpers for production inject.
 * Thin players import applyConstantUniforms from cfxr-constant-uniforms-apply.
 */
import {
  deriveConstantUniforms,
  VFX_BAKE_NON_DT_LEGACY_ALPHA_TINT_FACTOR,
  type VfxPipelineUniformValues,
} from '@vfx-factory/artifact-schema';

export type { VfxPipelineUniformValues };
export { applyConstantUniforms } from './cfxr-constant-uniforms-apply';

const EPS = 1e-6;

/** Historical bake invent for non-legacyDoubleTint materials (full-inject uses profile 0). */
export const CFXR_BAKE_NON_DT_LEGACY_ALPHA_TINT_FACTOR = VFX_BAKE_NON_DT_LEGACY_ALPHA_TINT_FACTOR;

export function constantUniformsFromProfile(profile: {
  colorMul?: [number, number, number];
  opacity?: number;
  legacyDoubleTint?: boolean;
  legacyAlphaTintFactor?: number;
  hdr?: number;
  legacyVertexColorGain?: number;
}): VfxPipelineUniformValues {
  if (!Array.isArray(profile.colorMul) || profile.colorMul.length < 3) {
    throw new Error('constantUniformsFromProfile: colorMul[3] required (no invent)');
  }
  if (typeof profile.opacity !== 'number') {
    throw new Error('constantUniformsFromProfile: opacity required (no invent)');
  }
  if (typeof profile.legacyVertexColorGain !== 'number') {
    throw new Error('constantUniformsFromProfile: legacyVertexColorGain required (no invent)');
  }
  // Bake historical invent: non-DT always CFXR_BAKE_NON_DT_LEGACY_ALPHA_TINT_FACTOR.
  // Full-inject uses profile LAT (0 when off).
  let legacyAlphaTintFactor: number;
  if (profile.legacyDoubleTint) {
    if (typeof profile.legacyAlphaTintFactor !== 'number') {
      throw new Error(
        'constantUniformsFromProfile: legacyDoubleTint requires legacyAlphaTintFactor (no invent)',
      );
    }
    legacyAlphaTintFactor = profile.legacyAlphaTintFactor;
  } else {
    legacyAlphaTintFactor = CFXR_BAKE_NON_DT_LEGACY_ALPHA_TINT_FACTOR;
  }
  if (typeof profile.hdr !== 'number') {
    throw new Error('constantUniformsFromProfile: hdr required (no invent)');
  }
  const hdr = profile.hdr;
  const vertColorGain = profile.legacyVertexColorGain;
  return deriveConstantUniforms({
    materialColor: [profile.colorMul[0], profile.colorMul[1], profile.colorMul[2]],
    opacityGain: profile.opacity,
    legacyAlphaTintFactor,
    ...(hdr > 0 ? { hdrMultiply: hdr } : {}),
    vertColorGain,
  });
}

export function assertSameConstantUniforms(
  label: string,
  left: VfxPipelineUniformValues,
  right: VfxPipelineUniformValues,
) {
  const mismatches: string[] = [];
  if (left.opacityGain !== undefined && right.opacityGain !== undefined
    && Math.abs(left.opacityGain - right.opacityGain) > EPS) {
    mismatches.push(`opacityGain bake=${left.opacityGain} bridge=${right.opacityGain}`);
  }
  if (left.legacyAlphaTintFactor !== undefined && right.legacyAlphaTintFactor !== undefined
    && Math.abs(left.legacyAlphaTintFactor - right.legacyAlphaTintFactor) > EPS) {
    mismatches.push(
      `legacyAlphaTintFactor bake=${left.legacyAlphaTintFactor} bridge=${right.legacyAlphaTintFactor}`,
    );
  }
  if (left.materialColor && right.materialColor) {
    for (let i = 0; i < 3; i++) {
      if (Math.abs(left.materialColor[i] - right.materialColor[i]) > EPS) {
        mismatches.push(
          `materialColor bake=${left.materialColor.join(',')} bridge=${right.materialColor.join(',')}`,
        );
        break;
      }
    }
  }
  if (left.hdrMultiply !== undefined && right.hdrMultiply !== undefined
    && Math.abs(left.hdrMultiply - right.hdrMultiply) > EPS) {
    mismatches.push(`hdrMultiply bake=${left.hdrMultiply} bridge=${right.hdrMultiply}`);
  }
  if (left.vertColorGain !== undefined && right.vertColorGain !== undefined
    && Math.abs(left.vertColorGain - right.vertColorGain) > EPS) {
    mismatches.push(`vertColorGain bake=${left.vertColorGain} bridge=${right.vertColorGain}`);
  }
  if (mismatches.length) {
    throw new Error(`${label} constant-uniform dual-path divergence: ${mismatches.join('; ')}`);
  }
}
