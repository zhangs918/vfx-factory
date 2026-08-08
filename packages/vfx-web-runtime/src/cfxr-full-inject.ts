/**
 * Production full CFXR ubershader inject (defines + uniforms + fragment).
 * Thin ArtifactQuarksPlayer never enters this module.
 */
import {
  DoubleSide,
  FrontSide,
  GLSL3,
  type ShaderMaterial,
  type Texture,
} from 'three';
import type { VfxPipelineBlendState } from './cfxr-blend-state';
import type { VfxPipelineUniformValues } from './cfxr-constant-uniforms';
import { registerCfxrSceneInputMaterial } from './cfxr-scene-inputs';
import {
  applySemanticBlendState,
  CFXR_ALPHA_TEST_DISABLED,
  CFXR_ALPHA_TEST_FLOOR,
  resolveProfileDepthWrite,
  resolveProfileBlendMode,
  resolveProfileCutoff,
  resolveProfileDoubleSided,
  type CfxrRuntimeProfile,
} from './cfxr-material-profile';
import { CFXR_UBERSHADER_FRAGMENT } from './cfxr-ubershader-fragment';
import { applyCfxrInjectDefines, type CfxrInjectMaps } from './cfxr-inject-defines';
import { applyCfxrInjectUniforms } from './cfxr-inject-uniforms';
import { applyArtifactSlimInject } from './cfxr-slim-inject';
import { applyCfxrDualPathVertexPatches } from './cfxr-dual-path-vertex';
import type { MountPolicy } from './cfxr-mount-policy';
import { loadCfxrTexture } from './cfxr-texture-cache';
import { CFXR_TONE_MAPPED_OFF } from './cfxr-blend-apply';

/** @deprecated Prefer CFXR_TONE_MAPPED_OFF (shared with thin stock early-blend). */
export const CFXR_UBERSHADER_TONE_MAPPED = CFXR_TONE_MAPPED_OFF;

export type CfxrInjectOptions = {
  /** Dual-path snapshot from after-batch (no URL reads in this module). */
  policy: MountPolicy;
  installFragment?: boolean;
  declaredVertexPatches?: string[];
  declaredBlendState?: VfxPipelineBlendState;
  declaredUniformValues?: VfxPipelineUniformValues;
  declaredTileCounts?: [number, number];
  /** Live-bridge capture stamps — slim inject skips profile dual-path asserts. */
  captureOwned?: boolean;
};

export async function loadCfxrInjectMaps(
  profile: CfxrRuntimeProfile,
): Promise<CfxrInjectMaps> {
  let dissolve: Texture | null = null;
  let mask: Texture | null = null;
  let distortion: Texture | null = null;
  let height: Texture | null = null;
  let orbAlpha: Texture | null = null;
  let orbNoise: Texture | null = null;
  if (profile.dissolve) {
    if (!profile.dissolveMapUrl) {
      throw new Error('full-inject: dissolve requires offline dissolveMapUrl (no default texture invent)');
    }
    if (typeof profile.dissolveMapSrgb !== 'boolean') {
      throw new Error('full-inject: dissolve requires dissolveMapSrgb (no invent)');
    }
    dissolve = await loadCfxrTexture(
      profile.dissolveMapUrl, profile.dissolveMapSrgb, profile.dissolveSampler);
  }
  if (profile.useMask) {
    if (!profile.maskMapUrl) {
      throw new Error('full-inject: useMask requires offline maskMapUrl (no silent skip)');
    }
    if (typeof profile.maskMapSrgb !== 'boolean') {
      throw new Error('full-inject: useMask requires maskMapSrgb (no invent)');
    }
    mask = await loadCfxrTexture(profile.maskMapUrl, profile.maskMapSrgb, profile.maskSampler);
  }
  const orbWarp = profile.manualGraphLowering === 'orb-warp@1'
    || profile.manualGraphLowering === 'orb-warp-lit@1';
  if (profile.useDistortion || profile.mainUvTransform === 'trail-front-face@2' || orbWarp) {
    if (!profile.distortionMapUrl) {
      throw new Error(
        'full-inject: distortion/trail-front-face/orb-warp requires offline distortionMapUrl',
      );
    }
    if (typeof profile.distortionMapSrgb !== 'boolean') {
      throw new Error('full-inject: distortion path requires distortionMapSrgb (no invent)');
    }
    distortion = await loadCfxrTexture(
      profile.distortionMapUrl,
      profile.distortionMapSrgb,
      profile.distortionSampler,
    );
  }
  if (profile.manualGraphLowering === 'parallax-occlusion@1') {
    if (!profile.heightMapUrl) {
      throw new Error('full-inject: parallax-occlusion@1 requires offline heightMapUrl');
    }
    if (typeof profile.heightMapSrgb !== 'boolean') {
      throw new Error('full-inject: parallax-occlusion@1 requires heightMapSrgb (no invent)');
    }
    height = await loadCfxrTexture(
      profile.heightMapUrl, profile.heightMapSrgb, profile.heightSampler);
  } else if (profile.heightMapUrl) {
    if (typeof profile.heightMapSrgb !== 'boolean') {
      throw new Error('full-inject: heightMapUrl requires heightMapSrgb (no invent)');
    }
    height = await loadCfxrTexture(
      profile.heightMapUrl, profile.heightMapSrgb, profile.heightSampler);
  }
  if (orbWarp) {
    if (!profile.orbNoiseMapUrl) {
      throw new Error('full-inject: orb-warp requires offline orbNoiseMapUrl');
    }
    if (typeof profile.orbNoiseMapSrgb !== 'boolean') {
      throw new Error('full-inject: orb-warp requires orbNoiseMapSrgb (no invent)');
    }
    orbNoise = await loadCfxrTexture(
      profile.orbNoiseMapUrl, profile.orbNoiseMapSrgb, profile.orbNoiseSampler);
    if (profile.orbAlphaConstantOne === false && !profile.orbAlphaMapUrl) {
      throw new Error('full-inject: orbAlphaConstantOne=false requires offline orbAlphaMapUrl');
    }
    if (profile.orbAlphaMapUrl) {
      if (typeof profile.orbAlphaMapSrgb !== 'boolean') {
        throw new Error('full-inject: orbAlphaMapUrl requires orbAlphaMapSrgb (no invent)');
      }
      orbAlpha = await loadCfxrTexture(
        profile.orbAlphaMapUrl, profile.orbAlphaMapSrgb, profile.orbAlphaSampler);
    }
  }
  return { dissolve, mask, distortion, height, orbAlpha, orbNoise };
}

