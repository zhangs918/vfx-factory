/**
 * CFXR material program props → runtime profile + semantic blend helpers.
 * Leaf module shared by simulation mounts and the inject bridge.
 */
import {
  AdditiveBlending,
  AddEquation,
  CustomBlending,
  DataTexture,
  DstColorFactor,
  NoBlending,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RGBAFormat,
  SrcColorFactor,
  ZeroFactor,
  NoColorSpace,
  type Material,
} from 'three';
import type { BlendMode } from '@vfx-factory/artifact-schema';
import {
  VFX_ALPHA_TEST_DISABLED,
  VFX_ALPHA_TEST_FLOOR,
} from '@vfx-factory/artifact-schema';

/** Host placeholder when `fading` is on but softParticle pair is absent (prefer offline stamps). */
export const CFXR_SOFT_FADE_PLACEHOLDER_STRENGTH = 0.001;
/** Soft-invent when unauthored; do not stamp pending (family fingerprint). */
export const CFXR_TEX_POWER_IDENTITY = 1;
export const CFXR_COLOR_POWER_IDENTITY = 1;
/** Soft-invent color/opacity identity for frozen/unstamped props. */
export const CFXR_COLOR_MUL_SOFT_IDENTITY: [number, number, number] = [1, 1, 1];
export const CFXR_OPACITY_SOFT_IDENTITY = 1;
/** Soft-invent doubleSided when unauthored (v3 corpus stamps). */
export const CFXR_DOUBLE_SIDED_SOFT_INVENT = true;
/** Three.js alphatest floor / off — shared with artifact-schema deriveBlendState. */
export const CFXR_ALPHA_TEST_FLOOR = VFX_ALPHA_TEST_FLOOR;
export const CFXR_ALPHA_TEST_DISABLED = VFX_ALPHA_TEST_DISABLED;
/** Soft-invent flip / hdr / cutoff / alphaClip when unauthored (v3 stamps). */
export const CFXR_FLIP_SOFT_INVENT = false;
export const CFXR_HDR_SOFT_INVENT = 0;
export const CFXR_CUTOFF_SOFT_INVENT = 0;
export const CFXR_ALPHA_CLIP_THRESHOLD_SOFT_INVENT = 0;
/** Soft-invent vertexColor* on profile only — do not stamp pending. */
export const CFXR_VERTEX_COLOR_SOFT_INVENT = true;
/**
 * Off-path LAT for full-inject profile (bake non-DT still uses
 * CFXR_BAKE_NON_DT_LEGACY_ALPHA_TINT_FACTOR=2 in constant-uniforms).
 */
export const CFXR_LEGACY_ALPHA_TINT_FACTOR_OFF_PATH = 0;
export const CFXR_LEGACY_VERTEX_COLOR_GAIN_OFF_PATH = 1;
export const CFXR_SOFT_PARTICLE_STRENGTH_OFF = 0;
/** softstep denominator floor for procedural ring bake. */
const CFXR_SMOOTHSTEP_DENOM_EPS = 1e-6;

/** Off-path mask soft invents (useMask=false) so inject never invents at bind. */
export const CFXR_MASK_SPEED_OFF: [number, number] = [0, 0];
export const CFXR_MASK_ROTATION_OFF = 0;
export const CFXR_MASK_ROTATION_CENTER_OFF: [number, number] = [0.5, 0.5];
export const CFXR_MASK_OFFSET_OFF: [number, number] = [0, 0];
export const CFXR_MASK_NOISE_SCALE_OFF = 0;
export const CFXR_DISTORTION_AMOUNT_OFF = 0;
export const CFXR_SLASH_SCREEN_OFFSET_OFF: [number, number] = [0, 0];
export const CFXR_DISSOLVE_SMOOTH_OFF = 0;
export const CFXR_DISSOLVE_SCROLL_OFF: [number, number] = [0, 0];
export const CFXR_PARALLAX_AMPLITUDE_OFF = 0;
export const CFXR_DYNAMIC_ALPHA_CLIP_SCALE_OFF = 0;

/** Off-path trail UV soft invents (non trail-front-face). */
export const CFXR_TRAIL_UV_ROTATION_OFF = 0;
export const CFXR_TRAIL_UV_STRETCH_OFF = 0;
export const CFXR_TRAIL_UV_SCROLL_OFF: [number, number] = [0, 0];
export const CFXR_TRAIL_UV_TILING_OFF: [number, number] = [1, 1];
export const CFXR_TRAIL_UV_OFFSET_OFF: [number, number] = [0, 0];
export const CFXR_TRAIL_UV_DISTORTION_POWER_OFF = 0;
export const CFXR_TRAIL_UV_DISTORTION_SPEED_OFF: [number, number] = [0, 0];

/** Off-path orb-warp soft invents (non orb-warp family). */
export const CFXR_ORB_COLOUR_OFF: [number, number, number] = [1, 1, 1];
export const CFXR_ORB_FRESNEL_COLOR_OFF: [number, number, number, number] = [1, 1, 1, 0];
export const CFXR_ORB_VEC2_OFF: [number, number] = [0, 0];
export const CFXR_ORB_SCALAR_OFF = 0;

/** Off-path ambient soft invents (non unity-urp-lit-reference). */
export const CFXR_AMBIENT_RGB_OFF: [number, number, number] = [1, 1, 1];
export const CFXR_AMBIENT_SH_BAND_OFF: [number, number, number] = [0, 0, 0];

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / Math.max(CFXR_SMOOTHSTEP_DENOM_EPS, e1 - e0)));
  return t * t * (3 - 2 * t);
}

type TextureSamplerSpec = {
  wrap?: [number, number];
  magFilter?: number;
  minFilter?: number;
};

