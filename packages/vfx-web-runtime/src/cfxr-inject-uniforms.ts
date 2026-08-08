/**
 * Production ubershader uniform wiring from CfxrRuntimeProfile + aux maps.
 * Thin ArtifactQuarksPlayer never enters this path.
 */
import { Vector2, Vector3, Vector4, type ShaderMaterial, type Texture } from 'three';
import { getCfxrEffectTime } from './cfxr-sim-initial';
import {
  getCfxrSharedSceneColor,
  getCfxrSharedSceneDepth,
} from './cfxr-scene-inputs';
import type { CfxrRuntimeProfile } from './cfxr-material-profile';
import type { CfxrInjectMaps } from './cfxr-inject-defines';

/** Host placeholders until SceneColorCapture overwrites cameraNear/Far. */
export const CFXR_CAMERA_NEAR_HOST_PLACEHOLDER = 0.1;
export const CFXR_CAMERA_FAR_HOST_PLACEHOLDER = 1000;
/** Host placeholder for sceneColorSize before a real capture target exists. */
export const CFXR_SCENE_COLOR_SIZE_HOST_PLACEHOLDER = 1;
/**
 * Pure-refraction sheets (hdr ≲ 1) keep this alpha floor until offline stamp.
 * Frozen-sensitive — do not change the numeric value without rebake evidence.
 */
export const CFXR_DISTORTION_ALPHA_FLOOR_WHEN_HDR_LE_1 = 0.55;
/** Off path when not (useDistortion && hdr ≲ threshold). */
export const CFXR_DISTORTION_ALPHA_FLOOR_OFF = 0;
/** HDR ≲ this uses the refraction alpha floor (frozen-sensitive threshold). */
export const CFXR_DISTORTION_HDR_FLOOR_THRESHOLD = 1.001;
/** Uniform identity when profile omits backColorMul (must not be written onto profile). */
export const CFXR_BACK_COLOR_MUL_IDENTITY: [number, number, number] = [1, 1, 1];
/** Uniform clamp floor for texPower/colorPower (props soft-invent 1 above this). */
export const CFXR_TEX_COLOR_POWER_UNIFORM_FLOOR = 0.01;

function requireNumber(label: string, value: number | undefined): number {
  if (typeof value !== 'number') {
    throw new Error(`full-inject: ${label} required (no invent)`);
  }
  return value;
}

function requireVec2(label: string, value: [number, number] | undefined): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`full-inject: ${label} required as [number, number] (no invent)`);
  }
  return value;
}

function requireVec3(label: string, value: [number, number, number] | undefined): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`full-inject: ${label} required as [number, number, number] (no invent)`);
  }
  return value;
}

function requireVec4(
  label: string,
  value: [number, number, number, number] | undefined,
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`full-inject: ${label} required as [number,number,number,number] (no invent)`);
  }
  return value;
}

