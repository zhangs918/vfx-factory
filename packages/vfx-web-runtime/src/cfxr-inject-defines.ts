/**
 * Build CFXR_* shader defines from a runtime profile (production ubershader inject).
 */
import type { ShaderMaterial, Texture } from 'three';
import type { CfxrRuntimeProfile } from './cfxr-material-profile';

export type CfxrInjectMaps = {
  dissolve: Texture | null;
  mask: Texture | null;
  distortion: Texture | null;
  height: Texture | null;
  orbAlpha: Texture | null;
  orbNoise: Texture | null;
};

export function applyCfxrInjectDefines(
  mat: ShaderMaterial,
  profile: CfxrRuntimeProfile,
  maps: CfxrInjectMaps,
): void {
  const defines: Record<string, string> = { ...((mat.defines ?? {}) as Record<string, string>) };
  delete defines.USE_COLOR_AS_ALPHA;
  if (profile.singleChannel) defines.CFXR_SINGLE_CHANNEL = '1';
  else delete defines.CFXR_SINGLE_CHANNEL;
  if (profile.singleChannel) {
    if (profile.coverageChannel !== 'luminance'
      && profile.coverageChannel !== 'red'
      && profile.coverageChannel !== 'green'
      && profile.coverageChannel !== 'alpha') {
      throw new Error('full-inject: singleChannel requires coverageChannel (no invent)');
    }
  }
  if (profile.coverageChannel === 'alpha') defines.CFXR_COVERAGE_ALPHA = '1';
  else delete defines.CFXR_COVERAGE_ALPHA;
  if (profile.coverageChannel === 'red') defines.CFXR_COVERAGE_RED = '1';
  else delete defines.CFXR_COVERAGE_RED;
  if (profile.coverageChannel === 'green') defines.CFXR_COVERAGE_GREEN = '1';
  else delete defines.CFXR_COVERAGE_GREEN;
  if (profile.legacyMultiplyColored) defines.CFXR_LEGACY_MULTIPLY_COLORED = '1';
  else delete defines.CFXR_LEGACY_MULTIPLY_COLORED;
  if (profile.legacyMultiply) defines.CFXR_LEGACY_MULTIPLY = '1';
  else delete defines.CFXR_LEGACY_MULTIPLY;
  if (profile.legacyPremultiply) defines.CFXR_LEGACY_PREMULTIPLY = '1';
  else delete defines.CFXR_LEGACY_PREMULTIPLY;
  if (profile.legacyDoubleTint) defines.CFXR_LEGACY_DOUBLE_TINT = '1';
  else delete defines.CFXR_LEGACY_DOUBLE_TINT;
  // Built-in legacy particle shaders consume the COLOR vertex attribute directly. In a Linear
  // project Unity does not apply an sRGB texture decode to vertex data; doing so here crushes
  // low-valued lifetime gradients while leaving white birth colors deceptively correct.
  if (profile.legacyVertexColorRaw)
    defines.CFXR_VERTEX_COLOR_RAW = '1';
  else delete defines.CFXR_VERTEX_COLOR_RAW;
  if (profile.mainUvTransform === 'shear-x-from-y') defines.CFXR_MAIN_UV_SHEAR = '1';
  else delete defines.CFXR_MAIN_UV_SHEAR;
  if (profile.mainUvTransform === 'offset-x-custom1-y') defines.CFXR_MAIN_UV_CUSTOM1_Y = '1';
  else delete defines.CFXR_MAIN_UV_CUSTOM1_Y;
  if (profile.mainUvTransform === 'offset-custom1-yx') defines.CFXR_MAIN_UV_CUSTOM1_YX = '1';
  else delete defines.CFXR_MAIN_UV_CUSTOM1_YX;
  if (profile.mainUvTransform === 'offset-y-custom1-y') defines.CFXR_MAIN_UV_Y_CUSTOM1_Y = '1';
  else delete defines.CFXR_MAIN_UV_Y_CUSTOM1_Y;
  if (profile.mainUvTransform === 'offset-uv1') defines.CFXR_MAIN_UV_OFFSET_UV1 = '1';
  else delete defines.CFXR_MAIN_UV_OFFSET_UV1;
  if (profile.mainUvTransform === 'trail-front-face@2') defines.CFXR_TRAIL_UV_V2 = '1';
  else delete defines.CFXR_TRAIL_UV_V2;
  if (profile.trailUvSpeedFromCustom2) defines.CFXR_TRAIL_SPEED_CUSTOM2 = '1';
  else delete defines.CFXR_TRAIL_SPEED_CUSTOM2;
  if (profile.flipX) defines.CFXR_FLIP_X = '1'; else delete defines.CFXR_FLIP_X;
  if (profile.flipY) defines.CFXR_FLIP_Y = '1'; else delete defines.CFXR_FLIP_Y;
  if (profile.dissolve) defines.CFXR_DISSOLVE = '1';
  else delete defines.CFXR_DISSOLVE;
  if (profile.dissolve) {
    if (typeof profile.invertDissolve !== 'boolean') {
      throw new Error('full-inject: dissolve requires invertDissolve (no invent)');
    }
    if (profile.invertDissolve) defines.CFXR_INVERT_DISSOLVE = '1';
    else delete defines.CFXR_INVERT_DISSOLVE;
  } else {
    delete defines.CFXR_INVERT_DISSOLVE;
  }
  if (profile.dissolveViaUvTile) defines.CFXR_DISSOLVE_UVTILE = '1';
  else delete defines.CFXR_DISSOLVE_UVTILE;
  if (profile.softFade) defines.CFXR_SOFT_FADE = '1';
  else delete defines.CFXR_SOFT_FADE;
  if (profile.dynamicAlphaClip) defines.CFXR_DYNAMIC_ALPHA_CLIP = '1';
  else delete defines.CFXR_DYNAMIC_ALPHA_CLIP;
  delete defines.CFXR_DYNAMIC_ALPHA_CLIP_Y;
  delete defines.CFXR_DYNAMIC_ALPHA_CLIP_Z;
  delete defines.CFXR_DYNAMIC_ALPHA_CLIP_W;
  delete defines.CFXR_DYNAMIC_ALPHA_CLIP_UV1_X;
  delete defines.CFXR_DYNAMIC_ALPHA_CLIP_UV1_Y;
  if (profile.dynamicAlphaClip) {
    if (profile.dynamicAlphaClipSource === 'custom1.y') defines.CFXR_DYNAMIC_ALPHA_CLIP_Y = '1';
    else if (profile.dynamicAlphaClipSource === 'custom1.z') defines.CFXR_DYNAMIC_ALPHA_CLIP_Z = '1';
    else if (profile.dynamicAlphaClipSource === 'custom1.w') defines.CFXR_DYNAMIC_ALPHA_CLIP_W = '1';
    else if (profile.dynamicAlphaClipSource === 'uv1.x') defines.CFXR_DYNAMIC_ALPHA_CLIP_UV1_X = '1';
    else if (profile.dynamicAlphaClipSource === 'uv1.y') defines.CFXR_DYNAMIC_ALPHA_CLIP_UV1_Y = '1';
    else {
      throw new Error(
        'full-inject: dynamicAlphaClip requires known dynamicAlphaClipSource (no invent)',
      );
    }
  }
  if (profile.useMask && maps.mask) defines.CFXR_MASK = '1';
  else delete defines.CFXR_MASK;
  if (profile.maskChannel === 'alpha') defines.CFXR_MASK_ALPHA = '1';
  else delete defines.CFXR_MASK_ALPHA;
  if (profile.maskWarp) defines.CFXR_MASK_WARP_SIMPLE_NOISE = '1';
  else delete defines.CFXR_MASK_WARP_SIMPLE_NOISE;
  if (profile.useDistortion) defines.CFXR_DISTORTION = '1';
  else delete defines.CFXR_DISTORTION;
  if (profile.backColorMul) defines.CFXR_FRONT_BACK = '1';
  else delete defines.CFXR_FRONT_BACK;
  if (profile.frontFaceColorSelect) defines.CFXR_FRONT_FACE_SELECT = '1';
  else delete defines.CFXR_FRONT_FACE_SELECT;
  if (profile.manualGraphLowering === 'trail-front-face@2')
    defines.CFXR_TRAIL_FRONT_FACE_V2 = '1';
  else delete defines.CFXR_TRAIL_FRONT_FACE_V2;
  if (profile.lightingModel === 'unity-urp-lit-reference@1')
    defines.CFXR_URP_LIT_REFERENCE = '1';
  else delete defines.CFXR_URP_LIT_REFERENCE;
  if (profile.manualGraphLowering === 'slash-world@3') defines.CFXR_SLASH_WORLD_V2 = '1';
  else delete defines.CFXR_SLASH_WORLD_V2;
  if (profile.manualGraphLowering === 'slash-screen@2') defines.CFXR_SLASH_SCREEN_V1 = '1';
  else delete defines.CFXR_SLASH_SCREEN_V1;
  if (profile.manualGraphLowering === 'slash-world@3' && profile.slashWorldVertexAlpha)
    defines.CFXR_SLASH_WORLD_VERTEX_ALPHA = '1';
  else delete defines.CFXR_SLASH_WORLD_VERTEX_ALPHA;
  if (profile.manualGraphLowering === 'parallax-occlusion@1' && maps.height)
    defines.CFXR_PARALLAX_OCCLUSION = '1';
  else delete defines.CFXR_PARALLAX_OCCLUSION;
  if ((profile.manualGraphLowering === 'orb-warp@1'
      || profile.manualGraphLowering === 'orb-warp-lit@1') && maps.orbNoise && maps.distortion)
    defines.CFXR_ORB_WARP_V1 = '1';
  else delete defines.CFXR_ORB_WARP_V1;
  if (profile.orbVertexAlphaChannel === 'green') defines.CFXR_ORB_ALPHA_GREEN = '1';
  else delete defines.CFXR_ORB_ALPHA_GREEN;
  if (maps.orbAlpha && !profile.orbAlphaConstantOne) defines.CFXR_ORB_ALPHA_TEXTURE = '1';
  else delete defines.CFXR_ORB_ALPHA_TEXTURE;
  defines.CFXR_FIDELITY = '1';
  mat.defines = defines;
}