export interface CfxrMaterialProps {
  shader?: string;
  shaderFamily?: string;
  unityMode?: number;
  srcBlend?: number;
  dstBlend?: number;
  zWrite?: boolean;
  cutoff?: number;
  blendMode?: BlendMode;
  lightingModel?: 'unity-urp-lit-reference@1';
  ambientSky?: [number, number, number];
  ambientEquator?: [number, number, number];
  ambientGround?: [number, number, number];
  ambientSH?: Array<[number, number, number]>;
  doubleSided?: boolean;
  hdrMultiply?: number;
  singleChannel?: boolean;
  coverageChannel?: 'luminance' | 'red' | 'green' | 'alpha';
  mainUvTransform?: 'identity' | 'shear-x-from-y' | 'offset-x-custom1-y' | 'offset-y-custom1-y' | 'offset-custom1-yx' | 'offset-uv1' | 'trail-front-face@2';
  trailUvRotation?: number;
  trailUvStretch?: number;
  trailUvStretchY?: boolean;
  trailUvSpeedFromCustom2?: boolean;
  trailUvScroll?: [number, number];
  trailUvTiling?: [number, number];
  trailUvOffset?: [number, number];
  trailUvDistortionPower?: number;
  trailUvDistortionSpeed?: [number, number];
  manualGraphLowering?: 'slash-screen@2' | 'slash-world@3' | 'trail-front-face@2' | 'parallax-occlusion@1' | 'orb-warp@1' | 'orb-warp-lit@1';
  dissolveScroll?: [number, number];
  slashWorldVertexAlpha?: boolean;
  frontFaceColorSelect?: boolean;
  heightMap?: string;
  heightMapUrl?: string;
  heightMapSrgb?: boolean;
  heightSampler?: TextureSamplerSpec;
  parallaxAmplitude?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** TextureImporter.sRGBTexture for the material's main map. */
  mainMapSrgb?: boolean;
  /** Static Shader Graph Alpha Clip threshold; absent when dissolve owns clipping. */
  alphaClipThreshold?: number;
  dynamicAlphaClip?: boolean;
  dynamicAlphaClipSource?: 'custom1.x' | 'custom1.y' | 'custom1.z' | 'custom1.w' | 'uv1.x' | 'uv1.y';
  dynamicAlphaClipScale?: number;
  useDissolve?: boolean;
  dissolveSmooth?: number;
  /** Unity `_InvertDissolveTex` — 0 means invert (CFXR default). */
  invertDissolve?: boolean;
  color?: [number, number, number, number];
  frontColor?: [number, number, number, number];
  backColor?: [number, number, number, number];
  /** Shader Graph wiring: whether Vertex Color feeds BaseColor / Alpha (absent = assume yes). */
  vertexColorRgb?: boolean;
  vertexColorAlpha?: boolean;
  ringTopOffset?: number;
  fading?: boolean;
  /** Corpus stamp sibling of fading (pendingCfxr); profile softFade derives from fading. */
  softFade?: boolean;
  additive?: boolean;
  /** Exact lowering of Cartoon FX legacy Particle Multiply Colored. */
  legacyMultiplyColored?: boolean;
  /** Unity built-in Legacy Shaders/Particles/Multiply. */
  legacyMultiply?: boolean;
  /** Unity built-in Legacy Shaders/Particles/Alpha Blended Premultiply. */
  legacyPremultiply?: boolean;
  /** Built-in legacy particle vertex/fragment program applies 2× tint modulation. */
  legacyDoubleTint?: boolean;
  /** Source-material-locked legacy lowering: COLOR is already a linear vertex attribute. */
  legacyVertexColorRaw?: boolean;
  legacyVertexColorGain?: number;
  /** Reviewed legacy material adapter: multiplier applied to tint-modulated source alpha. */
  legacyAlphaTintFactor?: number;
  proceduralRing?: boolean;
  useMask?: boolean;
  maskMap?: string;
  maskMapUrl?: string;
  maskMapSrgb?: boolean;
  maskSampler?: TextureSamplerSpec;
  maskChannel?: 'red' | 'alpha';
  maskWarp?: 'simple-noise-product';
  maskNoiseScale?: number;
  maskSpeed?: [number, number];
  maskRotation?: number;
  maskRotationCenter?: [number, number];
  maskOffset?: [number, number];
  useDistortion?: boolean;
  /** Shader Graph BaseColor chain samples Scene Color (screen refraction). */
  sceneColor?: boolean;
  distortionMap?: string;
  distortionMapUrl?: string;
  distortionMapSrgb?: boolean;
  distortionSampler?: TextureSamplerSpec;
  distortionAmount?: number;
  /** Slash World SceneColor screen-space offset before its exact distortion DAG. */
  slashWorldScreenOffset?: [number, number];
  /** Unity `_Opacity` — often a gain > 1, not a 0–1 alpha. */
  opacity?: number;
  texPower?: number;
  colorPower?: number;
  softParticle?: number;
  /** Adapter-declared conversion from the graph's depth-difference convention to eye units. */
  softParticleDepthScale?: number;
  orbAlphaMap?: string;
  orbAlphaMapUrl?: string;
  orbAlphaMapSrgb?: boolean;
  orbAlphaConstantOne?: boolean;
  orbAlphaSampler?: TextureSamplerSpec;
  orbNoiseMap?: string;
  orbNoiseMapUrl?: string;
  orbNoiseMapSrgb?: boolean;
  orbNoiseSampler?: TextureSamplerSpec;
  orbColour?: [number, number, number];
  orbFresnelColor?: [number, number, number, number];
  orbNoiseAnimation?: [number, number];
  orbWarpSpeed?: [number, number];
  orbFresnelPower?: number;
  orbNoiseScale?: number;
  orbNoiseFrequency?: number;
  orbNoiseAmplitude?: number;
  orbOctaveFrequencyScale?: number;
  orbOctaveAmplitudeScale?: number;
  orbOctaveDomainWarping?: number;
  orbNoisePower?: number;
  orbUvClipScale?: number;
  orbVertexAlphaChannel?: 'alpha' | 'green';
  /** Texture uuid from exporter, or legacy path hint. */
  dissolveMap?: string;
  dissolveTextureName?: string;
  /** Resolved data:/http(s) URL for dissolve map (filled when parsing export JSON). */
  dissolveMapUrl?: string;
  dissolveMapSrgb?: boolean;
  dissolveSampler?: TextureSamplerSpec;
}

/** Runtime profile attached to materials before batching. */
export interface CfxrRuntimeProfile {
  shaderFamily?: string;
  /** Pending corpus stamps blendMode — resolveProfileBlendMode rejects absence. */
  blendMode?: BlendMode;
  /** Prefer propsToProfile stamps; resolve still invents from blendMode when absent. */
  depthWrite?: boolean;
  /** Omit when unknown — consumers default 0. */
  cutoff?: number;
  lightingModel?: 'unity-urp-lit-reference@1';
  /** Omit when unknown — consumers default white / zero SH. */
  ambientSky?: [number, number, number];
  ambientEquator?: [number, number, number];
  ambientGround?: [number, number, number];
  ambientSH?: Array<[number, number, number]>;
  /** Prefer propsToProfile stamps; resolve requires boolean (no invent). */
  doubleSided?: boolean;
  /** Omit when unknown — consumers default 0. */
  hdr?: number;
  /** Omit when unknown — consumers treat as false. */
  singleChannel?: boolean;
  /** Omit when unknown — consumers treat as luminance. */
  coverageChannel?: 'luminance' | 'red' | 'green' | 'alpha';
  /** Omit when unknown — consumers treat as identity. */
  mainUvTransform?: NonNullable<CfxrMaterialProps['mainUvTransform']>;
  /** Omit when unknown — consumers default 0 / [0,0]. */
  trailUvRotation?: number;
  trailUvStretch?: number;
  trailUvStretchY?: boolean;
  trailUvSpeedFromCustom2?: boolean;
  trailUvScroll?: [number, number];
  trailUvTiling?: [number, number];
  trailUvOffset?: [number, number];
  trailUvDistortionPower?: number;
  trailUvDistortionSpeed?: [number, number];
  manualGraphLowering?: CfxrMaterialProps['manualGraphLowering'];
  frontFaceColorSelect?: boolean;
  slashWorldVertexAlpha?: boolean;
  heightMapUrl?: string;
  heightMapSrgb?: boolean;
  heightSampler?: TextureSamplerSpec;
  /** Omit when unknown — consumers default 0. */
  parallaxAmplitude?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** Offline pipeline/bag stamp — never invent [1,1] in propsToProfile. */
  tileCounts?: [number, number];
  /** Offline before-batch stamp from renderMode — omit until stamped. */
  unityCenteredStretch?: boolean;
  /** Offline before-batch stamp from renderMode — omit until stamped. */
  unityVerticalBillboard?: boolean;
  /** Offline bag / texture table — omit when unknown (do not invent true). */
  mainMapSrgb?: boolean;
  /** Omit when unknown — consumers default 0. */
  alphaClipThreshold?: number;
  /** Omit when unknown — consumers treat as false. */
  dynamicAlphaClip?: boolean;
  /** Omit when unknown — consumers treat as custom1.x. */
  dynamicAlphaClipSource?: NonNullable<CfxrMaterialProps['dynamicAlphaClipSource']>;
  /** Omit when unknown — consumers default 1. */
  dynamicAlphaClipScale?: number;
  /** Omit when unknown — consumers treat as false. */
  dissolve?: boolean;
  /** Offline before-batch stamp — omit until stamped. */
  dissolveViaUvTile?: boolean;
  /** Omit when unknown — consumers default 0.15. */
  dissolveSmooth?: number;
  dissolveScroll?: [number, number];
  /** Omit when unknown — dissolve path defaults invert on. */
  invertDissolve?: boolean;
  /** Omit when unknown — consumers default white. */
  colorMul?: [number, number, number];
  softFade?: boolean;
  /** Omit when unknown — consumers default 0.001. */
  softParticleStrength?: number;
  additive?: boolean;
  legacyMultiplyColored?: boolean;
  legacyMultiply?: boolean;
  legacyPremultiply?: boolean;
  legacyDoubleTint?: boolean;
  legacyVertexColorRaw?: boolean;
  /** Omit when unknown — consumers default 1. */
  legacyVertexColorGain?: number;
  /** Omit when unknown — consumers default 2. */
  legacyAlphaTintFactor?: number;
  proceduralRing?: boolean;
  /** Omit when unknown — consumers default 0.07. */
  ringTopOffset?: number;
  dissolveMapUrl?: string;
  vertexColorRgb?: boolean;
  vertexColorAlpha?: boolean;
  /** Trail-family graphs: rgb = lerp(backColor, frontColor, texLum). */
  backColorMul?: [number, number, number];
  useMask?: boolean;
  maskMapUrl?: string;
  maskMapSrgb?: boolean;
  maskSampler?: TextureSamplerSpec;
  /** Omit when unknown — consumers default 'red'. */
  maskChannel?: 'red' | 'alpha';
  maskWarp?: boolean;
  /** Omit when unknown — consumers default 1 / 0 / [0.5,0.5] / [0,0]. */
  maskNoiseScale?: number;
  maskSpeed?: [number, number];
  maskRotation?: number;
  maskRotationCenter?: [number, number];
  maskOffset?: [number, number];
  useDistortion?: boolean;
  sceneColor?: boolean;
  distortionMapUrl?: string;
  distortionMapSrgb?: boolean;
  dissolveMapSrgb?: boolean;
  distortionSampler?: TextureSamplerSpec;
  dissolveSampler?: TextureSamplerSpec;
  /** Omit when unknown — consumers default 0.02. */
  distortionAmount?: number;
  slashWorldScreenOffset?: [number, number];
  /** Omit when unknown — consumers default 1. */
  opacity?: number;
  /** Omit when unknown — consumers default 1. */
  texPower?: number;
  /** Omit when unknown — consumers default 1. */
  colorPower?: number;
  orbAlphaMapUrl?: string;
  orbAlphaMapSrgb?: boolean;
  /** Omit when unknown — consumers infer from loaded alpha map. */
  orbAlphaConstantOne?: boolean;
  orbAlphaSampler?: TextureSamplerSpec;
  orbNoiseMapUrl?: string;
  orbNoiseMapSrgb?: boolean;
  orbNoiseSampler?: TextureSamplerSpec;
  /** Omit when unknown — consumers default white / zero / 1 / … */
  orbColour?: [number, number, number];
  orbFresnelColor?: [number, number, number, number];
  orbNoiseAnimation?: [number, number];
  orbWarpSpeed?: [number, number];
  orbFresnelPower?: number;
  orbNoiseScale?: number;
  orbNoiseFrequency?: number;
  orbNoiseAmplitude?: number;
  orbOctaveFrequencyScale?: number;
  orbOctaveAmplitudeScale?: number;
  orbOctaveDomainWarping?: number;
  orbNoisePower?: number;
  orbUvClipScale?: number;
  orbVertexAlphaChannel?: 'alpha' | 'green';
}

