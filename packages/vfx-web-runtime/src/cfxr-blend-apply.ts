/**
 * Thin-safe blend applicator. Dual-path derive/assert stays in cfxr-blend-state.
 */
import {
  AdditiveBlending,
  AddEquation,
  CustomBlending,
  DoubleSide,
  DstColorFactor,
  FrontSide,
  NoBlending,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcColorFactor,
  ZeroFactor,
  type Material,
} from 'three';
import {
  VFX_TONE_MAPPED_OFF,
  type VfxPipelineBlendState,
} from '@vfx-factory/artifact-schema';

export type { VfxPipelineBlendState };

/** Ubershader / Quarks stock / bake stamp: never tone-map CFXR materials. */
export const CFXR_TONE_MAPPED_OFF = VFX_TONE_MAPPED_OFF;

/** Install the offline/bridge-equivalent blend recipe onto a Three material. */
export function applyBakedBlendState(mat: Material, state: VfxPipelineBlendState) {
  if (!state || typeof state !== 'object') {
    throw new Error('applyBakedBlendState: blendState required (no invent)');
  }
  const paths = new Set([
    'legacy-multiply',
    'legacy-premultiply',
    'legacy-multiply-colored',
    'semantic',
  ]);
  if (!paths.has(state.path)) {
    throw new Error(`applyBakedBlendState: unsupported path '${String(state.path)}' (no invent)`);
  }
  if (typeof state.premultipliedAlpha !== 'boolean'
    || typeof state.depthWrite !== 'boolean'
    || typeof state.transparent !== 'boolean'
    || typeof state.alphaTest !== 'number'
    || !Number.isFinite(state.alphaTest)
    || (state.side !== 'front' && state.side !== 'double')
    || state.toneMapped !== CFXR_TONE_MAPPED_OFF) {
    throw new Error('applyBakedBlendState: incomplete blendState fields (no invent)');
  }
  if (state.path === 'legacy-multiply') {
    mat.blending = CustomBlending;
    mat.blendEquation = AddEquation;
    mat.blendSrc = ZeroFactor;
    mat.blendDst = SrcColorFactor;
    mat.blendEquationAlpha = AddEquation;
    mat.blendSrcAlpha = ZeroFactor;
    mat.blendDstAlpha = OneFactor;
    mat.premultipliedAlpha = false;
  } else if (state.path === 'legacy-premultiply') {
    mat.blending = CustomBlending;
    mat.blendEquation = AddEquation;
    mat.blendSrc = OneFactor;
    mat.blendDst = OneMinusSrcAlphaFactor;
    mat.blendEquationAlpha = AddEquation;
    mat.blendSrcAlpha = ZeroFactor;
    mat.blendDstAlpha = OneFactor;
    mat.premultipliedAlpha = false;
  } else if (state.path === 'legacy-multiply-colored') {
    mat.blending = CustomBlending;
    mat.blendEquation = AddEquation;
    mat.blendSrc = DstColorFactor;
    mat.blendDst = ZeroFactor;
    mat.blendEquationAlpha = AddEquation;
    mat.blendSrcAlpha = ZeroFactor;
    mat.blendDstAlpha = OneFactor;
    mat.premultipliedAlpha = false;
  } else if (state.blending === 'no') {
    mat.blending = NoBlending;
    mat.premultipliedAlpha = false;
  } else if (state.blending === 'additive') {
    mat.blending = AdditiveBlending;
    mat.premultipliedAlpha = false;
  } else if (state.blending === 'normal') {
    mat.blending = NormalBlending;
    mat.premultipliedAlpha = state.premultipliedAlpha;
  } else {
    throw new Error(`applyBakedBlendState: unsupported blending '${String(state.blending)}' (no invent)`);
  }
  mat.depthWrite = state.depthWrite;
  mat.transparent = state.transparent;
  mat.alphaTest = state.alphaTest;
  mat.toneMapped = state.toneMapped;
  mat.side = state.side === 'double' ? DoubleSide : FrontSide;
}