export function injectCfxrShader(
  mat: ShaderMaterial,
  profile: CfxrRuntimeProfile,
  maps: CfxrInjectMaps,
  options: CfxrInjectOptions,
): void {
  // When installFragment is false (qualified artifact-shader closures), keep
  // blend state, constant uniforms, and vertex stretch patches, but skip the
  // CFXR ubershader fragment — bindCompiledShaders supplies the offline one.
  // Live-bridge captures still embed CFXR_* sampling in the stamped fragment, so
  // aux maps + scene-input registration must run even when the body is offline.
  const installFragment = options.installFragment !== false;
  if (!installFragment) {
    applyArtifactSlimInject(mat, profile, options);
    if (options.captureOwned) {
      applyCfxrInjectUniforms(mat, profile, maps);
      registerCfxrSceneInputMaterial(mat);
    }
    return;
  }
  applyCfxrInjectDefines(mat, profile, maps);
  // The strict IR uses Unity Shader Graph's deterministic uint hash for Simple Noise.
  // WebGL2/GLSL3 is required; falling back to a sine hash changes authored pixels.
  mat.glslVersion = GLSL3;

  applyCfxrInjectUniforms(mat, profile, maps);

  applySemanticBlendState(mat, profile);
  const blendMode = resolveProfileBlendMode(profile);
  mat.transparent = blendMode !== 'opaque' && blendMode !== 'alpha-test';
  mat.depthWrite = resolveProfileDepthWrite(profile);
  // Ubershader path never tone-maps; bake/slim also stamp toneMapped=false.
  mat.toneMapped = CFXR_UBERSHADER_TONE_MAPPED;
  mat.side = resolveProfileDoubleSided(profile) ? DoubleSide : FrontSide;
  // Batch copies MeshBasicMaterial.alphaTest → USE_ALPHATEST; our fragment has no alphatest chunk.
  mat.alphaTest = blendMode === 'alpha-test'
    ? Math.max(CFXR_ALPHA_TEST_FLOOR, resolveProfileCutoff(profile))
    : CFXR_ALPHA_TEST_DISABLED;
  if (mat.defines) delete mat.defines.USE_ALPHATEST;

  // Bridge-full path: only claim artifact vertex authority when bag/pipeline
  // declared patches exist. Slim already hard-requires them; do not silently
  // preferArtifact→bridge invent here (frozen/legacy may lack bags).
  const preferArtifactVertex = options.policy.vertex === 'artifact'
    && !!options.declaredVertexPatches;
  const vertex = applyCfxrDualPathVertexPatches(
    mat.vertexShader,
    profile,
    options.declaredVertexPatches,
    preferArtifactVertex,
    { skipDivergenceAssert: !!options.captureOwned },
  );
  mat.vertexShader = vertex.vertexShader;
  (mat.userData as { cfxrInjectMode?: string }).cfxrInjectMode = 'bridge-full';

  mat.fragmentShader = CFXR_UBERSHADER_FRAGMENT;

  mat.needsUpdate = true;
  // Also owns deterministic material time (mask/dissolve scrolling), so every compiled
  // material participates even when it does not sample scene color/depth.
  registerCfxrSceneInputMaterial(mat);
}