/**
 * Pending profiles always carry blendMode. Do not invent 'alpha' when absent.
 */
export function resolveProfileBlendMode(profile: {
  blendMode?: BlendMode;
  additive?: boolean;
  legacyPremultiply?: boolean;
}): BlendMode {
  if (profile.blendMode) return profile.blendMode;
  throw new Error('resolveProfileBlendMode: blendMode required (no invent)');
}

export function resolveProfileDepthWrite(profile: {
  depthWrite?: boolean;
  blendMode?: BlendMode;
  additive?: boolean;
  legacyPremultiply?: boolean;
}): boolean {
  if (typeof profile.depthWrite === 'boolean') return profile.depthWrite;
  throw new Error('resolveProfileDepthWrite: depthWrite required (no invent)');
}

/**
 * Prefer propsToProfile / corpus stamps. Do not invent true when absent.
 */
export function resolveProfileDoubleSided(profile: { doubleSided?: boolean }): boolean {
  if (typeof profile.doubleSided === 'boolean') return profile.doubleSided;
  throw new Error('resolveProfileDoubleSided: doubleSided required (no invent)');
}

/**
 * Prefer propsToProfile / corpus stamps. Do not invent 0 when absent.
 */
export function resolveProfileCutoff(profile: {
  cutoff?: number;
  blendMode?: BlendMode;
  additive?: boolean;
  legacyPremultiply?: boolean;
}): number {
  if (typeof profile.cutoff === 'number') return profile.cutoff;
  throw new Error('resolveProfileCutoff: cutoff required (no invent)');
}