export function applyCfxrInjectUniforms(
  mat: ShaderMaterial,
  profile: CfxrRuntimeProfile,
  maps: CfxrInjectMaps,
): void {
  mat.uniforms.hdrMultiply = { value: Math.max(0, requireNumber('hdr', profile.hdr)) };

  mat.uniforms.dissolveSmooth = { value: requireNumber('dissolveSmooth', profile.dissolveSmooth) };
  mat.uniforms.dissolveScroll = {
    value: new Vector2(...requireVec2('dissolveScroll', profile.dissolveScroll)),
  };
  mat.uniforms.dissolveMap = { value: maps.dissolve };

  mat.uniforms.maskMap = { value: maps.mask };
  mat.uniforms.maskSpeed = {
    value: new Vector2(...requireVec2('maskSpeed', profile.maskSpeed)),
  };
  mat.uniforms.maskRotation = { value: requireNumber('maskRotation', profile.maskRotation) };
  mat.uniforms.maskRotationCenter = {
    value: new Vector2(...requireVec2('maskRotationCenter', profile.maskRotationCenter)),
  };
  mat.uniforms.maskOffset = {
    value: new Vector2(...requireVec2('maskOffset', profile.maskOffset)),
  };
  mat.uniforms.maskNoiseScale = { value: requireNumber('maskNoiseScale', profile.maskNoiseScale) };

  mat.uniforms.trailUvRotation = {
    value: requireNumber('trailUvRotation', profile.trailUvRotation),
  };
  mat.uniforms.trailUvStretch = {
    value: requireNumber('trailUvStretch', profile.trailUvStretch),
  };
  mat.uniforms.trailUvScroll = {
    value: new Vector2(...requireVec2('trailUvScroll', profile.trailUvScroll)),
  };
  mat.uniforms.trailUvTiling = {
    value: new Vector2(...requireVec2('trailUvTiling', profile.trailUvTiling)),
  };
  mat.uniforms.trailUvOffset = {
    value: new Vector2(...requireVec2('trailUvOffset', profile.trailUvOffset)),
  };
  mat.uniforms.trailUvDistortionPower = {
    value: requireNumber('trailUvDistortionPower', profile.trailUvDistortionPower),
  };
  mat.uniforms.trailUvDistortionSpeed = {
    value: new Vector2(...requireVec2('trailUvDistortionSpeed', profile.trailUvDistortionSpeed)),
  };
  mat.uniforms.trailUvStretchY = { value: profile.trailUvStretchY ? 1 : 0 };

  mat.uniforms.effectTime = { value: getCfxrEffectTime() };
  mat.uniforms.distortionMap = { value: maps.distortion };
  mat.uniforms.distortionAmount = {
    value: requireNumber('distortionAmount', profile.distortionAmount),
  };
  mat.uniforms.slashWorldScreenOffset = {
    value: new Vector2(...requireVec2('slashWorldScreenOffset', profile.slashWorldScreenOffset)),
  };
  mat.uniforms.distortionAlphaFloor = {
    value: profile.useDistortion && requireNumber('hdr', profile.hdr) <= CFXR_DISTORTION_HDR_FLOOR_THRESHOLD
      ? CFXR_DISTORTION_ALPHA_FLOOR_WHEN_HDR_LE_1
      : CFXR_DISTORTION_ALPHA_FLOOR_OFF,
  };
  // Soft-invent onto profile in propsToProfile; never invent here.
  if (typeof profile.vertexColorRgb !== 'boolean' || typeof profile.vertexColorAlpha !== 'boolean') {
    throw new Error('full-inject: vertexColorRgb/Alpha required (no invent)');
  }
  mat.uniforms.vertColorRgbOn = { value: profile.vertexColorRgb ? 1 : 0 };
  mat.uniforms.vertColorAlphaOn = { value: profile.vertexColorAlpha ? 1 : 0 };
  mat.uniforms.vertColorGain = {
    value: requireNumber('legacyVertexColorGain', profile.legacyVertexColorGain),
  };
  mat.uniforms.backColorMul = {
    // Omit inventing onto profile — presence enables CFXR_FRONT_BACK.
    value: new Vector3(...(
      profile.backColorMul
        ? requireVec3('backColorMul', profile.backColorMul)
        : CFXR_BACK_COLOR_MUL_IDENTITY
    )),
  };
  mat.uniforms.heightMap = { value: maps.height };

  mat.uniforms.parallaxAmplitude = {
    value: requireNumber('parallaxAmplitude', profile.parallaxAmplitude),
  };

  mat.uniforms.orbAlphaMap = { value: maps.orbAlpha };
  mat.uniforms.orbNoiseMap = { value: maps.orbNoise };
  mat.uniforms.orbColour = {
    value: new Vector3(...requireVec3('orbColour', profile.orbColour)),
  };
  mat.uniforms.orbFresnelColor = {
    value: new Vector4(...requireVec4('orbFresnelColor', profile.orbFresnelColor)),
  };
  mat.uniforms.orbNoiseAnimation = {
    value: new Vector2(...requireVec2('orbNoiseAnimation', profile.orbNoiseAnimation)),
  };
  mat.uniforms.orbWarpSpeed = {
    value: new Vector2(...requireVec2('orbWarpSpeed', profile.orbWarpSpeed)),
  };
  mat.uniforms.orbFresnelPower = {
    value: requireNumber('orbFresnelPower', profile.orbFresnelPower),
  };
  mat.uniforms.orbNoiseScale = { value: requireNumber('orbNoiseScale', profile.orbNoiseScale) };
  mat.uniforms.orbNoiseFrequency = {
    value: requireNumber('orbNoiseFrequency', profile.orbNoiseFrequency),
  };
  mat.uniforms.orbNoiseAmplitude = {
    value: requireNumber('orbNoiseAmplitude', profile.orbNoiseAmplitude),
  };
  mat.uniforms.orbOctaveFrequencyScale = {
    value: requireNumber('orbOctaveFrequencyScale', profile.orbOctaveFrequencyScale),
  };
  mat.uniforms.orbOctaveAmplitudeScale = {
    value: requireNumber('orbOctaveAmplitudeScale', profile.orbOctaveAmplitudeScale),
  };
  mat.uniforms.orbOctaveDomainWarping = {
    value: requireNumber('orbOctaveDomainWarping', profile.orbOctaveDomainWarping),
  };
  mat.uniforms.orbNoisePower = { value: requireNumber('orbNoisePower', profile.orbNoisePower) };
  mat.uniforms.orbUvClipScale = {
    value: requireNumber('orbUvClipScale', profile.orbUvClipScale),
  };

  const sceneColor = getCfxrSharedSceneColor();
  const sceneDepth = getCfxrSharedSceneDepth();
  mat.uniforms.sceneColorMap = { value: sceneColor };
  mat.uniforms.sceneDepthMap = { value: sceneDepth };
  mat.uniforms.sceneColorSize = {
    value: new Vector3(
      (sceneColor as { image?: { width?: number; height?: number } } | null)?.image?.width
        || CFXR_SCENE_COLOR_SIZE_HOST_PLACEHOLDER,
      (sceneColor as { image?: { height?: number; width?: number } } | null)?.image?.height
        || CFXR_SCENE_COLOR_SIZE_HOST_PLACEHOLDER,
      0,
    ),
  };
  mat.uniforms.softFadeAmount = { value: profile.softFade ? 1 : 0 };
  mat.uniforms.softParticleStrength = {
    value: requireNumber('softParticleStrength', profile.softParticleStrength),
  };
  // Host placeholders until SceneColorCapture binds the camera (named, not silent invent).
  mat.uniforms.cameraNear = { value: CFXR_CAMERA_NEAR_HOST_PLACEHOLDER };
  mat.uniforms.cameraFar = { value: CFXR_CAMERA_FAR_HOST_PLACEHOLDER };
  // Zero is meaningful for a material-less Unity renderer compiled as simulation-only.
  mat.uniforms.opacityGain = { value: Math.max(0, requireNumber('opacity', profile.opacity)) };
  mat.uniforms.legacyAlphaTintFactor = {
    value: Math.max(0, requireNumber('legacyAlphaTintFactor', profile.legacyAlphaTintFactor)),
  };
  mat.uniforms.alphaClipThreshold = {
    value: Math.max(0, Math.min(1, requireNumber('alphaClipThreshold', profile.alphaClipThreshold))),
  };
  mat.uniforms.dynamicAlphaClipScale = {
    value: requireNumber('dynamicAlphaClipScale', profile.dynamicAlphaClipScale),
  };
  // texPower/colorPower: propsToProfile always writes (soft 1 when unauthored); no inject invent.
  mat.uniforms.texPower = {
    value: Math.max(CFXR_TEX_COLOR_POWER_UNIFORM_FLOOR, requireNumber('texPower', profile.texPower)),
  };
  mat.uniforms.colorPower = {
    value: Math.max(CFXR_TEX_COLOR_POWER_UNIFORM_FLOOR, requireNumber('colorPower', profile.colorPower)),
  };
  mat.uniforms.materialColor = {
    value: new Vector3(...requireVec3('colorMul', profile.colorMul)),
  };
  mat.uniforms.ambientSky = {
    value: new Vector3(...requireVec3('ambientSky', profile.ambientSky)),
  };
  mat.uniforms.ambientEquator = {
    value: new Vector3(...requireVec3('ambientEquator', profile.ambientEquator)),
  };
  mat.uniforms.ambientGround = {
    value: new Vector3(...requireVec3('ambientGround', profile.ambientGround)),
  };
  if (!Array.isArray(profile.ambientSH) || profile.ambientSH.length !== 9) {
    throw new Error('full-inject: ambientSH[9] required (no invent)');
  }
  mat.uniforms.ambientSH = {
    value: profile.ambientSH.map((coefficient) => new Vector3(...coefficient)),
  };
  if (!profile.tileCounts) {
    throw new Error('full-inject: missing offline profile.tileCounts');
  }
  mat.uniforms.tileCounts = { value: new Vector2(...profile.tileCounts) };
}