export function propsToProfile(props: CfxrMaterialProps): CfxrRuntimeProfile {
  const colorRaw = props.frontColor ?? props.color;
  // v3 pending stamps hdrMultiply; frozen/unstamped omit it and may still soft-invent siblings.
  const stampedPending = typeof props.hdrMultiply === 'number';
  if (stampedPending) {
    if (typeof props.blendMode !== 'string') {
      throw new Error('propsToProfile: blendMode required when hdrMultiply stamped (no invent)');
    }
    if (!(Array.isArray(colorRaw) && colorRaw.length >= 3)) {
      throw new Error('propsToProfile: color required when hdrMultiply stamped (no invent)');
    }
    if (typeof props.opacity !== 'number') {
      throw new Error('propsToProfile: opacity required when hdrMultiply stamped (no invent)');
    }
    if (typeof props.zWrite !== 'boolean') {
      throw new Error('propsToProfile: zWrite required when hdrMultiply stamped (no invent)');
    }
    if (typeof props.doubleSided !== 'boolean') {
      throw new Error('propsToProfile: doubleSided required when hdrMultiply stamped (no invent)');
    }
    if (typeof props.flipX !== 'boolean' || typeof props.flipY !== 'boolean') {
      throw new Error('propsToProfile: flipX/flipY required when hdrMultiply stamped (no invent)');
    }
    if (typeof props.proceduralRing !== 'boolean') {
      throw new Error('propsToProfile: proceduralRing required when hdrMultiply stamped (no invent)');
    }
    if (typeof props.legacyDoubleTint !== 'boolean'
      || typeof props.legacyMultiply !== 'boolean'
      || typeof props.legacyVertexColorRaw !== 'boolean') {
      throw new Error(
        'propsToProfile: legacyDoubleTint/legacyMultiply/legacyVertexColorRaw required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.legacyAlphaTintFactor !== 'number'
      || typeof props.legacyVertexColorGain !== 'number') {
      throw new Error(
        'propsToProfile: legacyAlphaTintFactor/legacyVertexColorGain required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.useMask !== 'boolean'
      || typeof props.useDistortion !== 'boolean'
      || typeof props.sceneColor !== 'boolean'
      || typeof props.useDissolve !== 'boolean'
      || typeof props.invertDissolve !== 'boolean'
      || typeof props.fading !== 'boolean'
      || typeof props.softFade !== 'boolean') {
      throw new Error(
        'propsToProfile: useMask/useDistortion/sceneColor/useDissolve/invertDissolve/fading/softFade required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.cutoff !== 'number') {
      throw new Error('propsToProfile: cutoff required when hdrMultiply stamped (no invent)');
    }
    if (typeof props.alphaClipThreshold !== 'number') {
      throw new Error('propsToProfile: alphaClipThreshold required when hdrMultiply stamped (no invent)');
    }
    if (typeof props.additive !== 'boolean'
      || typeof props.legacyPremultiply !== 'boolean'
      || typeof props.legacyMultiplyColored !== 'boolean') {
      throw new Error(
        'propsToProfile: additive/legacyPremultiply/legacyMultiplyColored required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.coverageChannel !== 'string') {
      throw new Error('propsToProfile: coverageChannel required when hdrMultiply stamped (no invent)');
    }
    if (props.fading
      && (typeof props.softParticle !== 'number'
        || typeof props.softParticleDepthScale !== 'number')) {
      throw new Error(
        'propsToProfile: fading requires softParticle and softParticleDepthScale when hdrMultiply stamped (no invent)',
      );
    }
    if (props.useMask && typeof props.maskMapUrl !== 'string') {
      throw new Error(
        'propsToProfile: useMask requires maskMapUrl when hdrMultiply stamped (no invent)',
      );
    }
    if (props.useDistortion && typeof props.distortionMapUrl !== 'string') {
      throw new Error(
        'propsToProfile: useDistortion requires distortionMapUrl when hdrMultiply stamped (no invent)',
      );
    }
    if (props.useDissolve && typeof props.dissolveMapUrl !== 'string') {
      throw new Error(
        'propsToProfile: useDissolve requires dissolveMapUrl when hdrMultiply stamped (no invent)',
      );
    }
    if (props.proceduralRing && typeof props.ringTopOffset !== 'number') {
      throw new Error(
        'propsToProfile: proceduralRing requires ringTopOffset when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.trailUvStretchY !== 'boolean'
      || typeof props.trailUvSpeedFromCustom2 !== 'boolean'
      || typeof props.frontFaceColorSelect !== 'boolean'
      || typeof props.slashWorldVertexAlpha !== 'boolean') {
      throw new Error(
        'propsToProfile: trailUvStretchY/trailUvSpeedFromCustom2/frontFaceColorSelect/slashWorldVertexAlpha required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.dynamicAlphaClip !== 'boolean') {
      throw new Error(
        'propsToProfile: dynamicAlphaClip required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.dynamicAlphaClipScale !== 'number') {
      throw new Error(
        'propsToProfile: dynamicAlphaClipScale required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.singleChannel !== 'boolean') {
      throw new Error(
        'propsToProfile: singleChannel required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.parallaxAmplitude !== 'number') {
      throw new Error(
        'propsToProfile: parallaxAmplitude required when hdrMultiply stamped (no invent)',
      );
    }
    if (!Array.isArray(props.slashWorldScreenOffset) || props.slashWorldScreenOffset.length !== 2) {
      throw new Error(
        'propsToProfile: slashWorldScreenOffset[2] required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.dissolveSmooth !== 'number'
      || !Array.isArray(props.dissolveScroll) || props.dissolveScroll.length !== 2) {
      throw new Error(
        'propsToProfile: dissolveSmooth/dissolveScroll[2] required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.softParticle !== 'number'
      || typeof props.softParticleDepthScale !== 'number') {
      throw new Error(
        'propsToProfile: softParticle/softParticleDepthScale required when hdrMultiply stamped (no invent)',
      );
    }
    if (!Array.isArray(props.maskSpeed) || props.maskSpeed.length !== 2
      || typeof props.maskRotation !== 'number'
      || !Array.isArray(props.maskRotationCenter) || props.maskRotationCenter.length !== 2
      || !Array.isArray(props.maskOffset) || props.maskOffset.length !== 2
      || typeof props.maskNoiseScale !== 'number') {
      throw new Error(
        'propsToProfile: maskSpeed/Rotation/RotationCenter/Offset/NoiseScale required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.distortionAmount !== 'number') {
      throw new Error(
        'propsToProfile: distortionAmount required when hdrMultiply stamped (no invent)',
      );
    }
    if (typeof props.trailUvRotation !== 'number'
      || typeof props.trailUvStretch !== 'number'
      || !Array.isArray(props.trailUvScroll) || props.trailUvScroll.length !== 2
      || !Array.isArray(props.trailUvTiling) || props.trailUvTiling.length !== 2
      || !Array.isArray(props.trailUvOffset) || props.trailUvOffset.length !== 2
      || typeof props.trailUvDistortionPower !== 'number'
      || !Array.isArray(props.trailUvDistortionSpeed) || props.trailUvDistortionSpeed.length !== 2) {
      throw new Error(
        'propsToProfile: trail UV off-path fields required when hdrMultiply stamped (no invent)',
      );
    }
    if (!Array.isArray(props.orbColour) || props.orbColour.length !== 3
      || !Array.isArray(props.orbFresnelColor) || props.orbFresnelColor.length !== 4
      || !Array.isArray(props.orbNoiseAnimation) || props.orbNoiseAnimation.length !== 2
      || !Array.isArray(props.orbWarpSpeed) || props.orbWarpSpeed.length !== 2
      || typeof props.orbFresnelPower !== 'number'
      || typeof props.orbNoiseScale !== 'number'
      || typeof props.orbNoiseFrequency !== 'number'
      || typeof props.orbNoiseAmplitude !== 'number'
      || typeof props.orbOctaveFrequencyScale !== 'number'
      || typeof props.orbOctaveAmplitudeScale !== 'number'
      || typeof props.orbOctaveDomainWarping !== 'number'
      || typeof props.orbNoisePower !== 'number'
      || typeof props.orbUvClipScale !== 'number') {
      throw new Error(
        'propsToProfile: orb off-path fields required when hdrMultiply stamped (no invent)',
      );
    }
    if (!Array.isArray(props.ambientSky) || props.ambientSky.length !== 3
      || !Array.isArray(props.ambientEquator) || props.ambientEquator.length !== 3
      || !Array.isArray(props.ambientGround) || props.ambientGround.length !== 3
      || !Array.isArray(props.ambientSH) || props.ambientSH.length !== 9) {
      throw new Error(
        'propsToProfile: ambientSky/Equator/Ground/SH required when hdrMultiply stamped (no invent)',
      );
    }
  }
  // v3 corpus stamps color/opacity; frozen/unstamped may still invent historical identity.
  const color: [number, number, number] = stampedPending
    ? [colorRaw![0], colorRaw![1], colorRaw![2]]
    : (Array.isArray(colorRaw) && colorRaw.length >= 3
      ? [colorRaw[0], colorRaw[1], colorRaw[2]]
      : [...CFXR_COLOR_MUL_SOFT_IDENTITY]);
  const opacity = stampedPending
    ? props.opacity!
    : (typeof props.opacity === 'number' ? props.opacity : CFXR_OPACITY_SOFT_IDENTITY);
  const dissolve = stampedPending ? props.useDissolve! : !!props.useDissolve;
  // v3 corpus stamps blendMode; frozen/unstamped may still invent from legacy flags.
  let blendMode: BlendMode | undefined = props.blendMode;
  if (!blendMode) {
    if (props.unityMode === 0) blendMode = 'opaque';
    else if (props.unityMode === 1) blendMode = 'alpha-test';
    else if (props.legacyPremultiply) blendMode = 'premultiplied-alpha';
    else if (props.additive) blendMode = 'additive';
    else throw new Error('propsToProfile: blendMode required (no invent)');
  }
  // v3 corpus stamps zWrite; frozen/unstamped may still invent from blendMode.
  let depthWrite: boolean;
  if (stampedPending) {
    depthWrite = props.zWrite!;
  } else if (typeof props.zWrite === 'boolean') {
    depthWrite = props.zWrite;
  } else {
    depthWrite = blendMode === 'opaque' || blendMode === 'alpha-test';
  }
  const flipX = stampedPending
    ? props.flipX!
    : (typeof props.flipX === 'boolean' ? props.flipX : CFXR_FLIP_SOFT_INVENT);
  const flipY = stampedPending
    ? props.flipY!
    : (typeof props.flipY === 'boolean' ? props.flipY : CFXR_FLIP_SOFT_INVENT);
  // v3 corpus stamps doubleSided; frozen/unstamped may still invent historical true.
  const doubleSided = stampedPending
    ? props.doubleSided!
    : (typeof props.doubleSided === 'boolean'
      ? props.doubleSided
      : CFXR_DOUBLE_SIDED_SOFT_INVENT);
  const profile: CfxrRuntimeProfile = {
    shaderFamily: props.shaderFamily,
    blendMode,
    depthWrite,
    doubleSided,
    ...(stampedPending
      ? { cutoff: props.cutoff! }
      : (typeof props.cutoff === 'number' ? { cutoff: props.cutoff } : { cutoff: CFXR_CUTOFF_SOFT_INVENT })),
    lightingModel: props.lightingModel,
    ...(Array.isArray(props.ambientSky) && props.ambientSky.length === 3
      ? { ambientSky: props.ambientSky }
      : {}),
    ...(Array.isArray(props.ambientEquator) && props.ambientEquator.length === 3
      ? { ambientEquator: props.ambientEquator }
      : {}),
    ...(Array.isArray(props.ambientGround) && props.ambientGround.length === 3
      ? { ambientGround: props.ambientGround }
      : {}),
    ...(props.ambientSH?.length === 9 ? { ambientSH: props.ambientSH } : {}),
    // Soft-invent historical 0 when unauthored (do not invent only at inject).
    hdr: stampedPending ? props.hdrMultiply! : (typeof props.hdrMultiply === 'number' ? props.hdrMultiply : CFXR_HDR_SOFT_INVENT),
    ...(stampedPending
      ? { singleChannel: props.singleChannel! }
      : (typeof props.singleChannel === 'boolean' ? { singleChannel: props.singleChannel } : {})),
    ...(stampedPending
      ? { coverageChannel: props.coverageChannel as NonNullable<CfxrMaterialProps['coverageChannel']> }
      : (props.coverageChannel ? { coverageChannel: props.coverageChannel } : {})),
    ...(props.mainUvTransform ? { mainUvTransform: props.mainUvTransform } : {}),
    ...(typeof props.trailUvRotation === 'number' ? { trailUvRotation: props.trailUvRotation } : {}),
    ...(typeof props.trailUvStretch === 'number' ? { trailUvStretch: props.trailUvStretch } : {}),
    trailUvStretchY: stampedPending ? props.trailUvStretchY! : !!props.trailUvStretchY,
    trailUvSpeedFromCustom2: stampedPending
      ? props.trailUvSpeedFromCustom2!
      : !!props.trailUvSpeedFromCustom2,
    ...(Array.isArray(props.trailUvScroll) && props.trailUvScroll.length === 2
      ? { trailUvScroll: props.trailUvScroll }
      : {}),
    ...(Array.isArray(props.trailUvTiling) && props.trailUvTiling.length === 2
      ? { trailUvTiling: props.trailUvTiling }
      : {}),
    ...(Array.isArray(props.trailUvOffset) && props.trailUvOffset.length === 2
      ? { trailUvOffset: props.trailUvOffset }
      : {}),
    ...(typeof props.trailUvDistortionPower === 'number'
      ? { trailUvDistortionPower: props.trailUvDistortionPower }
      : {}),
    ...(Array.isArray(props.trailUvDistortionSpeed) && props.trailUvDistortionSpeed.length === 2
      ? { trailUvDistortionSpeed: props.trailUvDistortionSpeed }
      : {}),
    manualGraphLowering: props.manualGraphLowering,
    frontFaceColorSelect: stampedPending ? props.frontFaceColorSelect! : !!props.frontFaceColorSelect,
    slashWorldVertexAlpha: stampedPending ? props.slashWorldVertexAlpha! : !!props.slashWorldVertexAlpha,
    heightMapUrl: props.heightMapUrl,
    ...(typeof props.heightMapSrgb === 'boolean' ? { heightMapSrgb: props.heightMapSrgb } : {}),
    heightSampler: props.heightSampler,
    ...(stampedPending
      ? { parallaxAmplitude: props.parallaxAmplitude! }
      : (typeof props.parallaxAmplitude === 'number'
        ? { parallaxAmplitude: props.parallaxAmplitude }
        : (props.manualGraphLowering === 'parallax-occlusion@1'
          ? {}
          : { parallaxAmplitude: CFXR_PARALLAX_AMPLITUDE_OFF }))),
    flipX,
    flipY,
    // tileCounts / mainMapSrgb / unityCenteredStretch / unityVerticalBillboard /
    // dissolveViaUvTile stay omitted until offline/before-batch stamps.
    ...(typeof props.mainMapSrgb === 'boolean' ? { mainMapSrgb: props.mainMapSrgb } : {}),
    // v3 corpus stamps alphaClipThreshold; frozen/unstamped may still invent 0.
    alphaClipThreshold: stampedPending
      ? props.alphaClipThreshold!
      : (typeof props.alphaClipThreshold === 'number'
        ? props.alphaClipThreshold
        : CFXR_ALPHA_CLIP_THRESHOLD_SOFT_INVENT),
    ...(stampedPending
      ? (props.dynamicAlphaClip!
        ? {
            dynamicAlphaClip: true,
            ...(typeof props.dynamicAlphaClipScale === 'number'
              ? { dynamicAlphaClipScale: props.dynamicAlphaClipScale }
              : (() => {
                  throw new Error(
                    'propsToProfile: dynamicAlphaClip requires dynamicAlphaClipScale (no invent)',
                  );
                })()),
            ...(props.dynamicAlphaClipSource
              ? { dynamicAlphaClipSource: props.dynamicAlphaClipSource }
              : (() => {
                  throw new Error(
                    'propsToProfile: dynamicAlphaClip requires dynamicAlphaClipSource (no invent)',
                  );
                })()),
          }
        : {
            dynamicAlphaClipScale: props.dynamicAlphaClipScale!,
          })
      : (props.dynamicAlphaClip
        ? {
            dynamicAlphaClip: true,
            ...(typeof props.dynamicAlphaClipScale === 'number'
              ? { dynamicAlphaClipScale: props.dynamicAlphaClipScale }
              : (() => {
                  throw new Error(
                    'propsToProfile: dynamicAlphaClip requires dynamicAlphaClipScale (no invent)',
                  );
                })()),
            ...(props.dynamicAlphaClipSource
              ? { dynamicAlphaClipSource: props.dynamicAlphaClipSource }
              : (() => {
                  throw new Error(
                    'propsToProfile: dynamicAlphaClip requires dynamicAlphaClipSource (no invent)',
                  );
                })()),
          }
        : {
            // Off path: always stamp scale so inject never invents 0.
            dynamicAlphaClipScale: typeof props.dynamicAlphaClipScale === 'number'
              ? props.dynamicAlphaClipScale
              : CFXR_DYNAMIC_ALPHA_CLIP_SCALE_OFF,
            ...(props.dynamicAlphaClipSource
              ? { dynamicAlphaClipSource: props.dynamicAlphaClipSource }
              : {}),
          })),
    ...(dissolve
      ? {
          dissolve: true,
          ...(typeof props.dissolveSmooth === 'number'
            ? { dissolveSmooth: props.dissolveSmooth }
            : (() => {
                throw new Error('propsToProfile: dissolve requires dissolveSmooth (no invent)');
              })()),
          ...(Array.isArray(props.dissolveScroll) && props.dissolveScroll.length === 2
            ? { dissolveScroll: props.dissolveScroll }
            : (() => {
                throw new Error('propsToProfile: dissolve requires dissolveScroll[2] (no invent)');
              })()),
          ...(typeof props.invertDissolve === 'boolean'
            ? { invertDissolve: props.invertDissolve }
            : (() => {
                throw new Error('propsToProfile: dissolve requires invertDissolve (no invent)');
              })()),
        }
      : stampedPending
        ? {
            dissolveSmooth: props.dissolveSmooth!,
            dissolveScroll: props.dissolveScroll as [number, number],
            invertDissolve: props.invertDissolve!,
          }
        : {
            dissolveSmooth: typeof props.dissolveSmooth === 'number'
              ? props.dissolveSmooth
              : CFXR_DISSOLVE_SMOOTH_OFF,
            dissolveScroll: Array.isArray(props.dissolveScroll) && props.dissolveScroll.length === 2
              ? props.dissolveScroll
              : ([...CFXR_DISSOLVE_SCROLL_OFF] as [number, number]),
          }),
    colorMul: [color[0], color[1], color[2]],
    softFade: stampedPending ? props.softFade! : !!props.fading,
    ...(props.fading
      ? {
          ...(typeof props.softParticle === 'number'
            && typeof props.softParticleDepthScale === 'number'
            ? {}
            : (() => {
                throw new Error(
                  'propsToProfile: fading requires softParticle and softParticleDepthScale (no invent)',
                );
              })()),
        }
      : {}),
    ...(() => {
      if (stampedPending) {
        if (!props.fading!) return { softParticleStrength: props.softParticle! };
        return {
          softParticleStrength: Math.max(
            CFXR_SOFT_FADE_PLACEHOLDER_STRENGTH,
            props.softParticle! * props.softParticleDepthScale!,
          ),
        };
      }
      const hasSoft = typeof props.softParticle === 'number';
      const hasScale = typeof props.softParticleDepthScale === 'number';
      if (hasSoft !== hasScale) {
        throw new Error(
          'propsToProfile: softParticleStrength requires both softParticle and softParticleDepthScale',
        );
      }
      if (!hasSoft) return { softParticleStrength: CFXR_SOFT_PARTICLE_STRENGTH_OFF };
      return {
        softParticleStrength: Math.max(
          CFXR_SOFT_FADE_PLACEHOLDER_STRENGTH,
          props.softParticle! * props.softParticleDepthScale!,
        ),
      };
    })(),
    ...(stampedPending
      ? {
          additive: props.additive!,
          legacyMultiplyColored: props.legacyMultiplyColored!,
          legacyMultiply: props.legacyMultiply!,
          legacyPremultiply: props.legacyPremultiply!,
        }
      : {
          ...(props.additive ? { additive: true } : { additive: false }),
          ...(props.legacyMultiplyColored ? { legacyMultiplyColored: true } : { legacyMultiplyColored: false }),
          ...(props.legacyMultiply ? { legacyMultiply: true } : { legacyMultiply: false }),
          ...(props.legacyPremultiply ? { legacyPremultiply: true } : { legacyPremultiply: false }),
        }),
    ...(stampedPending
      ? (props.legacyDoubleTint!
        ? {
            legacyDoubleTint: true,
            legacyAlphaTintFactor: props.legacyAlphaTintFactor!,
          }
        : {
            legacyAlphaTintFactor: props.legacyAlphaTintFactor!,
          })
      : (props.legacyDoubleTint
        ? {
            legacyDoubleTint: true,
            ...(typeof props.legacyAlphaTintFactor === 'number'
              ? { legacyAlphaTintFactor: props.legacyAlphaTintFactor }
              : (() => {
                  throw new Error(
                    'propsToProfile: legacyDoubleTint requires legacyAlphaTintFactor (no invent)',
                  );
                })()),
          }
        : {
            // Off path: full-inject historical invent is 0 (bake path still invents 2).
            legacyAlphaTintFactor: typeof props.legacyAlphaTintFactor === 'number'
              ? props.legacyAlphaTintFactor
              : CFXR_LEGACY_ALPHA_TINT_FACTOR_OFF_PATH,
          })),
    ...(stampedPending
      ? (props.legacyVertexColorRaw!
        ? {
            legacyVertexColorRaw: true,
            legacyVertexColorGain: props.legacyVertexColorGain!,
          }
        : {
            legacyVertexColorGain: props.legacyVertexColorGain!,
          })
      : (props.legacyVertexColorRaw
        ? {
            legacyVertexColorRaw: true,
            ...(typeof props.legacyVertexColorGain === 'number'
              ? { legacyVertexColorGain: props.legacyVertexColorGain }
              : (() => {
                  throw new Error(
                    'propsToProfile: legacyVertexColorRaw requires legacyVertexColorGain (no invent)',
                  );
                })()),
          }
        : {
            // Off path: always write so inject never invents 1.
            legacyVertexColorGain: typeof props.legacyVertexColorGain === 'number'
              ? props.legacyVertexColorGain
              : CFXR_LEGACY_VERTEX_COLOR_GAIN_OFF_PATH,
          })),
    ...(stampedPending
      ? { proceduralRing: props.proceduralRing! }
      : (props.proceduralRing ? { proceduralRing: true } : { proceduralRing: false })),
    ...(typeof props.ringTopOffset === 'number' ? { ringTopOffset: props.ringTopOffset } : {}),
    dissolveMapUrl: stampedPending
      ? (dissolve ? props.dissolveMapUrl : undefined)
      : (props.dissolveMapUrl
        || (props.dissolveTextureName
          ? `/assets/quarks/${dissolveFileName(props.dissolveTextureName)}`
          : undefined)),
    // Soft-invent historical true on profile only — do not stamp pending (family fingerprint).
    vertexColorRgb: typeof props.vertexColorRgb === 'boolean'
      ? props.vertexColorRgb
      : CFXR_VERTEX_COLOR_SOFT_INVENT,
    vertexColorAlpha: typeof props.vertexColorAlpha === 'boolean'
      ? props.vertexColorAlpha
      : CFXR_VERTEX_COLOR_SOFT_INVENT,
    backColorMul:
      props.frontColor && props.backColor
        ? [props.backColor[0], props.backColor[1], props.backColor[2]]
        : undefined,
    ...(stampedPending && !props.useMask!
      ? {
          useMask: false,
          maskSpeed: props.maskSpeed as [number, number],
          maskRotation: props.maskRotation!,
          maskRotationCenter: props.maskRotationCenter as [number, number],
          maskOffset: props.maskOffset as [number, number],
          maskNoiseScale: props.maskNoiseScale!,
        }
      : props.useMask && (props.maskMapUrl || props.maskMap)
        ? {
            useMask: true,
            ...(Array.isArray(props.maskSpeed) && props.maskSpeed.length === 2
              ? { maskSpeed: props.maskSpeed }
              : (() => {
                  throw new Error('propsToProfile: useMask requires maskSpeed[2] (no invent)');
                })()),
            ...(typeof props.maskRotation === 'number'
              ? { maskRotation: props.maskRotation }
              : (() => {
                  throw new Error('propsToProfile: useMask requires maskRotation (no invent)');
                })()),
            ...(Array.isArray(props.maskRotationCenter) && props.maskRotationCenter.length === 2
              ? { maskRotationCenter: props.maskRotationCenter }
              : (() => {
                  throw new Error('propsToProfile: useMask requires maskRotationCenter[2] (no invent)');
                })()),
            ...(Array.isArray(props.maskOffset) && props.maskOffset.length === 2
              ? { maskOffset: props.maskOffset }
              : (() => {
                  throw new Error('propsToProfile: useMask requires maskOffset[2] (no invent)');
                })()),
            ...(typeof props.maskNoiseScale === 'number'
              ? { maskNoiseScale: props.maskNoiseScale }
              : (() => {
                  throw new Error('propsToProfile: useMask requires maskNoiseScale (no invent)');
                })()),
            ...(props.maskChannel === 'red' || props.maskChannel === 'alpha'
              ? { maskChannel: props.maskChannel }
              : (() => {
                  throw new Error('propsToProfile: useMask requires maskChannel (no invent)');
                })()),
          }
        : {
            maskSpeed: Array.isArray(props.maskSpeed) && props.maskSpeed.length === 2
              ? props.maskSpeed
              : ([...CFXR_MASK_SPEED_OFF] as [number, number]),
            maskRotation: typeof props.maskRotation === 'number'
              ? props.maskRotation
              : CFXR_MASK_ROTATION_OFF,
            maskRotationCenter: Array.isArray(props.maskRotationCenter)
              && props.maskRotationCenter.length === 2
              ? props.maskRotationCenter
              : ([...CFXR_MASK_ROTATION_CENTER_OFF] as [number, number]),
            maskOffset: Array.isArray(props.maskOffset) && props.maskOffset.length === 2
              ? props.maskOffset
              : ([...CFXR_MASK_OFFSET_OFF] as [number, number]),
            maskNoiseScale: typeof props.maskNoiseScale === 'number'
              ? props.maskNoiseScale
              : CFXR_MASK_NOISE_SCALE_OFF,
          }),
    maskMapUrl: props.maskMapUrl,
    ...(typeof props.maskMapSrgb === 'boolean' ? { maskMapSrgb: props.maskMapSrgb } : {}),
    maskSampler: props.maskSampler,
    // Stamped: derive from authored maskWarp token (absent ⇒ false). No silent off invent.
    maskWarp: props.maskWarp === 'simple-noise-product',
    ...(stampedPending && !props.useDistortion!
      ? {
          useDistortion: false,
          distortionAmount: props.distortionAmount!,
        }
      : props.useDistortion
        ? {
            useDistortion: true,
            ...(typeof props.distortionAmount === 'number'
              ? { distortionAmount: props.distortionAmount }
              : (() => {
                  throw new Error(
                    'propsToProfile: useDistortion requires distortionAmount (no invent)',
                  );
                })()),
          }
        : {
            distortionAmount: typeof props.distortionAmount === 'number'
              ? props.distortionAmount
              : CFXR_DISTORTION_AMOUNT_OFF,
          }),
    ...(stampedPending
      ? { sceneColor: props.sceneColor! }
      : (props.sceneColor ? { sceneColor: true } : { sceneColor: false })),
    distortionMapUrl: props.distortionMapUrl,
    ...(typeof props.distortionMapSrgb === 'boolean'
      ? { distortionMapSrgb: props.distortionMapSrgb }
      : {}),
    distortionSampler: props.distortionSampler,
    ...(typeof props.dissolveMapSrgb === 'boolean'
      ? { dissolveMapSrgb: props.dissolveMapSrgb }
      : {}),
    dissolveSampler: props.dissolveSampler,
    ...(stampedPending
      ? { slashWorldScreenOffset: props.slashWorldScreenOffset as [number, number] }
      : (Array.isArray(props.slashWorldScreenOffset) && props.slashWorldScreenOffset.length === 2
        ? { slashWorldScreenOffset: props.slashWorldScreenOffset }
        : (props.manualGraphLowering === 'slash-world@3'
            || props.manualGraphLowering === 'slash-screen@2'
          ? {}
          : { slashWorldScreenOffset: [...CFXR_SLASH_SCREEN_OFFSET_OFF] as [number, number] }))),
    opacity,
    // Never authored in pending corpus; soft-invent historical 1 for frozen/unstamped props.
    // Do not stamp into pending (family fingerprint).
    texPower: typeof props.texPower === 'number' ? props.texPower : CFXR_TEX_POWER_IDENTITY,
    colorPower: typeof props.colorPower === 'number' ? props.colorPower : CFXR_COLOR_POWER_IDENTITY,
    orbAlphaMapUrl: props.orbAlphaMapUrl,
    ...(typeof props.orbAlphaMapSrgb === 'boolean' ? { orbAlphaMapSrgb: props.orbAlphaMapSrgb } : {}),
    ...(typeof props.orbAlphaConstantOne === 'boolean'
      ? { orbAlphaConstantOne: props.orbAlphaConstantOne }
      : {}),
    orbAlphaSampler: props.orbAlphaSampler,
    orbNoiseMapUrl: props.orbNoiseMapUrl,
    ...(typeof props.orbNoiseMapSrgb === 'boolean' ? { orbNoiseMapSrgb: props.orbNoiseMapSrgb } : {}),
    orbNoiseSampler: props.orbNoiseSampler,
    ...(Array.isArray(props.orbColour) && props.orbColour.length === 3
      ? { orbColour: props.orbColour }
      : {}),
    ...(Array.isArray(props.orbFresnelColor) && props.orbFresnelColor.length === 4
      ? { orbFresnelColor: props.orbFresnelColor }
      : {}),
    ...(Array.isArray(props.orbNoiseAnimation) && props.orbNoiseAnimation.length === 2
      ? { orbNoiseAnimation: props.orbNoiseAnimation }
      : {}),
    ...(Array.isArray(props.orbWarpSpeed) && props.orbWarpSpeed.length === 2
      ? { orbWarpSpeed: props.orbWarpSpeed }
      : {}),
    ...(typeof props.orbFresnelPower === 'number' ? { orbFresnelPower: props.orbFresnelPower } : {}),
    ...(typeof props.orbNoiseScale === 'number' ? { orbNoiseScale: props.orbNoiseScale } : {}),
    ...(typeof props.orbNoiseFrequency === 'number' ? { orbNoiseFrequency: props.orbNoiseFrequency } : {}),
    ...(typeof props.orbNoiseAmplitude === 'number' ? { orbNoiseAmplitude: props.orbNoiseAmplitude } : {}),
    ...(typeof props.orbOctaveFrequencyScale === 'number'
      ? { orbOctaveFrequencyScale: props.orbOctaveFrequencyScale }
      : {}),
    ...(typeof props.orbOctaveAmplitudeScale === 'number'
      ? { orbOctaveAmplitudeScale: props.orbOctaveAmplitudeScale }
      : {}),
    ...(typeof props.orbOctaveDomainWarping === 'number'
      ? { orbOctaveDomainWarping: props.orbOctaveDomainWarping }
      : {}),
    ...(typeof props.orbNoisePower === 'number' ? { orbNoisePower: props.orbNoisePower } : {}),
    ...(typeof props.orbUvClipScale === 'number' ? { orbUvClipScale: props.orbUvClipScale } : {}),
    ...(props.orbVertexAlphaChannel === 'alpha' || props.orbVertexAlphaChannel === 'green'
      ? { orbVertexAlphaChannel: props.orbVertexAlphaChannel }
      : {}),
  };

  if (!dissolve) profile.dissolve = false;
  if (!(props.useMask && (props.maskMapUrl || props.maskMap))) profile.useMask = false;
  if (!props.useDistortion) profile.useDistortion = false;
  if (!dissolve && typeof profile.invertDissolve !== 'boolean') {
    profile.invertDissolve = false;
  }

  const trail = profile.mainUvTransform === 'trail-front-face@2'
    || profile.manualGraphLowering === 'trail-front-face@2';
  if (trail) {
    if (typeof profile.trailUvRotation !== 'number'
      || typeof profile.trailUvStretch !== 'number'
      || !Array.isArray(profile.trailUvScroll) || profile.trailUvScroll.length !== 2
      || !Array.isArray(profile.trailUvTiling) || profile.trailUvTiling.length !== 2
      || !Array.isArray(profile.trailUvOffset) || profile.trailUvOffset.length !== 2
      || typeof profile.trailUvDistortionPower !== 'number'
      || !Array.isArray(profile.trailUvDistortionSpeed)
      || profile.trailUvDistortionSpeed.length !== 2) {
      throw new Error(
        'propsToProfile: trail-front-face@2 requires trail UV fields (no invent)',
      );
    }
    if (typeof props.trailUvStretchY !== 'boolean'
      || typeof props.trailUvSpeedFromCustom2 !== 'boolean') {
      throw new Error(
        'propsToProfile: trail-front-face@2 requires trailUvStretchY/SpeedFromCustom2 (no invent)',
      );
    }
    profile.trailUvStretchY = props.trailUvStretchY;
    profile.trailUvSpeedFromCustom2 = props.trailUvSpeedFromCustom2;
  } else if (stampedPending) {
    // Stamped non-trail: use corpus off-path stamps (no CFXR_*_OFF invent).
    profile.trailUvRotation = props.trailUvRotation!;
    profile.trailUvStretch = props.trailUvStretch!;
    profile.trailUvScroll = props.trailUvScroll as [number, number];
    profile.trailUvTiling = props.trailUvTiling as [number, number];
    profile.trailUvOffset = props.trailUvOffset as [number, number];
    profile.trailUvDistortionPower = props.trailUvDistortionPower!;
    profile.trailUvDistortionSpeed = props.trailUvDistortionSpeed as [number, number];
  } else {
    // Off path: fill historical inject invents so uniforms never invent at bind time.
    if (typeof profile.trailUvRotation !== 'number') {
      profile.trailUvRotation = CFXR_TRAIL_UV_ROTATION_OFF;
    }
    if (typeof profile.trailUvStretch !== 'number') {
      profile.trailUvStretch = CFXR_TRAIL_UV_STRETCH_OFF;
    }
    if (!Array.isArray(profile.trailUvScroll) || profile.trailUvScroll.length !== 2) {
      profile.trailUvScroll = [...CFXR_TRAIL_UV_SCROLL_OFF];
    }
    if (!Array.isArray(profile.trailUvTiling) || profile.trailUvTiling.length !== 2) {
      profile.trailUvTiling = [...CFXR_TRAIL_UV_TILING_OFF];
    }
    if (!Array.isArray(profile.trailUvOffset) || profile.trailUvOffset.length !== 2) {
      profile.trailUvOffset = [...CFXR_TRAIL_UV_OFFSET_OFF];
    }
    if (typeof profile.trailUvDistortionPower !== 'number') {
      profile.trailUvDistortionPower = CFXR_TRAIL_UV_DISTORTION_POWER_OFF;
    }
    if (!Array.isArray(profile.trailUvDistortionSpeed)
      || profile.trailUvDistortionSpeed.length !== 2) {
      profile.trailUvDistortionSpeed = [...CFXR_TRAIL_UV_DISTORTION_SPEED_OFF];
    }
  }

  if (profile.manualGraphLowering === 'parallax-occlusion@1'
    && typeof profile.parallaxAmplitude !== 'number') {
    throw new Error('propsToProfile: parallax-occlusion@1 requires parallaxAmplitude (no invent)');
  }

  const orbWarp = profile.manualGraphLowering === 'orb-warp@1'
    || profile.manualGraphLowering === 'orb-warp-lit@1';
  if (orbWarp) {
    if (!Array.isArray(profile.orbColour) || profile.orbColour.length !== 3
      || !Array.isArray(profile.orbFresnelColor) || profile.orbFresnelColor.length !== 4
      || !Array.isArray(profile.orbNoiseAnimation) || profile.orbNoiseAnimation.length !== 2
      || !Array.isArray(profile.orbWarpSpeed) || profile.orbWarpSpeed.length !== 2
      || typeof profile.orbFresnelPower !== 'number'
      || typeof profile.orbNoiseScale !== 'number'
      || typeof profile.orbNoiseFrequency !== 'number'
      || typeof profile.orbNoiseAmplitude !== 'number'
      || typeof profile.orbOctaveFrequencyScale !== 'number'
      || typeof profile.orbOctaveAmplitudeScale !== 'number'
      || typeof profile.orbOctaveDomainWarping !== 'number'
      || typeof profile.orbNoisePower !== 'number'
      || typeof profile.orbUvClipScale !== 'number') {
      throw new Error('propsToProfile: orb-warp requires orb uniform fields (no invent)');
    }
  } else if (stampedPending) {
    // Stamped non-orb: use corpus off-path stamps (no CFXR_ORB_*_OFF invent).
    profile.orbColour = props.orbColour as [number, number, number];
    profile.orbFresnelColor = props.orbFresnelColor as [number, number, number, number];
    profile.orbNoiseAnimation = props.orbNoiseAnimation as [number, number];
    profile.orbWarpSpeed = props.orbWarpSpeed as [number, number];
    profile.orbFresnelPower = props.orbFresnelPower!;
    profile.orbNoiseScale = props.orbNoiseScale!;
    profile.orbNoiseFrequency = props.orbNoiseFrequency!;
    profile.orbNoiseAmplitude = props.orbNoiseAmplitude!;
    profile.orbOctaveFrequencyScale = props.orbOctaveFrequencyScale!;
    profile.orbOctaveAmplitudeScale = props.orbOctaveAmplitudeScale!;
    profile.orbOctaveDomainWarping = props.orbOctaveDomainWarping!;
    profile.orbNoisePower = props.orbNoisePower!;
    profile.orbUvClipScale = props.orbUvClipScale!;
  } else {
    // Off path: historical inject invents so bind never invents.
    if (!Array.isArray(profile.orbColour) || profile.orbColour.length !== 3) {
      profile.orbColour = [...CFXR_ORB_COLOUR_OFF];
    }
    if (!Array.isArray(profile.orbFresnelColor) || profile.orbFresnelColor.length !== 4) {
      profile.orbFresnelColor = [...CFXR_ORB_FRESNEL_COLOR_OFF];
    }
    if (!Array.isArray(profile.orbNoiseAnimation) || profile.orbNoiseAnimation.length !== 2) {
      profile.orbNoiseAnimation = [...CFXR_ORB_VEC2_OFF];
    }
    if (!Array.isArray(profile.orbWarpSpeed) || profile.orbWarpSpeed.length !== 2) {
      profile.orbWarpSpeed = [...CFXR_ORB_VEC2_OFF];
    }
    if (typeof profile.orbFresnelPower !== 'number') profile.orbFresnelPower = CFXR_ORB_SCALAR_OFF;
    if (typeof profile.orbNoiseScale !== 'number') profile.orbNoiseScale = CFXR_ORB_SCALAR_OFF;
    if (typeof profile.orbNoiseFrequency !== 'number') profile.orbNoiseFrequency = CFXR_ORB_SCALAR_OFF;
    if (typeof profile.orbNoiseAmplitude !== 'number') profile.orbNoiseAmplitude = CFXR_ORB_SCALAR_OFF;
    if (typeof profile.orbOctaveFrequencyScale !== 'number') {
      profile.orbOctaveFrequencyScale = CFXR_ORB_SCALAR_OFF;
    }
    if (typeof profile.orbOctaveAmplitudeScale !== 'number') {
      profile.orbOctaveAmplitudeScale = CFXR_ORB_SCALAR_OFF;
    }
    if (typeof profile.orbOctaveDomainWarping !== 'number') {
      profile.orbOctaveDomainWarping = CFXR_ORB_SCALAR_OFF;
    }
    if (typeof profile.orbNoisePower !== 'number') profile.orbNoisePower = CFXR_ORB_SCALAR_OFF;
    if (typeof profile.orbUvClipScale !== 'number') profile.orbUvClipScale = CFXR_ORB_SCALAR_OFF;
  }

  if (profile.manualGraphLowering === 'slash-world@3'
    || profile.manualGraphLowering === 'slash-screen@2') {
    if (!Array.isArray(profile.slashWorldScreenOffset)
      || profile.slashWorldScreenOffset.length !== 2) {
      throw new Error(
        `propsToProfile: ${profile.manualGraphLowering} requires slashWorldScreenOffset[2] (no invent)`,
      );
    }
  }

  if (profile.singleChannel) {
    if (profile.coverageChannel !== 'luminance'
      && profile.coverageChannel !== 'red'
      && profile.coverageChannel !== 'green'
      && profile.coverageChannel !== 'alpha') {
      throw new Error('propsToProfile: singleChannel requires coverageChannel (no invent)');
    }
  }

  if (profile.frontFaceColorSelect && !profile.backColorMul) {
    throw new Error(
      'propsToProfile: frontFaceColorSelect requires frontColor+backColor (no invent)',
    );
  }

  if (profile.lightingModel === 'unity-urp-lit-reference@1') {
    if (!Array.isArray(profile.ambientSky) || profile.ambientSky.length !== 3
      || !Array.isArray(profile.ambientEquator) || profile.ambientEquator.length !== 3
      || !Array.isArray(profile.ambientGround) || profile.ambientGround.length !== 3
      || !Array.isArray(profile.ambientSH) || profile.ambientSH.length !== 9) {
      throw new Error(
        'propsToProfile: unity-urp-lit-reference@1 requires ambientSky/Equator/Ground/SH (no invent)',
      );
    }
  } else if (stampedPending) {
    // Stamped non-lit: use corpus off-path stamps (no CFXR_AMBIENT_*_OFF invent).
    profile.ambientSky = props.ambientSky as [number, number, number];
    profile.ambientEquator = props.ambientEquator as [number, number, number];
    profile.ambientGround = props.ambientGround as [number, number, number];
    profile.ambientSH = props.ambientSH as Array<[number, number, number]>;
  } else {
    // Off path: historical inject invents so bind never invents.
    if (!Array.isArray(profile.ambientSky) || profile.ambientSky.length !== 3) {
      profile.ambientSky = [...CFXR_AMBIENT_RGB_OFF];
    }
    if (!Array.isArray(profile.ambientEquator) || profile.ambientEquator.length !== 3) {
      profile.ambientEquator = [...CFXR_AMBIENT_RGB_OFF];
    }
    if (!Array.isArray(profile.ambientGround) || profile.ambientGround.length !== 3) {
      profile.ambientGround = [...CFXR_AMBIENT_RGB_OFF];
    }
    if (!Array.isArray(profile.ambientSH) || profile.ambientSH.length !== 9) {
      profile.ambientSH = Array.from(
        { length: 9 },
        () => [...CFXR_AMBIENT_SH_BAND_OFF] as [number, number, number],
      );
    }
  }

  return profile;
}

function semanticBlending(profile: CfxrRuntimeProfile) {
  const blendMode = resolveProfileBlendMode(profile);
  if (blendMode === 'opaque' || blendMode === 'alpha-test') return NoBlending;
  if (blendMode === 'additive' || profile.additive) return AdditiveBlending;
  return NormalBlending;
}

export function applySemanticBlendState(mat: Material, profile: CfxrRuntimeProfile) {
  if (profile.legacyMultiply) {
    // Unity built-in Particle Multiply: Blend Zero SrcColor, ColorMask RGB.
    mat.blending = CustomBlending;
    mat.blendEquation = AddEquation;
    mat.blendSrc = ZeroFactor;
    mat.blendDst = SrcColorFactor;
    mat.blendEquationAlpha = AddEquation;
    mat.blendSrcAlpha = ZeroFactor;
    mat.blendDstAlpha = OneFactor;
    mat.premultipliedAlpha = false;
  } else if (profile.legacyPremultiply) {
    // Unity built-in Particle Premultiply: Blend One OneMinusSrcAlpha, ColorMask RGB.
    mat.blending = CustomBlending;
    mat.blendEquation = AddEquation;
    mat.blendSrc = OneFactor;
    mat.blendDst = OneMinusSrcAlphaFactor;
    mat.blendEquationAlpha = AddEquation;
    mat.blendSrcAlpha = ZeroFactor;
    mat.blendDstAlpha = OneFactor;
    mat.premultipliedAlpha = false;
  } else if (profile.legacyMultiplyColored) {
    // Exact Unity Blend DstColor Zero; Three's MultiplyBlending preset is not equivalent.
    mat.blending = CustomBlending;
    mat.blendEquation = AddEquation;
    mat.blendSrc = DstColorFactor;
    mat.blendDst = ZeroFactor;
    mat.blendEquationAlpha = AddEquation;
    mat.blendSrcAlpha = ZeroFactor;
    mat.blendDstAlpha = OneFactor;
    mat.premultipliedAlpha = false;
  } else {
    mat.blending = semanticBlending(profile);
    mat.premultipliedAlpha = resolveProfileBlendMode(profile) === 'premultiplied-alpha';
  }
  mat.depthWrite = resolveProfileDepthWrite(profile);
  const blendMode = resolveProfileBlendMode(profile);
  mat.transparent = blendMode !== 'opaque' && blendMode !== 'alpha-test';
  mat.alphaTest = blendMode === 'alpha-test'
    ? Math.max(CFXR_ALPHA_TEST_FLOOR, resolveProfileCutoff(profile))
    : CFXR_ALPHA_TEST_DISABLED;
}

function dissolveFileName(name: string) {
  // Unity: "cfxr smoke cloud x4 dissolve" → public file we ship or user copies
  const base = name.replace(/\.(png|jpg|jpeg|tga)$/i, '');
  return `${base.replace(/\s+/g, '_').toLowerCase()}.png`;
}

let softRingTex: DataTexture | null = null;
/** Soft-ring procedural texture bake parameters (frozen-sensitive). */
export const CFXR_SOFT_RING_TEX_SIZE = 128;
export const CFXR_SOFT_RING_TOP_CAP = 0.98;
export const CFXR_SOFT_RING_TOP_BASE = 0.92;
export const CFXR_SOFT_RING_BAND_WIDTH = 0.14;
export const CFXR_SOFT_RING_SMOOTH = 0.06;
export const CFXR_SOFT_RING_ALPHA_POWER = 1.8;
export const CFXR_SOFT_RING_ALPHA_PEAK = 140;

/** Thin annulus approximating CFXR procedural ring (subtle ground flash, not a heavy decal). */
export function getSoftRingTexture(ringTop: number) {
  if (typeof ringTop !== 'number') {
    throw new Error('getSoftRingTexture: ringTop required (no invent)');
  }
  if (softRingTex) return softRingTex;
  const s = CFXR_SOFT_RING_TEX_SIZE;
  const data = new Uint8Array(s * s * 4);
  // ringTop ~0.07 → outer rim near unit circle; keep a thin band
  const top = Math.min(CFXR_SOFT_RING_TOP_CAP, CFXR_SOFT_RING_TOP_BASE + ringTop);
  const inner = top - CFXR_SOFT_RING_BAND_WIDTH;
  const smooth = CFXR_SOFT_RING_SMOOTH;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const u = ((x + 0.5) / s) * 2 - 1;
      const v = ((y + 0.5) / s) * 2 - 1;
      const g = Math.sqrt(u * u + v * v);
      const ring = Math.max(
        0,
        Math.min(1, smoothstep(inner, inner + smooth, g) - smoothstep(top - smooth, top, g)),
      );
      const i = (y * s + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      // Soft, low peak alpha — Unity demo reads as warm ground kiss, not a bold hoop
      data[i + 3] = Math.round(Math.pow(ring, CFXR_SOFT_RING_ALPHA_POWER) * CFXR_SOFT_RING_ALPHA_PEAK);
    }
  }
  softRingTex = new DataTexture(data, s, s, RGBAFormat);
  softRingTex.colorSpace = NoColorSpace;
  softRingTex.needsUpdate = true;
  softRingTex.name = 'cfxr_proc_ring';
  return softRingTex;
}