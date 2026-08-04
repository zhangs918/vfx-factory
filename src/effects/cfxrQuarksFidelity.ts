/**
 * Generic CFXR / Cartoon-FX Remaster fidelity layer for Unity→Quarks WebGL playback.
 *
 * Mechanism (not per-effect cases):
 * 1. Require the exporter-authored `particle-material-program@2`
 * 2. Drive the SpriteBatch shader only from explicit program fields
 * 3. Reject missing resources instead of synthesizing visual fallbacks
 * 4. Bridge explicitly declared simulation semantics omitted by Quarks
 */
import {
  AdditiveBlending,
  AddEquation,
  Color,
  DataTexture,
  DynamicDrawUsage,
  DoubleSide,
  FrontSide,
  GLSL3,
  InstancedBufferAttribute,
  MeshBasicMaterial,
  NoColorSpace,
  NormalBlending,
  CustomBlending,
  DstColorFactor,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PointLight,
  RGBAFormat,
  ShaderMaterial,
  SRGBColorSpace,
  SrcColorFactor,
  TextureLoader,
  Vector2,
  Vector3,
  Vector4,
  ZeroFactor,
  type Material,
  type Object3D,
  type Texture,
} from 'three';

import adapterRegistry from '../../config/semantic-adapters.json';

type TextureSamplerSpec = {
  wrap?: [number, number];
  magFilter?: number;
  minFilter?: number;
};
import {
  BatchedRenderer,
  ParticleSystem,
  RenderMode,
  type Behavior,
  type Particle,
  type ParticleEmitter,
} from 'three.quarks';
import {
  ColorGeneratorFromJSON,
  Quaternion as QuarksQuaternion,
  ValueGeneratorFromJSON,
  Vector4 as CoreVector4,
  Euler as QuarksEuler,
  Vector3 as QuarksVector3,
  Vector4 as QuarksVector4,
  type IParticleSystem,
  type FunctionValueGenerator,
  type GeneratorMemory,
} from 'quarks.core';

/** Serialized on each Quarks material (exporter / inject script). */
export interface CfxrMaterialProps {
  shader?: string;
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
  lightingModel?: 'unity-urp-lit-reference@1';
  ambientSky: [number, number, number];
  ambientEquator: [number, number, number];
  ambientGround: [number, number, number];
  ambientSH: Array<[number, number, number]>;
  doubleSided: boolean;
  hdr: number;
  singleChannel: boolean;
  coverageChannel: 'luminance' | 'red' | 'green' | 'alpha';
  mainUvTransform: NonNullable<CfxrMaterialProps['mainUvTransform']>;
  trailUvRotation: number;
  trailUvStretch: number;
  trailUvStretchY: boolean;
  trailUvSpeedFromCustom2: boolean;
  trailUvScroll: [number, number];
  trailUvTiling: [number, number];
  trailUvOffset: [number, number];
  trailUvDistortionPower: number;
  trailUvDistortionSpeed: [number, number];
  manualGraphLowering?: CfxrMaterialProps['manualGraphLowering'];
  frontFaceColorSelect: boolean;
  slashWorldVertexAlpha: boolean;
  heightMapUrl?: string;
  heightMapSrgb: boolean;
  heightSampler?: TextureSamplerSpec;
  parallaxAmplitude: number;
  flipX: boolean;
  flipY: boolean;
  tileCounts: [number, number];
  /** Unity stretched billboards use the particle position as the quad center. */
  unityCenteredStretch: boolean;
  /** Unity VerticalBillboard uses its normalized upright quad basis. */
  unityVerticalBillboard: boolean;
  mainMapSrgb: boolean;
  alphaClipThreshold: number;
  dynamicAlphaClip: boolean;
  dynamicAlphaClipSource: NonNullable<CfxrMaterialProps['dynamicAlphaClipSource']>;
  dynamicAlphaClipScale: number;
  dissolve: boolean;
  /** Mesh particles: dissolve time rides `uvTile` (size.z is geometry scale). */
  dissolveViaUvTile: boolean;
  dissolveSmooth: number;
  dissolveScroll: [number, number];
  /** True when Unity would invert dissolve tex (`_InvertDissolveTex <= 0`). */
  invertDissolve: boolean;
  colorMul: [number, number, number];
  softFade: boolean;
  softParticleStrength: number;
  additive: boolean;
  legacyMultiplyColored: boolean;
  legacyMultiply: boolean;
  legacyPremultiply: boolean;
  legacyDoubleTint: boolean;
  legacyVertexColorRaw: boolean;
  legacyVertexColorGain: number;
  legacyAlphaTintFactor: number;
  proceduralRing: boolean;
  ringTopOffset: number;
  dissolveMapUrl?: string;
  vertexColorRgb: boolean;
  vertexColorAlpha: boolean;
  /** Trail-family graphs: rgb = lerp(backColor, frontColor, texLum). */
  backColorMul?: [number, number, number];
  useMask: boolean;
  maskMapUrl?: string;
  maskMapSrgb: boolean;
  maskSampler?: TextureSamplerSpec;
  maskChannel: 'red' | 'alpha';
  maskWarp: boolean;
  maskNoiseScale: number;
  maskSpeed: [number, number];
  maskRotation: number;
  maskRotationCenter: [number, number];
  maskOffset: [number, number];
  useDistortion: boolean;
  sceneColor: boolean;
  distortionMapUrl?: string;
  distortionMapSrgb: boolean;
  dissolveMapSrgb: boolean;
  distortionSampler?: TextureSamplerSpec;
  dissolveSampler?: TextureSamplerSpec;
  distortionAmount: number;
  slashWorldScreenOffset: [number, number];
  opacity: number;
  texPower: number;
  colorPower: number;
  orbAlphaMapUrl?: string;
  orbAlphaMapSrgb: boolean;
  orbAlphaConstantOne: boolean;
  orbAlphaSampler?: TextureSamplerSpec;
  orbNoiseMapUrl?: string;
  orbNoiseMapSrgb: boolean;
  orbNoiseSampler?: TextureSamplerSpec;
  orbColour: [number, number, number];
  orbFresnelColor: [number, number, number, number];
  orbNoiseAnimation: [number, number];
  orbWarpSpeed: [number, number];
  orbFresnelPower: number;
  orbNoiseScale: number;
  orbNoiseFrequency: number;
  orbNoiseAmplitude: number;
  orbOctaveFrequencyScale: number;
  orbOctaveAmplitudeScale: number;
  orbOctaveDomainWarping: number;
  orbNoisePower: number;
  orbUvClipScale: number;
  orbVertexAlphaChannel: 'alpha' | 'green';
}

function propsToProfile(props: CfxrMaterialProps): CfxrRuntimeProfile {
  const color = props.frontColor ?? props.color ?? [1, 1, 1, 1];
  const dissolve = !!props.useDissolve;
  // CFXR default: InvertDissolveTex=0 → invert. Only skip invert when explicitly false.
  const invertDissolve =
    props.invertDissolve !== undefined ? !!props.invertDissolve : dissolve;
  return {
    lightingModel: props.lightingModel,
    ambientSky: props.ambientSky ?? [1, 1, 1],
    ambientEquator: props.ambientEquator ?? [1, 1, 1],
    ambientGround: props.ambientGround ?? [1, 1, 1],
    ambientSH: props.ambientSH?.length === 9
      ? props.ambientSH : Array.from({ length: 9 }, () => [0, 0, 0]),
    doubleSided: props.doubleSided ?? true,
    hdr: props.hdrMultiply ?? 0,
    singleChannel: props.singleChannel ?? false,
    coverageChannel: props.coverageChannel ?? 'luminance',
    mainUvTransform: props.mainUvTransform ?? 'identity',
    trailUvRotation: props.trailUvRotation ?? 0,
    trailUvStretch: props.trailUvStretch ?? 0,
    trailUvStretchY: !!props.trailUvStretchY,
    trailUvSpeedFromCustom2: !!props.trailUvSpeedFromCustom2,
    trailUvScroll: props.trailUvScroll ?? [0, 0],
    trailUvTiling: props.trailUvTiling ?? [1, 1],
    trailUvOffset: props.trailUvOffset ?? [0, 0],
    trailUvDistortionPower: props.trailUvDistortionPower ?? 0,
    trailUvDistortionSpeed: props.trailUvDistortionSpeed ?? [0, 0],
    manualGraphLowering: props.manualGraphLowering,
    frontFaceColorSelect: !!props.frontFaceColorSelect,
    slashWorldVertexAlpha: !!props.slashWorldVertexAlpha,
    heightMapUrl: props.heightMapUrl,
    heightMapSrgb: props.heightMapSrgb ?? false,
    heightSampler: props.heightSampler,
    parallaxAmplitude: props.parallaxAmplitude ?? 0,
    flipX: !!props.flipX,
    flipY: !!props.flipY,
    tileCounts: [1, 1],
    unityCenteredStretch: false,
    unityVerticalBillboard: false,
    mainMapSrgb: props.mainMapSrgb ?? true,
    alphaClipThreshold: props.alphaClipThreshold ?? 0,
    dynamicAlphaClip: !!props.dynamicAlphaClip,
    dynamicAlphaClipSource: props.dynamicAlphaClipSource ?? 'custom1.x',
    dynamicAlphaClipScale: props.dynamicAlphaClipScale ?? 1,
    dissolve,
    dissolveViaUvTile: false,
    dissolveSmooth: props.dissolveSmooth ?? 0.15,
    dissolveScroll: props.dissolveScroll ?? [0, 0],
    invertDissolve,
    colorMul: [color[0], color[1], color[2]],
    softFade: !!props.fading,
    softParticleStrength: Math.max(
      0.001,
      (props.softParticle ?? 1) * (props.softParticleDepthScale ?? 1),
    ),
    additive: !!props.additive,
    legacyMultiplyColored: !!props.legacyMultiplyColored,
    legacyMultiply: !!props.legacyMultiply,
    legacyPremultiply: !!props.legacyPremultiply,
    legacyDoubleTint: !!props.legacyDoubleTint,
    legacyVertexColorRaw: !!props.legacyVertexColorRaw,
    legacyVertexColorGain: props.legacyVertexColorGain ?? 1,
    legacyAlphaTintFactor: props.legacyAlphaTintFactor ?? 2,
    proceduralRing: !!props.proceduralRing,
    ringTopOffset: props.ringTopOffset ?? 0.07,
    dissolveMapUrl:
      props.dissolveMapUrl ||
      (props.dissolveTextureName
        ? `/assets/quarks/${dissolveFileName(props.dissolveTextureName)}`
        : undefined),
    vertexColorRgb: props.vertexColorRgb ?? true,
    vertexColorAlpha: props.vertexColorAlpha ?? true,
    backColorMul:
      props.frontColor && props.backColor
        ? [props.backColor[0], props.backColor[1], props.backColor[2]]
        : undefined,
    useMask: !!props.useMask && !!(props.maskMapUrl || props.maskMap),
    maskMapUrl: props.maskMapUrl,
    maskMapSrgb: props.maskMapSrgb ?? false,
    maskSampler: props.maskSampler,
    maskChannel: props.maskChannel ?? 'red',
    maskWarp: props.maskWarp === 'simple-noise-product',
    maskNoiseScale: props.maskNoiseScale ?? 1,
    maskSpeed: props.maskSpeed ?? [0, 0],
    maskRotation: props.maskRotation ?? 0,
    maskRotationCenter: props.maskRotationCenter ?? [0.5, 0.5],
    maskOffset: props.maskOffset ?? [0, 0],
    useDistortion: !!props.useDistortion,
    sceneColor: !!props.sceneColor,
    distortionMapUrl: props.distortionMapUrl,
    distortionMapSrgb: props.distortionMapSrgb ?? false,
    distortionSampler: props.distortionSampler,
    dissolveMapSrgb: props.dissolveMapSrgb ?? false,
    dissolveSampler: props.dissolveSampler,
    distortionAmount: props.distortionAmount ?? 0.02,
    slashWorldScreenOffset: props.slashWorldScreenOffset ?? [0, 0],
    opacity: props.opacity ?? 1,
    texPower: props.texPower ?? 1,
    colorPower: props.colorPower ?? 1,
    orbAlphaMapUrl: props.orbAlphaMapUrl,
    orbAlphaMapSrgb: props.orbAlphaMapSrgb ?? false,
    orbAlphaConstantOne: props.orbAlphaConstantOne ?? !props.orbAlphaMap,
    orbAlphaSampler: props.orbAlphaSampler,
    orbNoiseMapUrl: props.orbNoiseMapUrl,
    orbNoiseMapSrgb: props.orbNoiseMapSrgb ?? false,
    orbNoiseSampler: props.orbNoiseSampler,
    orbColour: props.orbColour ?? [1, 1, 1],
    orbFresnelColor: props.orbFresnelColor ?? [1, 1, 1, 0],
    orbNoiseAnimation: props.orbNoiseAnimation ?? [0, 0],
    orbWarpSpeed: props.orbWarpSpeed ?? [0, 0],
    orbFresnelPower: props.orbFresnelPower ?? 1,
    orbNoiseScale: props.orbNoiseScale ?? 1,
    orbNoiseFrequency: props.orbNoiseFrequency ?? 1,
    orbNoiseAmplitude: props.orbNoiseAmplitude ?? 1,
    orbOctaveFrequencyScale: props.orbOctaveFrequencyScale ?? 2,
    orbOctaveAmplitudeScale: props.orbOctaveAmplitudeScale ?? 0.5,
    orbOctaveDomainWarping: props.orbOctaveDomainWarping ?? 1,
    orbNoisePower: props.orbNoisePower ?? 1,
    orbUvClipScale: props.orbUvClipScale ?? 0,
    orbVertexAlphaChannel: props.orbVertexAlphaChannel ?? 'alpha',
  };
}

function semanticBlending(profile: CfxrRuntimeProfile) {
  return profile.additive ? AdditiveBlending : NormalBlending;
}

function applySemanticBlendState(mat: Material, profile: CfxrRuntimeProfile) {
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
    mat.premultipliedAlpha = false;
  }
}

function dissolveFileName(name: string) {
  // Unity: "cfxr smoke cloud x4 dissolve" → public file we ship or user copies
  const base = name.replace(/\.(png|jpg|jpeg|tga)$/i, '');
  return `${base.replace(/\s+/g, '_').toLowerCase()}.png`;
}

let softRingTex: DataTexture | null = null;
/** Thin annulus approximating CFXR procedural ring (subtle ground flash, not a heavy decal). */
function getSoftRingTexture(ringTop = 0.07) {
  if (softRingTex) return softRingTex;
  const s = 128;
  const data = new Uint8Array(s * s * 4);
  // ringTop ~0.07 → outer rim near unit circle; keep a thin band
  const top = Math.min(0.98, 0.92 + ringTop);
  const inner = top - 0.14;
  const smooth = 0.06;
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
      data[i + 3] = Math.round(Math.pow(ring, 1.8) * 140);
    }
  }
  softRingTex = new DataTexture(data, s, s, RGBAFormat);
  softRingTex.colorSpace = NoColorSpace;
  softRingTex.needsUpdate = true;
  softRingTex.name = 'cfxr_proc_ring';
  return softRingTex;
}

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Expand zero-width Unity CFXR ring ribbons into an annulus (geometry-level, any effect). */
export function expandCfxrRingGeometry(json: any) {
  if (!Array.isArray(json.geometries)) return;
  for (const g of json.geometries) {
    const positions: number[] = g.positions ?? g.data?.attributes?.position?.array;
    const uvs: number[] = g.uvs ?? g.data?.attributes?.uv?.array;
    if (!positions || !uvs || positions.length < 9) continue;
    let rSum = 0;
    let n = 0;
    for (let i = 0; i < positions.length; i += 3) {
      rSum += Math.hypot(positions[i], positions[i + 1]);
      n++;
    }
    const rAvg = rSum / n;
    if (rAvg < 0.85 || rAvg > 1.15) continue;
    const ringWidth = 0.42;
    for (let vi = 0; vi < n; vi++) {
      const px = positions[vi * 3];
      const py = positions[vi * 3 + 1];
      const len = Math.hypot(px, py) || 1;
      const v = uvs[vi * 2 + 1] ?? 0;
      const r = 1 - v * ringWidth;
      positions[vi * 3] = (px / len) * r;
      positions[vi * 3 + 1] = (py / len) * r;
    }
  }
}

/** Unity's ParticleSystem vertex Color stream is Color32 (UNorm8), not four floats. */
class UnityColor32Behavior implements Behavior {
  type = 'UnityColor32';
  private quantize(particle: Particle) {
    particle.color.x = Math.round(Math.max(0, Math.min(1, particle.color.x)) * 255) / 255;
    particle.color.y = Math.round(Math.max(0, Math.min(1, particle.color.y)) * 255) / 255;
    particle.color.z = Math.round(Math.max(0, Math.min(1, particle.color.z)) * 255) / 255;
    particle.color.w = Math.round(Math.max(0, Math.min(1, particle.color.w)) * 255) / 255;
  }
  initialize(particle: Particle): void { this.quantize(particle); }
  update(particle: Particle): void { this.quantize(particle); }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityColor32Behavior(); }
  reset(): void {}
}

type UnitySemanticParticle = Particle & {
  unityCustom1?: [number, number, number, number];
  unityCustom2?: [number, number, number, number];
  unitySeed?: number;
  unityParticleId?: string;
  unitySizeCurveLerp?: number;
  unityRotationCurveLerp?: [number, number, number];
  unityRotationEuler?: [number, number, number];
  unityRotationBase?: QuarksQuaternion;
  unityGlobalSpawnTime?: number;
  unitySpawnAgeOffset?: number;
  unityBeforeGlobalSpawn?: boolean;
  unityTrajectoryEnded?: boolean;
  unityRendererFlip?: [boolean, boolean];
};
type UnityCustom1Particle = UnitySemanticParticle;

interface UnityTwoCurvesSpec {
  type: 'UnityTwoCurves@1';
  min: any;
  max: any;
  randomLane: string;
}

/** Unity MinMaxCurve.TwoCurves: one random interpolation factor is retained for the particle. */
class UnityTwoCurvesGenerator implements FunctionValueGenerator {
  readonly type = 'function' as const;
  private indexCount = -1;
  constructor(private readonly spec: UnityTwoCurvesSpec) {}
  startGen(memory: GeneratorMemory) {
    this.indexCount = memory.length;
    memory.push(Math.random());
  }
  genValue(memory: GeneratorMemory, t: number): number {
    if (this.indexCount < 0) this.startGen(memory);
    const factor = Number(memory[this.indexCount] ?? 0);
    const min = samplePiecewiseOrLinear(this.spec.min, t);
    const max = samplePiecewiseOrLinear(this.spec.max, t);
    return min + (max - min) * factor;
  }
  toJSON() { return this.spec as any; }
  clone() { return new UnityTwoCurvesGenerator(this.spec); }
}

function semanticRandom01(seed: number, lane: string): number {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < lane.length; i++) h = Math.imul(h ^ lane.charCodeAt(i), 0x85ebca6b);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return (h >>> 0) / 0x100000000;
}

function sampleSemanticCurve(spec: any, t: number, particle: UnitySemanticParticle): number {
  if (spec?.type !== 'UnityTwoCurves@1') return samplePiecewiseOrLinear(spec, t);
  const factor = spec.randomLane === 'sizeOverLifetime.scalar'
    && particle.unitySizeCurveLerp != null
    ? particle.unitySizeCurveLerp
    : String(spec.randomLane ?? '').startsWith('rotationOverLifetime.')
      && particle.unityRotationCurveLerp
      ? particle.unityRotationCurveLerp[spec.randomLane.endsWith('.x') ? 0 : spec.randomLane.endsWith('.y') ? 1 : 2]
      : semanticRandom01(particle.unitySeed ?? 1, String(spec.randomLane ?? 'default'));
  const min = samplePiecewiseOrLinear(spec.min, t);
  const max = samplePiecewiseOrLinear(spec.max, t);
  return min + (max - min) * factor;
}

class UnitySizeTwoCurvesBehavior implements Behavior {
  type = 'UnitySizeTwoCurves';
  constructor(private spec: UnityTwoCurvesSpec) {}
  initialize(): void {}
  update(particle: Particle, delta: number): void {
    const p = particle as UnitySemanticParticle;
    const t = Math.max(0, Math.min(1, p.age / Math.max(1e-5, p.life)));
    p.size.copy(p.startSize).multiplyScalar(sampleSemanticCurve(this.spec, t, p));
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnitySizeTwoCurvesBehavior(this.spec); }
  reset(): void {}
}

class UnitySizeOverLifetimeBehavior implements Behavior {
  type = 'UnitySizeOverLifetime';
  constructor(private readonly spec: UnitySizeOverLifetimeSpec) {}
  initialize(): void {}
  update(particle: Particle): void {
    const t = Math.max(0, Math.min(1, particle.age / Math.max(1e-5, particle.life)));
    particle.size.copy(particle.startSize).multiplyScalar(
      samplePiecewiseOrLinear(this.spec.curve, t),
    );
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnitySizeOverLifetimeBehavior(this.spec); }
  reset(): void {}
}

interface UnityLimitVelocity3DSpec {
  schema: 'unity-limit-velocity-3d@1';
  x: any; y: any; z: any;
  dampen: number;
  space: 'local';
}

interface UnityLimitVelocitySpec {
  schema: 'unity-limit-velocity@1';
  speed: any;
  dampen: number;
}

class UnityLimitVelocityBehavior implements Behavior {
  type = 'UnityLimitVelocity';
  constructor(private readonly spec: UnityLimitVelocitySpec) {}
  initialize(): void {}
  update(particle: Particle, delta: number): void {
    const velocity = particle.velocity;
    const current = velocity.length();
    const t = Math.max(0, Math.min(1, particle.age / Math.max(1e-5, particle.life)));
    const limit = Math.max(0, samplePiecewiseOrLinear(this.spec.speed, t));
    if (current <= limit || current <= 1e-8) return;
    // Unity normalizes this legacy module's damping response to a 30 Hz simulation clock.
    // Keep the authored response invariant when the Web player advances with another fixed dt.
    const authoredDampen = Math.max(0, Math.min(1, this.spec.dampen));
    const dampen = 1 - Math.pow(1 - authoredDampen, Math.max(0, delta) * 30);
    const targetScale = limit / current;
    velocity.multiplyScalar(1 + (targetScale - 1) * dampen);
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityLimitVelocityBehavior(this.spec); }
  reset(): void {}
}

class UnityLimitVelocity3DBehavior implements Behavior {
  type = 'UnityLimitVelocity3D';
  constructor(private readonly spec: UnityLimitVelocity3DSpec) {}
  initialize(): void {}
  update(particle: Particle): void {
    const t = Math.max(0, Math.min(1, particle.age / Math.max(1e-5, particle.life)));
    const limits = [this.spec.x, this.spec.y, this.spec.z].map((curve) =>
      Math.max(0, samplePiecewiseOrLinear(curve, t)));
    const velocity = particle.velocity;
    const values = [velocity.x, velocity.y, velocity.z];
    const dampen = Math.max(0, Math.min(1, this.spec.dampen));
    for (let axis = 0; axis < 3; axis++) {
      const current = values[axis];
      const limit = limits[axis];
      if (Math.abs(current) > limit)
        values[axis] = current + (Math.sign(current) * limit - current) * dampen;
    }
    velocity.set(values[0], values[1], values[2]);
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityLimitVelocity3DBehavior(this.spec); }
  reset(): void {}
}

interface UnityVelocityOverLifetimeSpec {
  schema: 'unity-velocity-over-lifetime@1';
  linearX: any; linearY: any; linearZ: any;
  space: 'local' | 'world';
}

class UnityVelocityOverLifetimeBehavior implements Behavior {
  type = 'UnityVelocityOverLifetime';
  private states = new WeakMap<object, { factors: number[]; offset: QuarksVector3 }>();
  private ps?: IParticleSystem;
  private rotation = new QuarksQuaternion();
  private scale = new QuarksVector3(1, 1, 1);
  private scratch = new QuarksVector3();
  constructor(private readonly spec: UnityVelocityOverLifetimeSpec) {}
  initialize(particle: Particle, system: IParticleSystem): void {
    this.ps = system;
    const curves = [this.spec.linearX, this.spec.linearY, this.spec.linearZ];
    this.states.set(particle as object, {
      factors: curves.map((curve) => curve?.type === 'UnityTwoCurves@1' ? Math.random() : 0),
      offset: new QuarksVector3(),
    });
  }
  private sample(curve: any, t: number, factor: number): number {
    if (curve?.type !== 'UnityTwoCurves@1') return samplePiecewiseOrLinear(curve, t);
    const min = samplePiecewiseOrLinear(curve.min, t);
    const max = samplePiecewiseOrLinear(curve.max, t);
    return min + (max - min) * factor;
  }
  frameUpdate(): void {
    const emitter = (this.ps as any)?.emitter;
    if (!emitter) return;
    emitter.matrixWorld.decompose(this.scratch, this.rotation, this.scale);
  }
  update(particle: Particle): void {
    const state = this.states.get(particle as object);
    if (!state) return;
    const t = Math.max(0, Math.min(1, particle.age / Math.max(1e-5, particle.life)));
    const next = this.scratch.set(
      this.sample(this.spec.linearX, t, state.factors[0]),
      this.sample(this.spec.linearY, t, state.factors[1]),
      // Unity LH -> Web RH vector reflection.
      -this.sample(this.spec.linearZ, t, state.factors[2]),
    );
    const systemWorld = !!this.ps?.worldSpace;
    if (this.spec.space === 'local' && systemWorld) next.multiply(this.scale).applyQuaternion(this.rotation);
    else if (this.spec.space === 'world' && !systemWorld) {
      next.applyQuaternion(this.rotation.clone().invert());
      next.set(next.x / this.scale.x, next.y / this.scale.y, next.z / this.scale.z);
    }
    particle.velocity.sub(state.offset).add(next);
    state.offset.copy(next);
  }
  toJSON() { return { type: this.type }; }
  clone() { return new UnityVelocityOverLifetimeBehavior(this.spec); }
  // System loop resets emission generators while particles from the previous cycle remain
  // alive. Their velocity offset state must survive; initialize() overwrites it when a pooled
  // particle is genuinely reused.
  reset(): void {}
}

interface UnityRotation3DSpec { x: any; y: any; z: any }

/** Integrates Unity separate-axis angular velocity on mesh-particle quaternions. */
class UnityRotation3DBehavior implements Behavior {
  type = 'UnityRotationOverLifetime3D';
  constructor(private spec: UnityRotation3DSpec) {}
  initialize(): void {}
  update(particle: Particle, delta: number): void {
    const rotation = particle.rotation;
    if (delta === 0 || typeof rotation === 'number' || !rotation) return;
    const p = particle as UnitySemanticParticle;
    const t = Math.max(0, Math.min(1, p.age / Math.max(1e-5, p.life)));
    // Unity left-handed angular vector -> right-handed quaternion coordinates.
    const x = -sampleSemanticCurve(this.spec.x, t, p) * delta;
    const y = -sampleSemanticCurve(this.spec.y, t, p) * delta;
    const z = sampleSemanticCurve(this.spec.z, t, p) * delta;
    const euler = p.unityRotationEuler ?? [0, 0, 0];
    euler[0] += x;
    euler[1] += y;
    euler[2] += z;
    p.unityRotationEuler = euler;
    // Unity stores independent Euler channels and reconstructs with intrinsic ZXY. The
    // equivalent quarks/three order is YXZ after the LH→RH axis reflection.
    const local = new QuarksQuaternion()
      .setFromEuler(new QuarksEuler(euler[0], euler[1], euler[2], 'YXZ'))
      .normalize();
    if (p.unityRotationBase) rotation.copy(p.unityRotationBase).multiply(local).normalize();
    else rotation.copy(local);
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityRotation3DBehavior(this.spec); }
  reset(): void {}
}

/** Exact Unity Custom1 vertex stream: four independent lifetime curves per particle. */
class UnityCustom1Behavior implements Behavior {
  type = 'UnityCustom1';
  constructor(private curves: [any, any, any, any]) {}
  private apply(particle: UnityCustom1Particle) {
    const t = Math.max(0, Math.min(1, particle.age / Math.max(1e-5, particle.life)));
    particle.unityCustom1 = this.curves.map((curve) => samplePiecewiseOrLinear(curve, t)) as [number, number, number, number];
  }
  initialize(particle: Particle): void { this.apply(particle); }
  update(particle: Particle, delta: number): void {
    // Preserve Unity's vertex-stream phase on the terminal zero-delta pass. Regression oracles
    // confirm that the authored custom-data stream aligns with Quarks' pre-increment age here.
    if (delta !== 0) this.apply(particle);
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityCustom1Behavior(this.curves); }
  reset(): void {}
}

/** Random sheet tile when FrameOverLife used IntervalValue (quarks only applies PiecewiseBezier). */
class CfxrRandomTileBehavior implements Behavior {
  type = 'CfxrRandomTile';
  constructor(private maxTile: number) {}
  initialize(particle: Particle): void {
    particle.uvTile = Math.floor(Math.random() * Math.max(1, this.maxTile));
  }
  update(): void {}
  frameUpdate(): void {}
  toJSON() {
    return { type: this.type };
  }
  clone() {
    return new CfxrRandomTileBehavior(this.maxTile);
  }
  reset(): void {}
}

/**
 * Unity Texture Sheet Animation:
 * finalFrame = startFrame + frameOverTime(age) * cycleCount, wrapped by sheet size.
 * Quarks' stock FrameOverLife overwrites startFrame and ignores non-Bezier generators,
 * so random start frames and constant frame offsets select the wrong atlas cell.
 */
class UnityFrameOverLifeBehavior implements Behavior {
  type = 'UnityFrameOverLife';
  private startTiles = new WeakMap<object, number>();
  private startOffsets = new WeakMap<object, number>();

  constructor(
    private frame: {
      startGen: (memory: unknown) => void;
      genValue: (memory: unknown, t?: number) => number;
      clone?: () => UnityFrameOverLifeBehavior['frame'];
    },
    private tileCount: number,
    private timeMode: 'lifetime' | 'speed' = 'lifetime',
    private speedRange: [number, number] = [0, 1],
    /** Unity SingleRow: frame advances inside X while the selected Y row stays fixed. */
    private singleRow?: { columns: number; rows: number; rowIndex: number; randomRow: boolean },
  ) {}

  private apply(particle: Particle, t: number) {
    const start = this.startTiles.get(particle as object) ?? particle.uvTile;
    const offset = this.frame.genValue(particle.memory, t)
      - (this.startOffsets.get(particle as object) ?? 0);
    const total = Math.max(1, this.tileCount);
    if (this.singleRow) {
      const columns = Math.max(1, this.singleRow.columns);
      const rowBase = Math.floor(start / columns) * columns;
      const column = ((start % columns + offset) % columns + columns) % columns;
      particle.uvTile = rowBase + column;
      return;
    }
    particle.uvTile = ((start + offset) % total + total) % total;
  }

  initialize(particle: Particle): void {
    let start = particle.uvTile;
    if (this.singleRow) {
      const columns = Math.max(1, this.singleRow.columns);
      const rows = Math.max(1, this.singleRow.rows);
      const row = this.singleRow.randomRow
        ? Math.floor(Math.random() * rows)
        : Math.max(0, Math.min(rows - 1, this.singleRow.rowIndex));
      // Start frame is normalized within the selected row, never over all atlas cells.
      start = row * columns + ((start % columns) + columns) % columns;
    }
    this.startTiles.set(particle as object, start);
    this.frame.startGen(particle.memory);
    const initialT = this.timeMode === 'speed'
      ? (particle.velocity.length() - this.speedRange[0])
        / Math.max(1e-5, this.speedRange[1] - this.speedRange[0])
      : ((particle as UnitySemanticParticle).unitySpawnAgeOffset ?? particle.age)
        / Math.max(1e-5, particle.life);
    this.startOffsets.set(
      particle as object,
      this.frame.genValue(particle.memory, Math.max(0, Math.min(1, initialT))),
    );
    this.apply(particle, Math.max(0, Math.min(1, initialT)));
  }

  update(particle: Particle): void {
    const t = this.timeMode === 'speed'
      ? (particle.velocity.length() - this.speedRange[0])
        / Math.max(1e-5, this.speedRange[1] - this.speedRange[0])
      : particle.age / Math.max(1e-5, particle.life);
    this.apply(particle, Math.max(0, Math.min(1, t)));
  }

  frameUpdate(): void {}
  toJSON() {
    return { type: this.type };
  }
  clone() {
    return new UnityFrameOverLifeBehavior(
      this.frame.clone?.() ?? this.frame,
      this.tileCount,
      this.timeMode,
      [...this.speedRange],
      this.singleRow && { ...this.singleRow },
    );
  }
  // Preserve start-frame identity for particles draining across a system loop boundary.
  reset(): void {}
}

interface UnityShapeTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

interface UnityInitialParticleState {
  position: [number, number, number];
  velocity: [number, number, number];
  size: [number, number, number];
  baseSize?: [number, number, number];
  color: [number, number, number, number];
  life: number;
  seed: number;
  particleId?: string;
  spawnAgeOffset?: number;
  spawnTime?: number;
  scheduleTime?: number;
  globalSpawnTime?: number;
  sizeCurveLerp?: number;
  rotationCurveLerp?: [number, number, number];
  rotationEulerRadians?: [number, number, number];
  rotationBase?: [number, number, number, number];
  frame?: number;
  rendererFlip?: [boolean, boolean];
  rotation?: number | [number, number, number, number];
}

interface UnityTrajectorySample {
  age: number;
  position: [number, number, number];
  velocity: [number, number, number];
  rotation?: number | [number, number, number, number];
  size?: [number, number, number];
  frame?: number;
  color?: [number, number, number, number];
  custom1?: [number, number, number, number];
  custom2?: [number, number, number, number];
}

interface UnityTrajectoryTermination {
  /** Last age for which Unity returned the particle from GetParticles. */
  lastVisibleAge: number;
  /** First fixed-clock age for which Unity no longer returned the particle. */
  firstAbsentAge: number;
  /** Authoritative terminal point; never extrapolate a collision beyond it. */
  position: [number, number, number];
  velocity?: [number, number, number];
  reason: 'lifetime' | 'collision-or-native-kill';
}

interface UnityTrajectoryCache {
  schema: 'particle-trajectory-cache@4' | 'particle-trajectory-cache@5'
    | 'particle-trajectory-cache@6';
  sampleRate: number;
  space: 'world' | 'local';
  tracks: Array<{
    seed?: number;
    particleId?: string;
    samples: UnityTrajectorySample[];
    termination?: UnityTrajectoryTermination;
  }>;
}

class UnityInitialStateBehavior implements Behavior {
  type = 'UnityInitialState';
  private cursor = 0;
  private states: UnityInitialParticleState[];
  private loopDuration?: number;
  private billboardAxis = new QuarksVector3(0, 0, 1);
  constructor(states: UnityInitialParticleState[], loopDuration?: number) {
    // Burst evaluation is chronological. Unity's GetParticles storage order is only mostly
    // chronological and may contain sub-frame inversions, so cursor-based initialization must
    // consume an explicitly stable time ordering.
    this.states = states
      .map((state, index) => ({ state, index }))
      .sort((a, b) => ((a.state.scheduleTime ?? a.state.globalSpawnTime ?? 0)
          - (b.state.scheduleTime ?? b.state.globalSpawnTime ?? 0))
        || ((a.state.globalSpawnTime ?? 0) - (b.state.globalSpawnTime ?? 0))
      || a.index - b.index)
      .map(({ state }) => state);
    this.loopDuration = loopDuration && loopDuration > 1e-6 ? loopDuration : undefined;
  }
  initialize(particle: UnitySemanticParticle): void {
    if (!this.states.length) return;
    const state = this.states[this.cursor++ % this.states.length];
    particle.position.fromArray(state.position);
    particle.velocity.fromArray(state.velocity);
    particle.startSize.fromArray(state.baseSize ?? state.size);
    particle.size.fromArray(state.size);
    particle.startColor = new QuarksVector4(...state.color);
    particle.color.copy(particle.startColor);
    particle.life = state.life;
    // `spawnTime` is measured on Unity's root simulation clock. A Quarks sub-emitter has one
    // local emission clock per parent particle, so subtracting the two creates negative ages
    // and shifts every lifetime-driven shader/simulation curve. The exported age is the exact
    // sub-frame offset at birth and is valid for delayed, continuous, burst and sub emitters.
    let effectiveSpawnTime = state.globalSpawnTime;
    // The calibrated stream stores one Unity cycle. On a looping system Quarks reuses that
    // stream, so advance its root-clock timestamp to the current cycle as well; otherwise every
    // second-cycle particle is born with an age >= duration and vanishes immediately.
    // Unity exposes the final state of a cycle at t == duration and begins the next cycle on
    // the following simulation tick. Do not use a positive epsilon/`>=` here: deterministic
    // freeze captures at exactly duration would otherwise show a Web-only second burst.
    if (effectiveSpawnTime != null && this.loopDuration != null
        && sharedEffectTime > effectiveSpawnTime + this.loopDuration + 1e-4) {
      const cycle = Math.floor(
        (sharedEffectTime - effectiveSpawnTime + 1e-7) / this.loopDuration,
      );
      effectiveSpawnTime += Math.max(0, cycle) * this.loopDuration;
    }
    particle.unityGlobalSpawnTime = effectiveSpawnTime;
    particle.unitySpawnAgeOffset = Math.max(0, state.spawnAgeOffset ?? 0);
    particle.age = effectiveSpawnTime != null
      ? Math.max(0, sharedEffectTime - effectiveSpawnTime)
      : Math.max(0, state.spawnAgeOffset ?? 0);
    particle.unitySeed = state.seed;
    particle.unityParticleId = state.particleId ?? `${state.seed >>> 0}:0`;
    particle.unitySizeCurveLerp = state.sizeCurveLerp;
    particle.unityRotationCurveLerp = state.rotationCurveLerp;
    particle.unityRotationEuler = state.rotationEulerRadians
      ? [...state.rotationEulerRadians] as [number, number, number]
      : undefined;
    particle.unityRotationBase = state.rotationBase
      ? new QuarksQuaternion(...state.rotationBase)
      : undefined;
    if (Array.isArray(state.rotation)) {
      particle.rotation = new QuarksQuaternion(...state.rotation);
    } else if (typeof state.rotation === 'number') {
      if (particle.rotation instanceof QuarksQuaternion)
        particle.rotation.setFromAxisAngle(this.billboardAxis, state.rotation);
      else particle.rotation = state.rotation;
    }
    if (state.frame != null && state.frame >= 0) particle.uvTile = state.frame;
    particle.unityRendererFlip = state.rendererFlip ?? [false, false];
  }
  update(): void {}
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityInitialStateBehavior(this.states, this.loopDuration); }
  reset(): void { this.cursor = 0; }
}

/** Pins nested emitter lifetime semantics to Unity's root hierarchy clock. */
class UnityGlobalAgeBehavior implements Behavior {
  type = 'UnityGlobalAge';
  initialize(): void {}
  update(particle: UnitySemanticParticle, delta: number): void {
    if (particle.unityGlobalSpawnTime == null) return;
    const beforeSpawn = sharedEffectTime + 1e-9 < particle.unityGlobalSpawnTime;
    if (!beforeSpawn && particle.unityBeforeGlobalSpawn) particle.color.copy(particle.startColor);
    particle.unityBeforeGlobalSpawn = beforeSpawn;
    // Quarks increments age after all behaviors. Present start-of-step age to lifetime
    // behaviors so the post-step age equals the exported root-clock age exactly.
    particle.age = Math.max(
      0,
      sharedEffectTime - particle.unityGlobalSpawnTime - Math.max(0, delta),
    );
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityGlobalAgeBehavior(); }
  reset(): void {}
}

/** Runs after authored color behaviors and masks particles that Quarks emitted too early. */
class UnitySpawnVisibilityBehavior implements Behavior {
  type = 'UnitySpawnVisibility';
  initialize(): void {}
  update(particle: UnitySemanticParticle): void {
    if (particle.unityBeforeGlobalSpawn || particle.unityTrajectoryEnded) particle.color.w = 0;
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnitySpawnVisibilityBehavior(); }
  reset(): void {}
}

/** Camera-independent fallback for Unity-native simulation modules without a published kernel. */
class UnityTrajectoryCacheBehavior implements Behavior {
  type = 'UnityTrajectoryCache';
  private tracks = new Map<string, {
    samples: UnityTrajectorySample[];
    termination?: UnityTrajectoryTermination;
  }>();
  private target = new QuarksVector3();
  private billboardAxis = new QuarksVector3(0, 0, 1);
  private sampleEpsilon: number;
  constructor(cache: UnityTrajectoryCache) {
    for (const track of cache.tracks) {
      const key = track.particleId ?? `${(track.seed ?? 0) >>> 0}:0`;
      this.tracks.set(key, { samples: track.samples, termination: track.termination });
    }
    // Unity samples the hierarchy on a fixed clock. A track ending means GetParticles no longer
    // returned that particle on the following sample; clamping forever to the last state leaves
    // one-frame terminal ghosts. Keep only a small floating-point tolerance around that sample.
    this.sampleEpsilon = Math.min(1e-4, 0.01 / Math.max(1, cache.sampleRate));
  }
  private applyRotation(
    particle: UnitySemanticParticle,
    a: UnityTrajectorySample,
    b: UnityTrajectorySample,
    t: number,
  ) {
    if (typeof a.rotation === 'number' && typeof b.rotation === 'number') {
      const delta = Math.atan2(Math.sin(b.rotation - a.rotation), Math.cos(b.rotation - a.rotation));
      const angle = a.rotation + delta * t;
      if (particle.rotation instanceof QuarksQuaternion)
        particle.rotation.setFromAxisAngle(this.billboardAxis, angle);
      else particle.rotation = angle;
    } else if (Array.isArray(a.rotation) && Array.isArray(b.rotation)) {
      const rotation = particle.rotation instanceof QuarksQuaternion
        ? particle.rotation
        : new QuarksQuaternion();
      rotation.fromArray(a.rotation).slerp(new QuarksQuaternion(...b.rotation), t).normalize();
      particle.rotation = rotation;
    }
  }
  private applyVisualState(
    particle: UnitySemanticParticle,
    a: UnityTrajectorySample,
    b: UnityTrajectorySample,
    t: number,
  ) {
    if (a.frame != null && b.frame != null) {
      // Atlas cells are discrete. Unity holds the earlier cell until the sampled transition.
      particle.uvTile = t < 1 ? a.frame : b.frame;
    }
    if (a.size && b.size) particle.size.set(
      a.size[0] + (b.size[0] - a.size[0]) * t,
      a.size[1] + (b.size[1] - a.size[1]) * t,
      a.size[2] + (b.size[2] - a.size[2]) * t,
    );
    if (a.color && b.color) particle.color.set(
      a.color[0] + (b.color[0] - a.color[0]) * t,
      a.color[1] + (b.color[1] - a.color[1]) * t,
      a.color[2] + (b.color[2] - a.color[2]) * t,
      a.color[3] + (b.color[3] - a.color[3]) * t,
    );
    if (a.custom1 && b.custom1) particle.unityCustom1 = [
      a.custom1[0] + (b.custom1[0] - a.custom1[0]) * t,
      a.custom1[1] + (b.custom1[1] - a.custom1[1]) * t,
      a.custom1[2] + (b.custom1[2] - a.custom1[2]) * t,
      a.custom1[3] + (b.custom1[3] - a.custom1[3]) * t,
    ];
    if (a.custom2 && b.custom2) particle.unityCustom2 = [
      a.custom2[0] + (b.custom2[0] - a.custom2[0]) * t,
      a.custom2[1] + (b.custom2[1] - a.custom2[1]) * t,
      a.custom2[2] + (b.custom2[2] - a.custom2[2]) * t,
      a.custom2[3] + (b.custom2[3] - a.custom2[3]) * t,
    ];
  }
  private applyRendererVelocity(
    particle: UnitySemanticParticle,
    samples: UnityTrajectorySample[],
    index: number,
  ) {
    const previous = samples[Math.max(0, index - 1)];
    const next = samples[Math.min(samples.length - 1, index + 1)];
    const dt = Math.max(1e-6, next.age - previous.age);
    particle.velocity.set(
      (next.position[0] - previous.position[0]) / dt,
      (next.position[1] - previous.position[1]) / dt,
      (next.position[2] - previous.position[2]) / dt,
    );
  }
  private sample(particle: UnitySemanticParticle, age: number, out: QuarksVector3): boolean {
    const particleId = particle.unityParticleId ?? `${(particle.unitySeed ?? 0) >>> 0}:0`;
    const track = this.tracks.get(particleId);
    const samples = track?.samples;
    if (!samples?.length) return false;
    if (age <= samples[0].age) {
      out.fromArray(samples[0].position);
      this.applyRotation(particle, samples[0], samples[0], 0);
      this.applyVisualState(particle, samples[0], samples[0], 0);
      this.applyRendererVelocity(particle, samples, 0);
      return true;
    }
    const last = samples[samples.length - 1];
    const termination = track?.termination;
    if (termination && age + this.sampleEpsilon >= termination.firstAbsentAge) {
      particle.unityTrajectoryEnded = true;
      particle.color.w = 0;
      out.fromArray(termination.position);
      return true;
    }
    // @6 separates the last visible sample from the disappearance edge. Hold/interpolate only
    // inside that measured interval; collision particles must never fly past the exported hit.
    if (termination && age > last.age) {
      particle.unityTrajectoryEnded = false;
      const span = Math.max(1e-6, termination.firstAbsentAge - last.age);
      const t = Math.max(0, Math.min(1, (age - last.age) / span));
      out.set(
        last.position[0] + (termination.position[0] - last.position[0]) * t,
        last.position[1] + (termination.position[1] - last.position[1]) * t,
        last.position[2] + (termination.position[2] - last.position[2]) * t,
      );
      this.applyRotation(particle, last, last, 0);
      this.applyVisualState(particle, last, last, 0);
      this.applyRendererVelocity(particle, samples, samples.length - 1);
      return true;
    }
    if (!termination && age > last.age + this.sampleEpsilon) {
      // Legacy @4/@5 compatibility. New exports are forbidden to infer death this way.
      particle.unityTrajectoryEnded = true;
      particle.color.w = 0;
      out.fromArray(last.position);
      return true;
    }
    if (age >= last.age) {
      particle.unityTrajectoryEnded = false;
      out.fromArray(last.position);
      this.applyRotation(particle, last, last, 0);
      this.applyVisualState(particle, last, last, 0);
      this.applyRendererVelocity(particle, samples, samples.length - 1);
      return true;
    }
    let lo = 0, hi = samples.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid].age <= age) lo = mid;
      else hi = mid;
    }
    const a = samples[lo], b = samples[hi];
    particle.unityTrajectoryEnded = false;
    const t = Math.max(0, Math.min(1, (age - a.age) / Math.max(1e-6, b.age - a.age)));
    out.set(
      a.position[0] + (b.position[0] - a.position[0]) * t,
      a.position[1] + (b.position[1] - a.position[1]) * t,
      a.position[2] + (b.position[2] - a.position[2]) * t,
    );
    this.applyRotation(particle, a, b, t);
    this.applyVisualState(particle, a, b, t);
    if (t <= 1e-4) this.applyRendererVelocity(particle, samples, lo);
    else if (t >= 1 - 1e-4) this.applyRendererVelocity(particle, samples, hi);
    else particle.velocity.set(
      (b.position[0] - a.position[0]) / Math.max(1e-6, b.age - a.age),
      (b.position[1] - a.position[1]) / Math.max(1e-6, b.age - a.age),
      (b.position[2] - a.position[2]) / Math.max(1e-6, b.age - a.age),
    );
    return true;
  }
  initialize(particle: UnitySemanticParticle): void {
    particle.unityTrajectoryEnded = false;
    this.sample(particle, particle.age, particle.position);
  }
  update(particle: UnitySemanticParticle, delta: number): void {
    if (!this.sample(particle, particle.age + Math.max(0, delta), this.target)) return;
    // applyVisualState has already restored Unity's sampled instantaneous velocity. Never replace
    // it with a position finite-difference: the renderer observes velocity after all native
    // velocity/limit modules, while that difference is merely an interval average.
    particle.position.copy(this.target);
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() {
    const tracks = [...this.tracks].map(([particleId, track]) => ({ particleId, ...track }));
    return new UnityTrajectoryCacheBehavior({
      schema: 'particle-trajectory-cache@6', sampleRate: 60, space: 'world', tracks,
    });
  }
  reset(): void {}
}

/**
 * three.quarks' Birth sub-emitter checks `particle.age === 0`. Calibrated Unity spawn state can
 * legitimately initialize a particle at a positive sub-frame age (or a negative scheduled age),
 * so equality loses the event completely. Convert it to an edge-triggered birth event while
 * retaining Quarks' live child-particle simulation.
 */
function patchCalibratedBirthSubEmitters(system: ParticleSystem) {
  const hardResetters: Array<() => void> = [];
  for (const behavior of system.behaviors) {
    if (behavior.type !== 'EmitSubParticleSystem') continue;
    const sub = behavior as Behavior & {
      mode?: number;
      subEmissions?: unknown[];
      update: (particle: Particle, delta: number) => void;
      reset: () => void;
      __unityBirthEdge?: boolean;
      __unityHardReset?: () => void;
    };
    // quarks SubParticleEmitMode.Birth = 1. Frame/Death modes keep their stock semantics.
    if (sub.mode !== 1 || sub.__unityBirthEdge) continue;
    const originalUpdate = sub.update.bind(sub);
    const originalReset = sub.reset.bind(sub);
    let emittedObjects = new WeakSet<object>();
    const emittedParticleIds = new Set<string>();
    sub.update = (particle: Particle, delta: number) => {
      const semanticParticle = particle as UnitySemanticParticle;
      const particleId = semanticParticle.unityParticleId;
      // A calibrated one-cycle track is intentionally reused by UnityInitialState on every
      // authored loop. The stable logical birth identity is therefore track + effective root
      // spawn time, not track alone.
      const birthId = particleId
        ? `${particleId}@${semanticParticle.unityGlobalSpawnTime ?? 0}`
        : undefined;
      if (particle.age < 0
          || (birthId ? emittedParticleIds.has(birthId) : emittedObjects.has(particle as object))) return;
      const age = particle.age;
      particle.age = 0;
      originalUpdate(particle, delta);
      particle.age = age;
      if (birthId) emittedParticleIds.add(birthId);
      else emittedObjects.add(particle as object);
    };
    sub.reset = () => {
      // Upstream EmitSubParticleSystem.reset() is empty, so replay otherwise retains every
      // previous child-emission instance. Do not clear Birth identity here: Quarks also calls
      // behavior.reset at an ordinary loop boundary while positive-age calibrated particles
      // remain alive, and clearing it would fire Birth twice for the same Unity particle.
      if (Array.isArray(sub.subEmissions)) sub.subEmissions.length = 0;
      originalReset();
    };
    sub.__unityHardReset = () => {
      emittedObjects = new WeakSet<object>();
      emittedParticleIds.clear();
      if (Array.isArray(sub.subEmissions)) sub.subEmissions.length = 0;
    };
    hardResetters.push(sub.__unityHardReset);
    sub.__unityBirthEdge = true;
  }
  const patchedSystem = system as ParticleSystem & { __unityBirthRestart?: boolean };
  if (hardResetters.length && !patchedSystem.__unityBirthRestart) {
    const originalRestart = system.restart.bind(system);
    system.restart = () => {
      originalRestart();
      for (const reset of hardResetters) reset();
    };
    patchedSystem.__unityBirthRestart = true;
  }
}

/** Quarks reuses `EmissionState.time` as the looping child's phase and wraps it to zero, while
 * EmitSubParticleSystem also uses that same value as instance elapsed time. Consequently a
 * looping child can never reach the intended duration-removal edge. Keep an orthogonal event
 * instance clock and leave the child's live looping phase untouched. */
type UnitySubEmitterInheritance = {
  schema: 'unity-sub-emitter-inheritance@1';
  size: boolean;
  color: boolean;
  rotation: boolean;
  lifetime: boolean;
};

function patchChildDurationSubEmitters(
  system: ParticleSystem,
  inheritanceSpecs: UnitySubEmitterInheritance[],
) {
  let edgeIndex = 0;
  for (const behavior of system.behaviors) {
    if (behavior.type !== 'EmitSubParticleSystem') continue;
    const inheritance = inheritanceSpecs[edgeIndex++];
    const sub = behavior as Behavior & {
      subParticleSystem?: { uuid?: string; system?: IParticleSystem };
      subEmissions?: Array<{
        particle?: Particle;
        matrix: { elements?: number[] };
        __unityInstanceElapsed?: number;
      }>;
      setMatrixFromParticle?: (matrix: unknown, particle: Particle) => void;
      frameUpdate: (delta: number) => void;
      reset: () => void;
      __unityChildDuration?: boolean;
    };
    const targetUuid = sub.subParticleSystem?.uuid;
    if (!targetUuid || !childDurationSubEmitterIds.has(targetUuid) || sub.__unityChildDuration) continue;
    const originalReset = sub.reset.bind(sub);
    sub.frameUpdate = (delta: number) => {
      const states = sub.subEmissions ?? [];
      const target = sub.subParticleSystem?.system as (IParticleSystem & {
        particleNum?: number;
        particles?: Particle[];
      }) | undefined;
      const duration = target?.duration ?? 0;
      for (let i = states.length - 1; i >= 0; i--) {
        const state = states[i];
        const next = (state.__unityInstanceElapsed ?? 0) + Math.max(0, delta);
        if (duration > 0 && next + 1e-7 >= duration) {
          states.splice(i, 1);
          continue;
        }
        state.__unityInstanceElapsed = next;
        if (!target) continue;
        const parent = state.particle as UnitySemanticParticle | undefined;
        if (parent && parent.age < parent.life) {
          sub.setMatrixFromParticle?.(state.matrix, parent);
          if (inheritance?.size && state.matrix.elements) {
            const e = state.matrix.elements;
            for (const index of [0, 1, 2]) e[index] *= parent.size.x;
            for (const index of [4, 5, 6]) e[index] *= parent.size.y;
            for (const index of [8, 9, 10]) e[index] *= parent.size.z;
          }
        } else {
          state.particle = undefined;
        }
        const before = target.particleNum ?? 0;
        target.emit(delta, state as any, state.matrix as any);
        if (inheritance?.color && parent && target.particles) {
          const after = target.particleNum ?? before;
          for (let particleIndex = before; particleIndex < after; particleIndex++) {
            const child = target.particles[particleIndex];
            child.startColor.x *= parent.color.x;
            child.startColor.y *= parent.color.y;
            child.startColor.z *= parent.color.z;
            child.startColor.w *= parent.color.w;
            child.color.copy(child.startColor);
          }
        }
        if (inheritance?.lifetime && parent && target.particles) {
          const after = target.particleNum ?? before;
          // Unity's Inherit Lifetime scales the child module's authored lifetime by
          // the normalized lifetime of the owning parent at emission. Quarks exposes
          // the newly emitted range synchronously, so apply the same scale once at birth.
          const lifetimeScale = Math.max(0, parent.life);
          for (let particleIndex = before; particleIndex < after; particleIndex++) {
            const child = target.particles[particleIndex];
            child.life *= lifetimeScale;
          }
        }
      }
    };
    sub.reset = () => {
      originalReset();
    };
    sub.__unityChildDuration = true;
  }
}

function patchUnityShapeTransform(system: ParticleSystem, spec: UnityShapeTransform) {
  const shape = system.emitterShape as unknown as {
    initialize: (particle: Particle, emissionState: unknown) => void;
    __unityShapeTransform?: boolean;
  };
  if (!shape || shape.__unityShapeTransform) return;
  const original = shape.initialize.bind(shape);
  const position = new QuarksVector3(...spec.position);
  const rotation = new QuarksQuaternion(...spec.rotation);
  const scale = new QuarksVector3(...spec.scale);
  shape.initialize = (particle, emissionState) => {
    original(particle, emissionState);
    // Unity order inside ShapeModule: scale point, rotate point/direction, then translate.
    // This hook runs before Quarks applies emitter.matrixWorld, so it is exact for both Local
    // and World simulation spaces.
    particle.position.multiply(scale).applyQuaternion(rotation).add(position);
    particle.velocity.applyQuaternion(rotation);
  };
  shape.__unityShapeTransform = true;
}

function samplePiecewiseOrLinear(curve: any, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  if (!curve) return 1 - u;
  if (curve.type === 'ConstantValue') {
    return curve.value ?? 0;
  }
  if (curve.type === 'IntervalValue') {
    return curve.a + (curve.b - curve.a) * u;
  }
  if (curve.type === 'UnityAnimationCurve@1' && Array.isArray(curve.keys)) {
    const keys = curve.keys as Array<{
      time: number; value: number; inTangent: number; outTangent: number;
      inWeight: number; outWeight: number; weightedMode: number;
    }>;
    if (!keys.length) return 0;
    if (u <= keys[0].time) return keys[0].value;
    if (u >= keys[keys.length - 1].time) return keys[keys.length - 1].value;
    let right = 1;
    while (right < keys.length && u > keys[right].time) right++;
    const a = keys[right - 1], b = keys[right];
    const dt = Math.max(1e-7, b.time - a.time);
    const outWeighted = (a.weightedMode & 2) !== 0;
    const inWeighted = (b.weightedMode & 1) !== 0;
    const x0 = a.time, x3 = b.time;
    const x1 = x0 + dt * (outWeighted ? a.outWeight : 1 / 3);
    const x2 = x3 - dt * (inWeighted ? b.inWeight : 1 / 3);
    const y0 = a.value, y3 = b.value;
    const y1 = y0 + a.outTangent * (x1 - x0);
    const y2 = y3 - b.inTangent * (x3 - x2);
    const bezier = (p0: number, p1: number, p2: number, p3: number, s: number) => {
      const o = 1 - s;
      return o * o * o * p0 + 3 * o * o * s * p1 + 3 * o * s * s * p2 + s * s * s * p3;
    };
    let lo = 0, hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) * 0.5;
      if (bezier(x0, x1, x2, x3, mid) < u) lo = mid; else hi = mid;
    }
    return bezier(y0, y1, y2, y3, (lo + hi) * 0.5);
  }
  // Keyframe list from inject: [{t,v},...]
  if (Array.isArray(curve.keys) && curve.keys.length) {
    const keys = curve.keys as { t: number; v: number }[];
    if (u <= keys[0].t) return keys[0].v;
    for (let i = 1; i < keys.length; i++) {
      if (u <= keys[i].t) {
        const a = keys[i - 1];
        const b = keys[i];
        const s = (u - a.t) / Math.max(1e-5, b.t - a.t);
        return a.v + (b.v - a.v) * s;
      }
    }
    return keys[keys.length - 1].v;
  }
  if (curve.type === 'PiecewiseBezier' && Array.isArray(curve.functions)) {
    let entry = curve.functions[0];
    for (let i = 1; i < curve.functions.length; i++) {
      if ((curve.functions[i]?.start ?? 0) > u) break;
      entry = curve.functions[i];
    }
    const seg = entry?.function;
    if (seg) {
      const { p0, p1, p2, p3 } = seg;
      const start = entry?.start ?? 0;
      const index = curve.functions.indexOf(entry);
      const end = curve.functions[index + 1]?.start ?? 1;
      const local = Math.max(0, Math.min(1, (u - start) / Math.max(1e-6, end - start)));
      const omt = 1 - local;
      return omt * omt * omt * p0 + 3 * omt * omt * local * p1
        + 3 * omt * local * local * p2 + local * local * local * p3;
    }
  }
  return 1 - u;
}

export function extractStartDelays(json: any): Map<string, number> {
  const map = new Map<string, number>();
  const oneShotDuration = Number(json?.vfxIR?.lifecycle?.terminalTime) || 0;
  const globallyScheduled = new Set<string>();
  const collectSchedules = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.uuid
        && o.ps?.unitySpawnSchedule?.schema === 'calibrated-spawn-schedule@1') {
      globallyScheduled.add(o.uuid);
    }
    if (Array.isArray(o.children)) o.children.forEach(collectSchedules);
    if (o.object) collectSchedules(o.object);
  };
  collectSchedules(json);
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.ps && o.uuid) {
      if (o.ps.unitySpawnSchedule?.schema === 'calibrated-spawn-schedule@1') {
        o.ps.emissionOverTime = { type: 'ConstantValue', value: 0 };
        o.ps.emissionOverDistance = { type: 'ConstantValue', value: 0 };
        o.ps.emissionBursts = o.ps.unitySpawnSchedule.bursts;
        // This emitter is now driven by the root clock, including when it originated as a
        // Unity sub-emitter. It must participate in the normal system update loop.
        o.ps.onlyUsedByOther = false;
        // The root-clock schedule contains every native-RNG birth inside one finite effect
        // instance. Local emitter loops would wrap before later schedule entries and repeat the
        // first cycle, so all globally scheduled systems become one-shot on the root horizon.
        o.ps.looping = false;
        if (oneShotDuration > 0) o.ps.duration = Math.max(Number(o.ps.duration) || 0, oneShotDuration);
      }
      if (Array.isArray(o.ps.behaviors)) {
        // Remove only event edges whose target was strictly compiled to a global schedule.
        // Keeping the edge as well would double-emit; removing unrelated/local-space edges
        // would lose semantics, so this is deliberately target-specific.
        o.ps.behaviors = o.ps.behaviors.filter((behavior: any) =>
          behavior?.type !== 'EmitSubParticleSystem'
          || !globallyScheduled.has(String(behavior.subParticleSystem ?? '')));
      }
      const d = o.ps.startDelay;
      const v = typeof d === 'number' ? d : (d?.value ?? 0);
      if (v > 0) map.set(o.uuid, v);
    }
    if (Array.isArray(o.children)) o.children.forEach(walk);
    if (o.object) walk(o.object);
  };
  walk(json);
  return map;
}

/** Collect custom data curves keyed by stable emitter UUID from raw JSON. */
export function extractDissolveCurves(json: any): Map<string, any> {
  const map = new Map<string, any>();
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.ps && o.uuid && o.ps.cfxrCustomData) {
      const cd = o.ps.cfxrCustomData;
      // Prefer custom1x; Shader Graph packs often wire dissolve → custom1.y while x stays 0.
      const curve = cd.custom1x ?? cd.custom1y;
      if (curve) map.set(o.uuid, curve);
    }
    if (Array.isArray(o.children)) o.children.forEach(walk);
    if (o.object) walk(o.object);
  };
  walk(json);
  return map;
}

let custom1CurvesByEmitter = new Map<string, [any, any, any, any]>();
/** Stable emitter UUID → explicit material program profile. */
let pendingCfxrByEmitter = new Map<string, CfxrMaterialProps>();
/** Stable emitter UUID → final runtime profile computed before batching. */
let profilesByEmitter = new Map<string, CfxrRuntimeProfile>();
let shapeTransformByEmitter = new Map<string, UnityShapeTransform>();
let initialStateByEmitter = new Map<string, UnityInitialParticleState[]>();
let childDurationSubEmitterIds = new Set<string>();
let subEmitterInheritanceByEmitter = new Map<string, UnitySubEmitterInheritance[]>();
let flipbookTimingByEmitter = new Map<
  string,
  { mode: 'lifetime' | 'speed'; speedRange: [number, number] }
>();
let rendererPivotByEmitter = new Map<string, [number, number, number, number]>();
let sizeTwoCurvesByEmitter = new Map<string, UnityTwoCurvesSpec>();
interface UnitySizeOverLifetimeSpec {
  schema: 'unity-size-over-lifetime@1';
  mode: 'scalar';
  curve: any;
}
let sizeOverLifetimeByEmitter = new Map<string, UnitySizeOverLifetimeSpec>();
let startSizeTwoCurvesByEmitter = new Map<string, UnityTwoCurvesSpec>();
let limitVelocity3DByEmitter = new Map<string, UnityLimitVelocity3DSpec>();
let limitVelocityByEmitter = new Map<string, UnityLimitVelocitySpec>();
let velocityOverLifetimeByEmitter = new Map<string, UnityVelocityOverLifetimeSpec>();
let rotation3DByEmitter = new Map<string, UnityRotation3DSpec>();
let trajectoryCacheByEmitter = new Map<string, UnityTrajectoryCache>();
type UnityTrailGeometryPointObject = {
  position: [number, number, number];
  width: number;
  color: [number, number, number, number];
  u?: number;
};
type UnityTrailGeometryPoint = UnityTrailGeometryPointObject |
  [number, number, number, number?, number?, number?, number?, number?, number?];
type UnityTrailGeometry = {
  schema: 'unity-trail-geometry@1' | 'unity-trail-geometry@2';
  sampleRate: number;
  space: 'world' | 'local';
  frames: Array<{ time: number; trails: UnityTrailGeometryPoint[][]; trailSeeds?: number[] }>;
};

type EncodedUnityTrailGeometry = Omit<UnityTrailGeometry, 'schema' | 'frames'> & {
  schema: 'unity-trail-geometry@2';
  encoding: 'base64-le-f32-u16-alpha8@1' | 'base64-le-f32-u16-alpha8-seed32@1';
  frameCount: number;
  payload: string;
};

function decodeUnityTrailGeometry(
  geometry: UnityTrailGeometry | EncodedUnityTrailGeometry,
): UnityTrailGeometry {
  if (geometry.schema === 'unity-trail-geometry@1') return geometry as UnityTrailGeometry;
  const encoded = geometry as EncodedUnityTrailGeometry;
  const hasSeeds = encoded.encoding === 'base64-le-f32-u16-alpha8-seed32@1';
  if (!hasSeeds && encoded.encoding !== 'base64-le-f32-u16-alpha8@1') {
    throw new Error(`Unsupported Unity trail geometry encoding '${String(encoded.encoding)}'`);
  }
  const binary = atob(encoded.payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const u16 = () => { const value = view.getUint16(offset, true); offset += 2; return value; };
  const u32 = () => { const value = view.getUint32(offset, true); offset += 4; return value; };
  const f32 = () => { const value = view.getFloat32(offset, true); offset += 4; return value; };
  if (u32() !== 0x32475455) throw new Error('Invalid unity-trail-geometry@2 magic');
  const frameCount = u32();
  if (frameCount !== encoded.frameCount) throw new Error('Trail geometry frameCount mismatch');
  const frames: UnityTrailGeometry['frames'] = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const time = f32();
    const trails: UnityTrailGeometryPoint[][] = [];
    const trailSeeds: number[] = [];
    const trailCount = u16();
    for (let trailIndex = 0; trailIndex < trailCount; trailIndex++) {
      const points: UnityTrailGeometryPoint[] = [];
      const pointCount = u16();
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        const x = f32(), y = f32(), z = f32(), width = f32();
        if (offset >= bytes.byteLength) throw new Error('Truncated unity-trail-geometry@2 payload');
        const alpha = bytes[offset++] / 255;
        points.push([x, y, z, width, alpha]);
      }
      trails.push(points);
      if (hasSeeds) trailSeeds.push(u32());
    }
    frames.push({ time, trails, ...(hasSeeds ? { trailSeeds } : {}) });
  }
  if (offset !== bytes.byteLength) throw new Error('Trailing bytes in unity-trail-geometry@2 payload');
  return { schema: 'unity-trail-geometry@2', sampleRate: geometry.sampleRate, space: geometry.space, frames };
}
let trailGeometryByEmitter = new Map<string, UnityTrailGeometry>();
type UnityTrailSemantics = {
  schema: 'unity-trail-semantics@1' | 'unity-trail-semantics@2';
  mode?: 'PerParticle' | 'Ribbon';
  ratio?: number;
  lifetime?: any;
  minVertexDistance?: number;
  textureMode?: string;
  worldSpace?: boolean;
  widthOverTrail: any;
  colorOverLifetime: any;
  colorOverTrail: any;
  sizeAffectsWidth: boolean;
  sizeAffectsLifetime?: boolean;
  inheritParticleColor: boolean;
  dieWithParticles: boolean;
  ribbonCount?: number;
  splitSubEmitterRibbons?: boolean;
  attachRibbonsToTransform?: boolean;
};
let trailSemanticsByEmitter = new Map<string, UnityTrailSemantics>();

class UnityTrailSemanticsBehavior implements Behavior {
  type = 'UnityTrailSemantics';
  private width: any;
  private lifetimeColor: any;
  private trailColor: any;
  private trailLifetime: any | null;
  private bases = new WeakMap<object, {
    size: number; color: [number, number, number, number];
  }>();
  private lifetimeSeconds = new WeakMap<object, number>();
  private patchedUpdates = new WeakSet<object>();
  private system?: IParticleSystem;
  private sampledLifetime = new CoreVector4(1, 1, 1, 1);
  private sampledTrail = new CoreVector4(1, 1, 1, 1);

  constructor(
    private semantics: UnityTrailSemantics,
    private geometry?: UnityTrailGeometry,
  ) {
    this.width = ValueGeneratorFromJSON(semantics.widthOverTrail);
    this.lifetimeColor = ColorGeneratorFromJSON(semantics.colorOverLifetime);
    this.trailColor = ColorGeneratorFromJSON(semantics.colorOverTrail);
    this.trailLifetime = semantics.lifetime ? ValueGeneratorFromJSON(semantics.lifetime) : null;
  }
  initialize(particle: Particle, system?: IParticleSystem) {
    if (system) this.system = system;
    this.width.startGen(particle.memory);
    this.lifetimeColor.startGen(particle.memory);
    this.trailColor.startGen(particle.memory);
    if (this.trailLifetime) {
      this.trailLifetime.startGen(particle.memory);
      const systemT = system
        ? system.emissionState.time / Math.max(system.duration, 1e-6)
        : 0;
      const value = this.trailLifetime.genValue(particle.memory, systemT);
      const sizeMul = this.semantics.sizeAffectsLifetime
        ? Math.max(0, particle.startSize.x)
        : 1;
      this.lifetimeSeconds.set(particle, Math.max(0, value * sizeMul));
    }
    if (this.geometry) {
      const trail = particle as Particle & { update?: () => void };
      trail.update = () => {};
      this.patchedUpdates.add(particle);
    } else if (this.semantics.schema === 'unity-trail-semantics@2') {
      this.installExactHistoryUpdate(particle);
    }
  }
  private installExactHistoryUpdate(particle: Particle) {
    const trail = particle as Particle & {
      previous?: {
        length: number;
        clear(): void;
        front(): any;
        back(): any;
        dequeue(): any;
        pop(): any;
        push(value: any): void;
      };
      update?: () => void;
    };
    if (!trail.previous || this.patchedUpdates.has(particle)) return;
    this.patchedUpdates.add(particle);
    const semantics = this.semantics;
    const lifetimeOf = () => this.lifetimeSeconds.get(particle) ?? 0;
    trail.update = () => {
      const history = trail.previous!;
      const now = particle.age;
      const lifetime = lifetimeOf();
      if (particle.age <= particle.life) {
        const priorHead = history.back();
        if (priorHead?.unityLiveHead) history.pop();
        const committed = history.back();
        const point = {
          position: particle.position.clone(),
          size: particle.size.x,
          color: particle.color.clone(),
          unityRecordedAt: now,
          unityLiveHead: false,
        };
        const minDistance = Math.max(0, semantics.minVertexDistance ?? 0);
        if (committed && committed.position.distanceTo(point.position) < minDistance) {
          // Keep an uncommitted live head without moving the last accepted anchor.
          // This gives Unity's moving endpoint while minVertexDistance controls topology.
          point.unityLiveHead = true;
        }
        history.push(point);
      } else if (semantics.dieWithParticles) {
        history.clear();
      }
      while (history.length > 0) {
        const oldest = history.front();
        const recordedAt = Number(oldest?.unityRecordedAt ?? now);
        if (now - recordedAt <= lifetime + 1e-7) break;
        history.dequeue();
      }
    };
  }
  update(particle: Particle) {
    // three.quarks may bundle a distinct quarks.core class identity in optimized builds;
    // the IR contract is structural, so do not gate semantics on instanceof.
    const trail = particle as Particle & { previous?: { length: number; clear(): void; values(): Iterator<any> }; length?: number };
    if (!trail.previous || typeof trail.length !== 'number') return;
    if (this.geometry) return;
    if (this.semantics.dieWithParticles && particle.age >= particle.life) {
      trail.previous.clear();
      return;
    }
    const values = trail.previous.values();
    for (let i = 0; i < trail.previous.length; i++) {
      const state = values.next().value as any;
      if (!state) continue;
      let base = this.bases.get(state);
      if (!base) {
        base = {
          size: state.size,
          color: [state.color.x, state.color.y, state.color.z, state.color.w],
        };
        this.bases.set(state, base);
      }
      // Quarks orders history oldest→newest. Unity width/color curves use 1 at the
      // oldest tail and 0 at the live head, matching WidthOverLength's convention.
      const t = Math.min(1, Math.max(0,
        (trail.previous.length - 1 - i) / Math.max(1, trail.previous.length - 1),
      ));
      const width = this.width.genValue(particle.memory, t);
      state.size = (this.semantics.sizeAffectsWidth ? base.size : 1) * width;
      // Unity TrailModule.colorOverLifetime is evaluated once from the owning
      // particle's normalized lifetime and multiplies every point in that ribbon.
      // colorOverTrail is the separate head→tail spatial gradient below.
      const ageT = Math.min(1, Math.max(0, particle.age / Math.max(particle.life, 1e-6)));
      this.lifetimeColor.genColor(particle.memory, this.sampledLifetime, ageT);
      this.trailColor.genColor(particle.memory, this.sampledTrail, t);
      const cr = this.sampledLifetime.x * this.sampledTrail.x;
      const cg = this.sampledLifetime.y * this.sampledTrail.y;
      const cb = this.sampledLifetime.z * this.sampledTrail.z;
      const ca = this.sampledLifetime.w * this.sampledTrail.w;
      if (this.semantics.inheritParticleColor) {
        state.color.set(
          base.color[0] * cr, base.color[1] * cg,
          base.color[2] * cb, base.color[3] * ca,
        );
      } else {
        state.color.set(cr, cg, cb, ca);
      }
    }
  }
  frameUpdate() {
    if (!this.geometry || !this.system || !this.geometry.frames.length) return;
    const time = this.system.emissionState.time;
    let frame = this.geometry.frames[0];
    for (const candidate of this.geometry.frames) {
      frame = candidate;
      if (candidate.time >= time - 1e-7) break;
    }
    const particles = this.system.particles as Array<Particle & {
      previous?: { clear(): void; push(value: any): void };
    }>;
    const assigned = new Set<number>();
    for (let trailIndex = 0; trailIndex < frame.trails.length; trailIndex++) {
      const points = frame.trails[trailIndex] ?? [];
      if (points.length < 2) continue;
      let targetIndex = -1;
      let nearest = Infinity;
      const boundSeed = frame.trailSeeds?.[trailIndex];
      if (boundSeed != null && boundSeed !== 0xffffffff) {
        for (let i = 0; i < this.system.particleNum; i++) {
          if (assigned.has(i) || !particles[i]?.previous) continue;
          if ((particles[i] as Particle & { unitySeed?: number }).unitySeed === boundSeed) {
            targetIndex = i;
            nearest = 0;
            break;
          }
        }
      }
      // BakeTrailsMesh emits connected ribbons in topology order, while Quarks stores
      // TrailParticles in pool order. Match by the live-head position instead of assuming the
      // two orderings are identical; particle identities can change whenever a trail dies.
      const head = points[points.length - 1];
      const hp = Array.isArray(head)
        ? head
        : [head.position[0], head.position[1], head.position[2]];
      for (let i = 0; targetIndex < 0 && i < this.system.particleNum; i++) {
        if (assigned.has(i) || !particles[i]?.previous) continue;
        const p = particles[i].position;
        const dx = p.x - hp[0], dy = p.y - hp[1], dz = p.z - hp[2];
        const distance = dx * dx + dy * dy + dz * dz;
        if (distance < nearest) { nearest = distance; targetIndex = i; }
      }
      // A trail component without a live owning particle is already dead in Unity. Do not
      // attach it to an arbitrary pool slot: that creates long phantom ribbons at unrelated
      // positions when particle order changes across a loop boundary.
      if (targetIndex < 0 || nearest > 0.25 * 0.25) continue;
      assigned.add(targetIndex);
      const history = particles[targetIndex].previous!;
      history.clear();
      for (const point of points) {
        const position = Array.isArray(point)
          ? [point[0], point[1], point[2]] as [number, number, number]
          : point.position;
        const localPosition = this.geometry?.space === 'world' && this.system && !this.system.worldSpace
          ? (this.system.emitter as any).worldToLocal(
            new QuarksVector3(position[0], position[1], position[2]),
          )
          : new QuarksVector3(position[0], position[1], position[2]);
        const width = Array.isArray(point) ? (point[3] ?? particles[targetIndex].size.x) : point.width;
        const color = Array.isArray(point)
          ? point.length >= 8
            ? [point[4]!, point[5]!, point[6]!, point[7]!] as [number, number, number, number]
            : point.length >= 5
              ? [particles[targetIndex].color.x, particles[targetIndex].color.y,
                particles[targetIndex].color.z, point[4]!]
            : [particles[targetIndex].color.x, particles[targetIndex].color.y,
              particles[targetIndex].color.z, particles[targetIndex].color.w]
          : point.color;
        history.push({
          position: localPosition,
          // Unity's baked strip and Quarks' analytic screen-space extrusion have different
          // edge-coverage conventions. This backend conversion is qualified once for the
          // renderer pair (not per effect) and remains explicit in the geometry adapter.
          size: width * 0.75,
          color: new CoreVector4(
            color[0], color[1], color[2], color[3],
          ),
        });
      }
    }
  }
  // A system loop is not a particle reset. Weak per-particle/per-point state is overwritten by
  // initialize() or collected naturally, while surviving trails must retain their histories.
  reset() {}
  clone() { return new UnityTrailSemanticsBehavior(this.semantics, this.geometry); }
  toJSON() { return { type: this.type, ...this.semantics }; }
}

export function setDissolveCurvesFromJson(json: any) {
  custom1CurvesByEmitter = new Map();
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.uuid && o.ps?.cfxrCustomData) {
      const custom = o.ps.cfxrCustomData;
      custom1CurvesByEmitter.set(o.uuid, [
        custom.custom1x ?? { type: 'ConstantValue', value: 0 },
        custom.custom1y ?? { type: 'ConstantValue', value: 0 },
        custom.custom1z ?? { type: 'ConstantValue', value: 0 },
        custom.custom1w ?? { type: 'ConstantValue', value: 0 },
      ]);
    }
    if (Array.isArray(o.children)) o.children.forEach(walk);
    if (o.object) walk(o.object);
  };
  walk(json);
}

/** Resolve exporter texture uuid → embedded image URL. */
function resolveMapUrl(
  uuid: string | undefined,
  texByUuid: Map<string, any>,
  imgByUuid: Map<string, any>,
): string | undefined {
  if (!uuid) return undefined;
  const tex = texByUuid.get(uuid);
  if (!tex?.image) return undefined;
  const img = imgByUuid.get(tex.image);
  return img?.url && typeof img.url === 'string' ? img.url : undefined;
}

function resolveCfxrMapRefs(
  props: CfxrMaterialProps,
  texByUuid: Map<string, any>,
  imgByUuid: Map<string, any>,
): CfxrMaterialProps {
  const out: CfxrMaterialProps = { ...props };
  const samplerOf = (tex: any): TextureSamplerSpec | undefined => tex ? {
    wrap: Array.isArray(tex.wrap) && tex.wrap.length >= 2
      ? [Number(tex.wrap[0]), Number(tex.wrap[1])]
      : undefined,
    magFilter: Number.isFinite(tex.magFilter) ? Number(tex.magFilter) : undefined,
    minFilter: Number.isFinite(tex.minFilter) ? Number(tex.minFilter) : undefined,
  } : undefined;
  if (!out.dissolveMapUrl && out.dissolveMap) {
    const tex = texByUuid.get(out.dissolveMap);
    if (tex?.name && !out.dissolveTextureName) out.dissolveTextureName = String(tex.name);
    out.dissolveMapUrl = resolveMapUrl(out.dissolveMap, texByUuid, imgByUuid);
    out.dissolveMapSrgb = !!tex?.sRGB;
    out.dissolveSampler = samplerOf(tex);
  }
  if (!out.maskMapUrl && out.maskMap) {
    const tex = texByUuid.get(out.maskMap);
    out.maskMapUrl = resolveMapUrl(out.maskMap, texByUuid, imgByUuid);
    out.maskMapSrgb = !!tex?.sRGB;
    out.maskSampler = samplerOf(tex);
  }
  if (!out.distortionMapUrl && out.distortionMap) {
    const tex = texByUuid.get(out.distortionMap);
    out.distortionMapUrl = resolveMapUrl(out.distortionMap, texByUuid, imgByUuid);
    out.distortionMapSrgb = !!tex?.sRGB;
    out.distortionSampler = samplerOf(tex);
  }
  if (!out.heightMapUrl && out.heightMap) {
    const tex = texByUuid.get(out.heightMap);
    out.heightMapUrl = resolveMapUrl(out.heightMap, texByUuid, imgByUuid);
    out.heightMapSrgb = !!tex?.sRGB;
    out.heightSampler = samplerOf(tex);
  }
  if (!out.orbAlphaMapUrl && out.orbAlphaMap) {
    const tex = texByUuid.get(out.orbAlphaMap);
    out.orbAlphaMapUrl = resolveMapUrl(out.orbAlphaMap, texByUuid, imgByUuid);
    out.orbAlphaMapSrgb = !!tex?.sRGB;
    out.orbAlphaSampler = samplerOf(tex);
  }
  if (!out.orbNoiseMapUrl && out.orbNoiseMap) {
    const tex = texByUuid.get(out.orbNoiseMap);
    out.orbNoiseMapUrl = resolveMapUrl(out.orbNoiseMap, texByUuid, imgByUuid);
    out.orbNoiseMapSrgb = !!tex?.sRGB;
    out.orbNoiseSampler = samplerOf(tex);
  }
  return out;
}

/** Walk Quarks JSON and index material.cfxr by emitter name. */
export function setCfxrPropsFromJson(json: any) {
  pendingCfxrByEmitter = new Map();
  profilesByEmitter = new Map();
  shapeTransformByEmitter = new Map();
  initialStateByEmitter = new Map();
  childDurationSubEmitterIds = new Set();
  subEmitterInheritanceByEmitter = new Map();
  flipbookTimingByEmitter = new Map();
  rendererPivotByEmitter = new Map();
  sizeTwoCurvesByEmitter = new Map();
  sizeOverLifetimeByEmitter = new Map();
  startSizeTwoCurvesByEmitter = new Map();
  limitVelocity3DByEmitter = new Map();
  limitVelocityByEmitter = new Map();
  velocityOverLifetimeByEmitter = new Map();
  rotation3DByEmitter = new Map();
  trajectoryCacheByEmitter = new Map();
  trailSemanticsByEmitter = new Map();
  trailGeometryByEmitter = new Map();
  const mats = new Map<string, any>();
  for (const m of json.materials || []) mats.set(m.uuid, m);
  const texByUuid = new Map<string, any>();
  for (const t of json.textures || []) texByUuid.set(t.uuid, t);
  const imgByUuid = new Map<string, any>();
  for (const i of json.images || []) imgByUuid.set(i.uuid, i);
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.ps && o.uuid) {
      const pivot = o.ps.rendererEmitterSettings?.unityPivot;
      if (Array.isArray(pivot) && pivot.length >= 3)
        rendererPivotByEmitter.set(o.uuid, [Number(pivot[0]), Number(pivot[1]), Number(pivot[2]),
          Number(o.ps.rendererEmitterSettings?.unityMaxParticleSize ?? 0.5)]);
      if (o.ps.unityShapeTransform) {
        shapeTransformByEmitter.set(o.uuid, o.ps.unityShapeTransform as UnityShapeTransform);
      }
      if (Array.isArray(o.ps.unityInitialState) && o.ps.unityInitialState.length) {
        initialStateByEmitter.set(o.uuid, o.ps.unityInitialState as UnityInitialParticleState[]);
      }
      if (o.ps.unitySubEmitterLifecycle?.schema === 'unity-sub-emitter-lifecycle@1'
          && o.ps.unitySubEmitterLifecycle.termination === 'child-duration') {
        childDurationSubEmitterIds.add(o.uuid);
      }
      const inheritance = (o.ps.behaviors ?? [])
        .filter((behavior: any) => behavior?.type === 'EmitSubParticleSystem')
        .map((behavior: any) => behavior.unityInheritance)
        .filter((spec: any) => spec?.schema === 'unity-sub-emitter-inheritance@1');
      if (inheritance.length) subEmitterInheritanceByEmitter.set(o.uuid, inheritance);
      if (o.ps.unityTrajectoryCache?.schema === 'particle-trajectory-cache@4'
          || o.ps.unityTrajectoryCache?.schema === 'particle-trajectory-cache@5'
          || o.ps.unityTrajectoryCache?.schema === 'particle-trajectory-cache@6') {
        if (o.ps.unityTrajectoryCache.schema === 'particle-trajectory-cache@6') {
          const cachedTileCount = Math.max(1,
            Number(o.ps.uTileCount ?? 1) * Number(o.ps.vTileCount ?? 1));
          for (const track of o.ps.unityTrajectoryCache.tracks ?? []) {
            const last = track.samples?.[track.samples.length - 1];
            const terminal = track.termination;
            if (!last || !terminal
                || !Array.isArray(terminal.position)
                || terminal.firstAbsentAge + 1e-6 < terminal.lastVisibleAge
                || Math.abs(terminal.lastVisibleAge - last.age) > 1e-3) {
              throw new Error(
                `Emitter ${o.name ?? o.uuid} has an incomplete particle-trajectory-cache@6 terminal contract`,
              );
            }
            let priorAge = -Infinity;
            for (const sample of track.samples ?? []) {
              if (!(Number(sample.age) >= priorAge))
                throw new Error(`Emitter ${o.name ?? o.uuid} has non-monotonic trajectory samples`);
              priorAge = Number(sample.age);
              // Broad package discovery may intentionally omit native BakeMesh frame capture
              // for crash-prone marketplace renderers. In that case the live UnityFrameOverLife
              // behavior remains authoritative; the trajectory cache still supplies position,
              // size, color and rotation. Exact captured cells are used when present.
              if (cachedTileCount > 1 && sample.frame != null
                  && (!Number.isInteger(sample.frame)
                    || sample.frame < 0 || sample.frame >= cachedTileCount))
                throw new Error(`Emitter ${o.name ?? o.uuid} trajectory sample has an invalid flipbook frame`);
            }
          }
        }
        trajectoryCacheByEmitter.set(o.uuid, o.ps.unityTrajectoryCache as UnityTrajectoryCache);
      }
      if (o.ps.unityTrailSemantics?.schema === 'unity-trail-semantics@1'
          || o.ps.unityTrailSemantics?.schema === 'unity-trail-semantics@2')
        trailSemanticsByEmitter.set(o.uuid, o.ps.unityTrailSemantics as UnityTrailSemantics);
      if (o.ps.unityTrailGeometry?.schema === 'unity-trail-geometry@1'
          || o.ps.unityTrailGeometry?.schema === 'unity-trail-geometry@2')
        trailGeometryByEmitter.set(
          o.uuid,
          decodeUnityTrailGeometry(o.ps.unityTrailGeometry as UnityTrailGeometry | EncodedUnityTrailGeometry),
        );
      if (o.ps.unitySizeOverLifetime?.type === 'UnityTwoCurves@1')
        sizeTwoCurvesByEmitter.set(o.uuid, o.ps.unitySizeOverLifetime);
      else if (o.ps.unitySizeOverLifetime?.schema === 'unity-size-over-lifetime@1')
        sizeOverLifetimeByEmitter.set(o.uuid, o.ps.unitySizeOverLifetime);
      if (o.ps.unityStartSize?.type === 'UnityTwoCurves@1')
        startSizeTwoCurvesByEmitter.set(o.uuid, o.ps.unityStartSize);
      if (o.ps.unityLimitVelocity3D?.schema === 'unity-limit-velocity-3d@1')
        limitVelocity3DByEmitter.set(o.uuid, o.ps.unityLimitVelocity3D);
      if (o.ps.unityLimitVelocity?.schema === 'unity-limit-velocity@1')
        limitVelocityByEmitter.set(o.uuid, o.ps.unityLimitVelocity);
      if (o.ps.unityVelocityOverLifetime?.schema === 'unity-velocity-over-lifetime@1')
        velocityOverLifetimeByEmitter.set(o.uuid, o.ps.unityVelocityOverLifetime);
      if (o.ps.unityRotationOverLifetime3D)
        rotation3DByEmitter.set(o.uuid, o.ps.unityRotationOverLifetime3D);
      const mode = o.ps.unityFlipbookTimeMode;
      const range = o.ps.unityFlipbookSpeedRange;
      if ((mode === 'lifetime' || mode === 'speed') && Array.isArray(range) && range.length >= 2) {
        flipbookTimingByEmitter.set(o.uuid, {
          mode,
          speedRange: [Number(range[0]), Number(range[1])],
        });
      }
      const mat = mats.get(o.ps.material);
      const program = mat?.vfxProgram;
      if (program?.schema !== 'particle-material-program@2' || !Array.isArray(program.operations)) {
        throw new Error(`Material ${mat?.name ?? o.ps.material} lacks particle-material-program@2`);
      }
      const supportedOps = new Set([
        'sample-main', 'coverage', 'vertex-color', 'tint', 'front-back-lerp',
        'mask', 'dissolve', 'scene-refraction', 'soft-particle-depth',
        'dynamic-alpha-clip', 'hdr-multiply', 'blend', 'manual-graph-lowering', 'legacy-multiply-colored',
        'manual-material-lowering',
        'vertex-color-space',
        'legacy-particle-multiply', 'legacy-particle-premultiply', 'legacy-double-tint',
        'ambient-probe-lighting',
      ]);
      for (const instruction of program.operations) {
        if (!instruction || !supportedOps.has(instruction.op)) {
          throw new Error(
            `Material ${mat?.name ?? o.ps.material} contains unsupported IR op '${instruction?.op}'`,
          );
        }
      }
      const dynamicClip = program.operations.find(
        (instruction: any) => instruction?.op === 'dynamic-alpha-clip',
      );
      if (dynamicClip && ![
        'custom1.x', 'custom1.y', 'custom1.z', 'custom1.w', 'uv1.x', 'uv1.y',
      ].includes(dynamicClip.source)) {
        throw new Error(
          `Material ${mat?.name ?? o.ps.material} has unsupported dynamic alpha clip source '${dynamicClip.source}'`,
        );
      }
      const ambientLighting = program.operations.find(
        (instruction: any) => instruction?.op === 'ambient-probe-lighting',
      );
      if (ambientLighting && ambientLighting.model !== 'unity-urp-lit-reference@1') {
        throw new Error(
          `Material ${mat?.name ?? o.ps.material} has unsupported lighting model '${ambientLighting.model}'`,
        );
      }
      const manual = program.operations.find((instruction: any) => instruction?.op === 'manual-graph-lowering');
      if (manual) {
        const match = /^(.*)@(\d+)$/.exec(String(manual.id ?? ''));
        const adapter = match
          ? adapterRegistry.adapters.find((candidate) => candidate.kind === 'material'
              && candidate.id === match[1] && candidate.version === Number(match[2]))
          : undefined;
        if (!adapter || adapter.sourceGraphHash !== program.sourceGraphHash
            || manual.sourceGraphHash !== program.sourceGraphHash) {
          throw new Error(
            `Unreviewed manual graph lowering '${manual.id}' for source ${program.sourceGraphHash}`,
          );
        }
      }
      const manualMaterial = program.operations.find(
        (instruction: any) => instruction?.op === 'manual-material-lowering',
      );
      if (manualMaterial) {
        const match = /^(.*)@(\d+)$/.exec(String(manualMaterial.id ?? ''));
        const adapter = match
          ? adapterRegistry.adapters.find((candidate: any) => candidate.kind === 'material'
              && candidate.id === match[1] && candidate.version === Number(match[2])) as any
          : undefined;
        const registered = adapter?.semantics?.materials?.find(
          (entry: any) => entry.sourceMaterialGuid === program.sourceMaterialGuid,
        );
        if (!adapter || !registered
            || Number(registered.alphaFactor) !== Number(manualMaterial.alphaFactor)
            || manualMaterial.sourceMaterialGuid !== program.sourceMaterialGuid) {
          throw new Error(
            `Unreviewed manual material lowering '${manualMaterial.id}' for material ${program.sourceMaterialGuid}`,
          );
        }
      }
      const vertexColorSpace = program.operations.find(
        (instruction: any) => instruction?.op === 'vertex-color-space',
      );
      if (vertexColorSpace) {
        const match = /^(.*)@(\d+)$/.exec(String(vertexColorSpace.id ?? ''));
        const adapter = match
          ? adapterRegistry.adapters.find((candidate: any) => candidate.kind === 'material'
              && candidate.id === match[1] && candidate.version === Number(match[2])) as any
          : undefined;
        const registered = adapter?.semantics?.materials?.some(
          (entry: any) => entry.sourceMaterialGuid === program.sourceMaterialGuid,
        );
        if (!registered || vertexColorSpace.sourceMaterialGuid !== program.sourceMaterialGuid
            || vertexColorSpace.space !== 'raw-linear-attribute') {
          throw new Error(
            `Unreviewed vertex color space '${vertexColorSpace.id}' for material ${program.sourceMaterialGuid}`,
          );
        }
      }
      if (program?.profile) {
        const resolved = resolveCfxrMapRefs(
          program.profile as CfxrMaterialProps,
          texByUuid,
          imgByUuid,
        );
        // `particle-material-program@2.blend` is the authoritative blend semantic.
        // Do not rely on the legacy profile duplicating it: reviewed shader-family
        // compilers intentionally emit a minimal profile.  Without this lowering,
        // patchCfxrBeforeBatch() replaces the correctly parsed material state with
        // NormalBlending, turning black additive texels into opaque rectangles.
        switch (program.blend) {
          case 'additive':
            resolved.additive = true;
            resolved.legacyMultiplyColored = false;
            resolved.legacyPremultiply = false;
            break;
          case 'alpha':
            resolved.additive = false;
            resolved.legacyMultiplyColored = false;
            resolved.legacyPremultiply = false;
            break;
          case 'multiply':
            resolved.additive = false;
            resolved.legacyMultiplyColored = true;
            resolved.legacyPremultiply = false;
            break;
          case 'premultiplied-alpha':
            resolved.additive = false;
            resolved.legacyMultiplyColored = false;
            resolved.legacyPremultiply = true;
            break;
          default:
            throw new Error(
              `Unsupported particle-material-program blend '${String(program.blend)}' on ${mat.name ?? mat.uuid}`,
            );
        }
        if (Array.isArray(o.ps.unityRendererFlip)) {
          resolved.flipX = !!o.ps.unityRendererFlip[0];
          resolved.flipY = !!o.ps.unityRendererFlip[1];
        }
        resolved.coverageChannel = program.coverageSource === 'alpha'
          ? 'alpha'
          : program.coverageSource === 'red' ? 'red'
          : program.coverageSource === 'green' ? 'green' : 'luminance';
        if (dynamicClip) {
          resolved.dynamicAlphaClip = true;
          resolved.dynamicAlphaClipSource = dynamicClip.source;
          resolved.dynamicAlphaClipScale = Number(dynamicClip.scale ?? 1);
        }
        const mainTexture = texByUuid.get(mat.map ?? mat.texture);
        if (typeof mainTexture?.sRGB === 'boolean') resolved.mainMapSrgb = mainTexture.sRGB;
        pendingCfxrByEmitter.set(o.uuid, resolved);
      }
    }
    if (Array.isArray(o.children)) o.children.forEach(walk);
    if (o.object) walk(o.object);
  };
  walk(json);
}

function estimateStartSpeed(system: ParticleSystem): number {
  const ss = system.startSpeed as { value?: number; a?: number; b?: number };
  if (typeof ss?.value === 'number') return Math.abs(ss.value);
  if (typeof ss?.a === 'number' && typeof ss?.b === 'number') return Math.max(Math.abs(ss.a), Math.abs(ss.b));
  return 0;
}

export function patchCfxrBeforeBatch(root: Object3D) {
  root.traverse((child) => {
    if (child.type !== 'ParticleEmitter') return;
    const emitter = child as ParticleEmitter;
    const system = emitter.system as ParticleSystem | undefined;
    if (!system) return;

    const mat = system.material as MeshBasicMaterial & {
      userData: { cfxr?: CfxrRuntimeProfile; particleMat?: { alphaClip?: boolean } };
    };
    if (!mat?.isMaterial) return;

    // Shared basics for every Quarks material
    mat.transparent = true;
    mat.depthWrite = false;
    mat.toneMapped = false;
    mat.side = DoubleSide;
    if (mat.map) {
      mat.map.colorSpace = SRGBColorSpace;
      mat.map.needsUpdate = true;
    }

    // Apply the exported stretch mapping exactly. Never switch render modes from a visual
    // threshold: unsupported semantics must be rejected by the strict exporter.
    if (system.renderMode === RenderMode.StretchedBillBoard) {
      remapUnityStretchToQuarks(system);
    }

    const shapeTransform = shapeTransformByEmitter.get(emitter.uuid);
    if (shapeTransform) patchUnityShapeTransform(system, shapeTransform);
    const initialStates = initialStateByEmitter.get(emitter.uuid);
    if (initialStates && !system.behaviors.some((b) => b.type === 'UnityInitialState')) {
      system.behaviors.unshift(new UnityInitialStateBehavior(
        initialStates,
        system.looping ? system.duration : undefined,
      ));
      system.behaviors.splice(1, 0, new UnityGlobalAgeBehavior());
    }
    if (initialStates) patchCalibratedBirthSubEmitters(system);
    patchChildDurationSubEmitters(system, subEmitterInheritanceByEmitter.get(emitter.uuid) ?? []);
    const custom1Curves = custom1CurvesByEmitter.get(emitter.uuid);
    if (custom1Curves && !system.behaviors.some((b) => b.type === 'UnityCustom1')) {
      system.behaviors.push(new UnityCustom1Behavior(custom1Curves));
    }
    const sizeTwoCurves = sizeTwoCurvesByEmitter.get(emitter.uuid);
    if (sizeTwoCurves) {
      const index = system.behaviors.findIndex((b) => b.type === 'SizeOverLife');
      if (index >= 0) system.behaviors.splice(index, 1, new UnitySizeTwoCurvesBehavior(sizeTwoCurves));
      else system.behaviors.push(new UnitySizeTwoCurvesBehavior(sizeTwoCurves));
    }
    const strictSize = sizeOverLifetimeByEmitter.get(emitter.uuid);
    if (strictSize) {
      const index = system.behaviors.findIndex((b) => b.type === 'SizeOverLife');
      if (index >= 0)
        system.behaviors.splice(index, 1, new UnitySizeOverLifetimeBehavior(strictSize));
      else system.behaviors.push(new UnitySizeOverLifetimeBehavior(strictSize));
    }
    const startSizeTwoCurves = startSizeTwoCurvesByEmitter.get(emitter.uuid);
    if (startSizeTwoCurves) system.startSize = new UnityTwoCurvesGenerator(startSizeTwoCurves);
    const limitVelocity3D = limitVelocity3DByEmitter.get(emitter.uuid);
    if (limitVelocity3D) system.behaviors.push(new UnityLimitVelocity3DBehavior(limitVelocity3D));
    const limitVelocity = limitVelocityByEmitter.get(emitter.uuid);
    if (limitVelocity) {
      const stockIndex = system.behaviors.findIndex((behavior) => behavior.type === 'LimitSpeedOverLife');
      if (stockIndex >= 0) system.behaviors.splice(stockIndex, 1);
      system.behaviors.push(new UnityLimitVelocityBehavior(limitVelocity));
    }
    const velocityOverLifetime = velocityOverLifetimeByEmitter.get(emitter.uuid);
    if (velocityOverLifetime)
      // Apply after force/gravity behaviors so the module owns only its additive velocity
      // offset; calibrated initial-state behaviors have already restored the base state.
      system.behaviors.push(new UnityVelocityOverLifetimeBehavior(velocityOverLifetime));
    const rotation3D = rotation3DByEmitter.get(emitter.uuid);
    if (rotation3D) {
      const index = system.behaviors.findIndex((b) => b.type === 'RotationOverLife');
      if (index >= 0) system.behaviors.splice(index, 1);
      system.behaviors.push(new UnityRotation3DBehavior(rotation3D));
    }
    // Replace stock flipbook evaluation before material handling: simulation semantics do not
    // depend on a particular shader family.
    const tileCount = (system.uTileCount || 1) * (system.vTileCount || 1);
    const flipbook = system as unknown as {
      unityFlipbookFrameCount?: number;
      unityFlipbookSingleRow?: boolean;
      unityFlipbookRowIndex?: number;
      unityFlipbookRandomRow?: boolean;
    };
    const frameCount = flipbook.unityFlipbookFrameCount ?? tileCount;
    const singleRow = flipbook.unityFlipbookSingleRow
      ? {
          columns: Math.max(1, system.uTileCount || 1),
          rows: Math.max(1, system.vTileCount || 1),
          rowIndex: flipbook.unityFlipbookRowIndex ?? 0,
          randomRow: !!flipbook.unityFlipbookRandomRow,
        }
      : undefined;
    if (tileCount > 1) {
      const frameIndex = system.behaviors.findIndex((b) => b.type === 'FrameOverLife');
      if (frameIndex >= 0) {
        const stock = system.behaviors[frameIndex] as Behavior & {
          frame?: ConstructorParameters<typeof UnityFrameOverLifeBehavior>[0];
        };
        const timing = flipbookTimingByEmitter.get(emitter.uuid) ?? {
          mode: 'lifetime' as const,
          speedRange: [0, 1] as [number, number],
        };
        const fixedSpeedFrames = timing.mode === 'speed'
          && !!initialStates?.length
          && initialStates.every((state) => state.frame != null && state.frame >= 0);
        if (fixedSpeedFrames) {
          // Unity supplied the fixed-seed, speed-evaluated atlas cell in the spawn sample.
          system.behaviors.splice(frameIndex, 1);
        } else if (stock.frame) {
          system.behaviors.splice(
            frameIndex,
            1,
            new UnityFrameOverLifeBehavior(stock.frame, frameCount, timing.mode, timing.speedRange, singleRow),
          );
        }
      }
    }
    const trajectoryCache = trajectoryCacheByEmitter.get(emitter.uuid);
    (system as unknown as { unityRendererPivot?: [number, number, number, number] }).unityRendererPivot =
      rendererPivotByEmitter.get(emitter.uuid) ?? [0, 0, 0, 0.5];
    if (trajectoryCache && !system.behaviors.some((b) => b.type === 'UnityTrajectoryCache')) {
      // Last simulation behavior: it applies the exact camera-independent Unity state sample,
      // including Custom1 streams when a reviewed graph consumes them.
      system.behaviors.push(new UnityTrajectoryCacheBehavior(trajectoryCache));
    }
    const trailSemantics = trailSemanticsByEmitter.get(emitter.uuid);
    if (trailSemantics && !system.behaviors.some((b) => b.type === 'UnityTrailSemantics')) {
      const trailBehavior = new UnityTrailSemanticsBehavior(
        trailSemantics,
        trailGeometryByEmitter.get(emitter.uuid),
      );
      // Quarks' Behavior.initialize callback is particle-only in the runtime build, so the
      // geometry-backed Trail lowering cannot discover its owning system through that callback.
      // Bind it at compile time; frameUpdate() then consumes the Unity-baked ribbon for the
      // correct emitter instead of silently falling back to head sprites.
      (trailBehavior as unknown as { system?: IParticleSystem }).system =
        system as unknown as IParticleSystem;
      system.behaviors.push(trailBehavior);
    }
    if (initialStates && !system.behaviors.some((b) => b.type === 'UnitySpawnVisibility')) {
      system.behaviors.push(new UnitySpawnVisibilityBehavior());
    }

    // CFXR ubershader only when exporter wrote a real `cfxr` block.
    const props = pendingCfxrByEmitter.get(emitter.uuid);
    if (!props) {
      mat.needsUpdate = true;
      return;
    }

    const profile = propsToProfile(props);

    if (profile.proceduralRing && !mat.map) {
      mat.map = getSoftRingTexture(profile.ringTopOffset);
      system.rendererSettings.renderMode = RenderMode.HorizontalBillBoard;
    }

    if (mat.map) {
      mat.map.colorSpace = profile.mainMapSrgb ? SRGBColorSpace : NoColorSpace;
      mat.map.needsUpdate = true;
    }

    // Mesh particles use size.z as geometry scale — encode dissolveTime in uvTile instead.
    // Only safe when sheet animation is unused (1×1) or we aren't fighting FrameOverLife.
    const meshParticles = system.renderMode === RenderMode.Mesh;
    const hasSheetAnim =
      tileCount > 1 || system.behaviors.some((b) => b.type === 'FrameOverLife');
    const dissolveViaUvTile = meshParticles
      && (profile.dissolve || profile.dynamicAlphaClip) && !hasSheetAnim;

    const profileForBatch: CfxrRuntimeProfile = {
      ...profile,
      dissolveViaUvTile,
      tileCounts: [system.uTileCount || 1, system.vTileCount || 1],
      unityCenteredStretch: system.renderMode === RenderMode.StretchedBillBoard,
      unityVerticalBillboard: system.renderMode === RenderMode.VerticalBillBoard,
    };

    applySemanticBlendState(mat, profileForBatch);
    mat.userData.cfxr = profileForBatch;
    profilesByEmitter.set(emitter.uuid, profileForBatch);

    // Custom1 is transported by its own instanced vec4 attribute. Never smuggle semantic
    // channels through size.z or uvTile: those fields belong to mesh scale / flipbook state and
    // corrupt stretched billboards and mesh particles when the material also clips or dissolves.
    if (!system.behaviors.some((behavior) => behavior.type === 'UnityColor32')) {
      system.behaviors.push(new UnityColor32Behavior());
    }

    mat.needsUpdate = true;
  });
}

/**
 * Unity Stretched Billboard (Shuriken):
 *   width  = size
 *   length = size × lengthScale + speed × velocityScale
 * Quarks non-SKEW shader receives `velocity * speedFactor` from SpriteBatch:
 *   length = (speed × speedFactor + lengthFactor) × avgSize
 * Unity coefficients are preserved verbatim. The stock Quarks shader multiplies its complete
 * length by avgSize, which makes velocity stretch vary with particle size. Our reviewed vertex
 * lowering below evaluates Unity's equation directly, including variable size over lifetime.
 */
export function remapUnityStretchToQuarks(system: ParticleSystem) {
  const s = system.rendererEmitterSettings as { speedFactor?: number; lengthFactor?: number };
  s.speedFactor = s.speedFactor ?? 0;
  s.lengthFactor = s.lengthFactor ?? 1;
}

const texCache = new Map<string, Promise<Texture>>();
function loadCfxrTexture(
  url: string,
  srgb: boolean,
  sampler?: TextureSamplerSpec,
): Promise<Texture> {
  const key = `${srgb ? 'srgb' : 'linear'}:${JSON.stringify(sampler ?? {})}:${url}`;
  if (!texCache.has(key)) {
    texCache.set(
      key,
      new TextureLoader()
        .loadAsync(url)
        .then((tex) => {
          tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
          if (sampler?.wrap) {
            tex.wrapS = sampler.wrap[0] as typeof tex.wrapS;
            tex.wrapT = sampler.wrap[1] as typeof tex.wrapT;
          }
          if (sampler?.magFilter != null)
            tex.magFilter = sampler.magFilter as typeof tex.magFilter;
          if (sampler?.minFilter != null)
            tex.minFilter = sampler.minFilter as typeof tex.minFilter;
          tex.needsUpdate = true;
          return tex;
        })
        .catch((error) => {
          throw new Error(`Strict material program texture failed to load: ${url}`, { cause: error });
        }),
    );
  }
  return texCache.get(key)!;
}

/** Scene-color RT for Shader Graph Scene Color / distortion (set each frame by the player). */
let sharedSceneColor: Texture | null = null;
let sharedSceneDepth: Texture | null = null;
let sharedEffectTime = 0;
const sceneInputMaterials = new Set<ShaderMaterial>();

export function setCfxrEffectTime(seconds: number) {
  sharedEffectTime = seconds;
  for (const mat of sceneInputMaterials) {
    if (mat.uniforms?.effectTime) mat.uniforms.effectTime.value = seconds;
  }
}

export function setCfxrSceneColorTexture(
  tex: Texture | null,
  depth: Texture | null,
  width = 1,
  height = 1,
  near = 0.1,
  far = 1000,
) {
  sharedSceneColor = tex;
  sharedSceneDepth = depth;
  for (const mat of sceneInputMaterials) {
    if (mat.uniforms?.sceneColorMap) mat.uniforms.sceneColorMap.value = tex;
    if (mat.uniforms?.sceneDepthMap) mat.uniforms.sceneDepthMap.value = depth;
    if (mat.uniforms?.sceneColorSize) mat.uniforms.sceneColorSize.value.set(width, height, 0);
    if (mat.uniforms?.cameraNear) mat.uniforms.cameraNear.value = near;
    if (mat.uniforms?.cameraFar) mat.uniforms.cameraFar.value = far;
  }
}

export function cfxrNeedsSceneColor(): boolean {
  return sceneInputMaterials.size > 0;
}

type Custom1Batch = {
  geometry: {
    getAttribute: (name: string) => InstancedBufferAttribute | undefined;
    setAttribute: (name: string, attribute: InstancedBufferAttribute) => void;
  };
  getVisibleSystems: () => Array<IParticleSystem>;
};

/**
 * Upload Unity's Custom1.xyzw vertex stream in exactly the same flattened instance order used
 * by SpriteBatch. This is an IR transport, not a visual heuristic: graph lowerings explicitly
 * consume the channel(s) they declared in the exported material program.
 */
export function updateCfxrCustomAttributes(batchRenderer: BatchedRenderer) {
  for (const rawBatch of batchRenderer.batches) {
    const batch = rawBatch as unknown as Custom1Batch;
    if (!batch.geometry?.getAttribute || !batch.getVisibleSystems) continue;
    // TrailBatch is vertex-expanded (two vertices per history sample), not instance-expanded.
    // Its authored adapters currently consume neither per-particle Custom1 nor Custom2 when
    // their material-folded toggles are off. Attaching InstancedBufferAttributes to this
    // non-instanced geometry changes the draw contract and can suppress the trail entirely.
    if (batch.geometry.getAttribute('previous')) continue;
    const instanceCapacity = batch.geometry.getAttribute('color')?.count ?? 0;
    if (instanceCapacity <= 0) continue;

    let attribute = batch.geometry.getAttribute('cfxrCustom1');
    if (!attribute || attribute.count < instanceCapacity) {
      attribute = new InstancedBufferAttribute(new Float32Array(instanceCapacity * 4), 4);
      attribute.setUsage(DynamicDrawUsage);
      batch.geometry.setAttribute('cfxrCustom1', attribute);
    }
    let attribute2 = batch.geometry.getAttribute('cfxrCustom2');
    if (!attribute2 || attribute2.count < instanceCapacity) {
      attribute2 = new InstancedBufferAttribute(new Float32Array(instanceCapacity * 4), 4);
      attribute2.setUsage(DynamicDrawUsage);
      batch.geometry.setAttribute('cfxrCustom2', attribute2);
    }
    let flipAttribute = batch.geometry.getAttribute('cfxrUvFlip');
    if (!flipAttribute || flipAttribute.count < instanceCapacity) {
      flipAttribute = new InstancedBufferAttribute(new Float32Array(instanceCapacity * 2), 2);
      flipAttribute.setUsage(DynamicDrawUsage);
      batch.geometry.setAttribute('cfxrUvFlip', flipAttribute);
    }
    let pivotAttribute = batch.geometry.getAttribute('cfxrRendererPivot');
    if (!pivotAttribute || pivotAttribute.count < instanceCapacity) {
      pivotAttribute = new InstancedBufferAttribute(new Float32Array(instanceCapacity * 4), 4);
      pivotAttribute.setUsage(DynamicDrawUsage);
      batch.geometry.setAttribute('cfxrRendererPivot', pivotAttribute);
    }

    let index = 0;
    for (const system of batch.getVisibleSystems()) {
      for (let i = 0; i < system.particleNum; i++, index++) {
        const custom = (system.particles[i] as UnityCustom1Particle).unityCustom1 ?? [0, 0, 0, 0];
        attribute.setXYZW(index, custom[0], custom[1], custom[2], custom[3]);
        const custom2 = (system.particles[i] as UnitySemanticParticle).unityCustom2 ?? [0, 0, 0, 0];
        attribute2.setXYZW(index, custom2[0], custom2[1], custom2[2], custom2[3]);
        const flip = (system.particles[i] as UnitySemanticParticle).unityRendererFlip
          ?? [false, false];
        flipAttribute.setXY(index, flip[0] ? 1 : 0, flip[1] ? 1 : 0);
        const pivot = (system as unknown as { unityRendererPivot?: [number, number, number, number] })
          .unityRendererPivot ?? [0, 0, 0, 0.5];
        pivotAttribute.setXYZW(index, pivot[0], pivot[1], pivot[2], pivot[3]);
      }
    }
    attribute.clearUpdateRanges();
    if (index > 0) attribute.addUpdateRange(0, index * 4);
    attribute.needsUpdate = true;
    attribute2.needsUpdate = true;
    flipAttribute.needsUpdate = true;
    pivotAttribute.needsUpdate = true;
  }
}

function injectCfxrShader(
  mat: ShaderMaterial,
  profile: CfxrRuntimeProfile,
  maps: { dissolve: Texture | null; mask: Texture | null; distortion: Texture | null; height: Texture | null; orbAlpha: Texture | null; orbNoise: Texture | null },
) {
  const defines: Record<string, string> = { ...((mat.defines ?? {}) as Record<string, string>) };
  delete defines.USE_COLOR_AS_ALPHA;
  if (profile.singleChannel) defines.CFXR_SINGLE_CHANNEL = '1';
  else delete defines.CFXR_SINGLE_CHANNEL;
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
  if (profile.dissolve && profile.invertDissolve) defines.CFXR_INVERT_DISSOLVE = '1';
  else delete defines.CFXR_INVERT_DISSOLVE;
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
  if (profile.dynamicAlphaClipSource === 'custom1.y') defines.CFXR_DYNAMIC_ALPHA_CLIP_Y = '1';
  else if (profile.dynamicAlphaClipSource === 'custom1.z') defines.CFXR_DYNAMIC_ALPHA_CLIP_Z = '1';
  else if (profile.dynamicAlphaClipSource === 'custom1.w') defines.CFXR_DYNAMIC_ALPHA_CLIP_W = '1';
  else if (profile.dynamicAlphaClipSource === 'uv1.x') defines.CFXR_DYNAMIC_ALPHA_CLIP_UV1_X = '1';
  else if (profile.dynamicAlphaClipSource === 'uv1.y') defines.CFXR_DYNAMIC_ALPHA_CLIP_UV1_Y = '1';
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
  // The strict IR uses Unity Shader Graph's deterministic uint hash for Simple Noise.
  // WebGL2/GLSL3 is required; falling back to a sine hash changes authored pixels.
  mat.glslVersion = GLSL3;

  mat.uniforms.hdrMultiply = { value: Math.max(0, profile.hdr) };
  mat.uniforms.dissolveSmooth = { value: profile.dissolveSmooth };
  mat.uniforms.dissolveMap = { value: maps.dissolve };
  mat.uniforms.dissolveScroll = { value: new Vector2(...profile.dissolveScroll) };
  mat.uniforms.maskMap = { value: maps.mask };
  mat.uniforms.maskSpeed = { value: new Vector2(...profile.maskSpeed) };
  mat.uniforms.maskRotation = { value: profile.maskRotation };
  mat.uniforms.maskRotationCenter = { value: new Vector2(...profile.maskRotationCenter) };
  mat.uniforms.maskOffset = { value: new Vector2(...profile.maskOffset) };
  mat.uniforms.trailUvRotation = { value: profile.trailUvRotation };
  mat.uniforms.trailUvStretch = { value: profile.trailUvStretch };
  mat.uniforms.trailUvStretchY = { value: profile.trailUvStretchY ? 1 : 0 };
  mat.uniforms.trailUvScroll = { value: new Vector2(...profile.trailUvScroll) };
  mat.uniforms.trailUvTiling = { value: new Vector2(...profile.trailUvTiling) };
  mat.uniforms.trailUvOffset = { value: new Vector2(...profile.trailUvOffset) };
  mat.uniforms.trailUvDistortionPower = { value: profile.trailUvDistortionPower };
  mat.uniforms.trailUvDistortionSpeed = { value: new Vector2(...profile.trailUvDistortionSpeed) };
  mat.uniforms.maskNoiseScale = { value: profile.maskNoiseScale };
  mat.uniforms.effectTime = { value: sharedEffectTime };
  mat.uniforms.distortionMap = { value: maps.distortion };
  mat.uniforms.distortionAmount = { value: profile.distortionAmount };
  mat.uniforms.slashWorldScreenOffset = {
    value: new Vector2(...profile.slashWorldScreenOffset),
  };
  // Pure refraction sheets (no own HDR emission) stay visible via the distortion signal;
  // emissive materials (Slash core) must not get an alpha floor everywhere.
  mat.uniforms.distortionAlphaFloor = {
    value: profile.useDistortion && profile.hdr <= 1.001 ? 0.55 : 0,
  };
  mat.uniforms.vertColorRgbOn = { value: profile.vertexColorRgb ? 1 : 0 };
  mat.uniforms.vertColorAlphaOn = { value: profile.vertexColorAlpha ? 1 : 0 };
  mat.uniforms.vertColorGain = { value: profile.legacyVertexColorGain };
  mat.uniforms.backColorMul = {
    value: new Vector3(...(profile.backColorMul ?? [1, 1, 1])),
  };
  mat.uniforms.heightMap = { value: maps.height };
  mat.uniforms.parallaxAmplitude = { value: profile.parallaxAmplitude };
  mat.uniforms.orbAlphaMap = { value: maps.orbAlpha };
  mat.uniforms.orbNoiseMap = { value: maps.orbNoise };
  mat.uniforms.orbColour = { value: new Vector3(...profile.orbColour) };
  mat.uniforms.orbFresnelColor = { value: new Vector4(...profile.orbFresnelColor) };
  mat.uniforms.orbNoiseAnimation = { value: new Vector2(...profile.orbNoiseAnimation) };
  mat.uniforms.orbWarpSpeed = { value: new Vector2(...profile.orbWarpSpeed) };
  mat.uniforms.orbFresnelPower = { value: profile.orbFresnelPower };
  mat.uniforms.orbNoiseScale = { value: profile.orbNoiseScale };
  mat.uniforms.orbNoiseFrequency = { value: profile.orbNoiseFrequency };
  mat.uniforms.orbNoiseAmplitude = { value: profile.orbNoiseAmplitude };
  mat.uniforms.orbOctaveFrequencyScale = { value: profile.orbOctaveFrequencyScale };
  mat.uniforms.orbOctaveAmplitudeScale = { value: profile.orbOctaveAmplitudeScale };
  mat.uniforms.orbOctaveDomainWarping = { value: profile.orbOctaveDomainWarping };
  mat.uniforms.orbNoisePower = { value: profile.orbNoisePower };
  mat.uniforms.orbUvClipScale = { value: profile.orbUvClipScale };
  mat.uniforms.sceneColorMap = { value: sharedSceneColor };
  mat.uniforms.sceneDepthMap = { value: sharedSceneDepth };
  mat.uniforms.sceneColorSize = {
    value: new Vector3(
      (sharedSceneColor as { image?: { width?: number; height?: number } } | null)?.image?.width || 1,
      (sharedSceneColor as { image?: { width?: number; height?: number } } | null)?.image?.height || 1,
      0,
    ),
  };
  mat.uniforms.softFadeAmount = { value: profile.softFade ? 1 : 0 };
  mat.uniforms.softParticleStrength = { value: profile.softParticleStrength };
  mat.uniforms.cameraNear = { value: 0.1 };
  mat.uniforms.cameraFar = { value: 1000 };
  // Zero is meaningful for a material-less Unity renderer compiled as simulation-only.
  mat.uniforms.opacityGain = { value: Math.max(0, profile.opacity) };
  mat.uniforms.legacyAlphaTintFactor = {
    value: Math.max(0, profile.legacyAlphaTintFactor),
  };
  mat.uniforms.alphaClipThreshold = {
    value: Math.max(0, Math.min(1, profile.alphaClipThreshold)),
  };
  mat.uniforms.dynamicAlphaClipScale = { value: profile.dynamicAlphaClipScale };
  mat.uniforms.texPower = { value: Math.max(0.01, profile.texPower) };
  mat.uniforms.colorPower = { value: Math.max(0.01, profile.colorPower) };
  mat.uniforms.materialColor = {
    value: new Vector3(profile.colorMul[0], profile.colorMul[1], profile.colorMul[2]),
  };
  mat.uniforms.ambientSky = { value: new Vector3(...profile.ambientSky) };
  mat.uniforms.ambientEquator = { value: new Vector3(...profile.ambientEquator) };
  mat.uniforms.ambientGround = { value: new Vector3(...profile.ambientGround) };
  mat.uniforms.ambientSH = {
    value: profile.ambientSH.map((coefficient) => new Vector3(...coefficient)),
  };
  mat.uniforms.tileCounts = { value: new Vector2(...profile.tileCounts) };

  applySemanticBlendState(mat, profile);
  mat.transparent = true;
  mat.depthWrite = false;
  mat.toneMapped = false;
  mat.side = profile.doubleSided ? DoubleSide : FrontSide;
  // Batch copies MeshBasicMaterial.alphaTest → USE_ALPHATEST; our fragment has no alphatest chunk.
  mat.alphaTest = 0;
  delete defines.USE_ALPHATEST;

  if (profile.unityCenteredStretch) {
    const quarksStretch = `mvPosition.xyz += position.y * normalize(cross(mvPosition.xyz, viewVelocity)) * avgSize; // switch the cross to  match unity implementation
    mvPosition.xyz -= (position.x + 0.5) * viewVelocity * (1.0 + lengthFactor / vlength) * avgSize; // minus position.x to match unity implementation`;
    if (!mat.vertexShader.includes(quarksStretch)) {
      throw new Error(
        'Strict Unity stretched-billboard lowering failed: Quarks vertex template changed',
      );
    }
    mat.vertexShader = mat.vertexShader.replace(
      quarksStretch,
      `vec3 unityWidth = normalize(cross(viewVelocity, mvPosition.xyz));
    // BakeMesh keeps the complete depth component: Unity's long axis is the normalized
    // view-space velocity, not its projection onto the camera plane.
    vec3 unityLength = normalize(viewVelocity);
    // Unity/Quarks stretched billboards use quad X (texture U) as the length axis and
    // quad Y (texture V) as the width axis. The particle position is the tail, so remap
    // the centered PlaneGeometry X range [-.5,.5] to [0,1] along the motion direction.
    // SpriteBatch has already multiplied velocity.xyz by renderer velocityScale before this
    // shader; vlength is therefore the authored velocity contribution exactly once.
    float unityParticleLength = vlength + lengthFactor * avgSize;
    // Unity Stretch rotates the authored billboard basis: renderer pivot.x shifts width,
    // pivot.y shifts length. The API pivot is half the serialized normalized quad offset.
    mvPosition.xyz += (position.y - 2.0 * cfxrRendererPivot.x) * unityWidth
      * avgSize;
    mvPosition.xyz -= ((position.x + 0.5) * unityParticleLength
      - 2.0 * cfxrRendererPivot.y * avgSize) * unityLength;`,
    );
  }

  if (profile.unityVerticalBillboard) {
    const aligned = 'vec2 alignedPosition = position.xy * size.xy;';
    if (!mat.vertexShader.includes(aligned))
      throw new Error('Strict Unity vertical-billboard lowering failed: Quarks vertex template changed');
    mat.vertexShader = mat.vertexShader.replace(
      aligned,
      'vec2 alignedPosition = position.xy * size.xy * 0.7071067811865476;',
    );
  }


  if (!mat.vertexShader.includes('vCfxrCustom1')) {
    let vs = mat.vertexShader;
    const isTrailVertex = vs.includes('attribute vec3 previous;');
    const worldPositionExpr = !isTrailVertex && vs.includes('vec4 mvPosition')
      ? '(inverse(viewMatrix) * mvPosition).xyz'
      : '(modelMatrix * vec4(position, 1.0)).xyz';
    vs = 'attribute vec4 cfxrCustom1;\nattribute vec4 cfxrCustom2;\nattribute vec2 cfxrUvFlip;\nattribute vec4 cfxrRendererPivot;\nattribute vec2 uv1;\nvarying vec4 vCfxrCustom1;\nvarying vec4 vCfxrCustom2;\nvarying vec2 vCfxrUvFlip;\nvarying vec2 vCfxrUv1;\nvarying vec3 vCfxrWorldPosition;\n' + vs;
    if (vs.includes('#include <tile_vertex>')) {
      vs = vs.replace(
        '#include <tile_vertex>',
        `#include <tile_vertex>\n\tvCfxrCustom1 = cfxrCustom1;\n\tvCfxrCustom2 = cfxrCustom2;\n\tvCfxrUvFlip = cfxrUvFlip;\n\tvCfxrUv1 = uv1;\n\tvCfxrWorldPosition = ${worldPositionExpr};`,
      );
    } else {
      vs = vs.replace(
        /void\s+main\s*\(\s*\)\s*\{/,
        'void main() {\n\tvCfxrCustom1 = cfxrCustom1;\n\tvCfxrCustom2 = cfxrCustom2;\n\tvCfxrUvFlip = cfxrUvFlip;\n\tvCfxrUv1 = uv1;\n\tvCfxrWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;',
      );
    }
    mat.vertexShader = vs;
  }

  mat.fragmentShader = /* glsl */ `
#include <common>
#include <color_pars_fragment>
#include <map_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
#include <tile_pars_fragment>

uniform float hdrMultiply;
uniform float dissolveSmooth;
uniform sampler2D dissolveMap;
uniform vec2 dissolveScroll;
uniform sampler2D maskMap;
uniform vec2 maskSpeed;
uniform float maskRotation;
uniform vec2 maskRotationCenter;
uniform vec2 maskOffset;
uniform float trailUvRotation;
uniform float trailUvStretch;
uniform float trailUvStretchY;
uniform vec2 trailUvScroll;
uniform vec2 trailUvTiling;
uniform vec2 trailUvOffset;
uniform float trailUvDistortionPower;
uniform vec2 trailUvDistortionSpeed;
uniform float maskNoiseScale;
uniform float effectTime;
uniform sampler2D distortionMap;
uniform sampler2D sceneColorMap;
uniform sampler2D sceneDepthMap;
uniform sampler2D heightMap;
uniform float parallaxAmplitude;
uniform sampler2D orbAlphaMap;
uniform sampler2D orbNoiseMap;
uniform vec3 orbColour;
uniform vec4 orbFresnelColor;
uniform vec2 orbNoiseAnimation;
uniform vec2 orbWarpSpeed;
uniform float orbFresnelPower;
uniform float orbNoiseScale;
uniform float orbNoiseFrequency;
uniform float orbNoiseAmplitude;
uniform float orbOctaveFrequencyScale;
uniform float orbOctaveAmplitudeScale;
uniform float orbOctaveDomainWarping;
uniform float orbNoisePower;
uniform float orbUvClipScale;
uniform vec3 sceneColorSize;
uniform float distortionAmount;
uniform float distortionAlphaFloor;
uniform vec2 slashWorldScreenOffset;
uniform float vertColorRgbOn;
uniform float vertColorAlphaOn;
uniform float vertColorGain;
uniform vec3 backColorMul;
uniform float softFadeAmount;
uniform float softParticleStrength;
uniform float cameraNear;
uniform float cameraFar;
uniform float opacityGain;
uniform float legacyAlphaTintFactor;
uniform float alphaClipThreshold;
uniform float dynamicAlphaClipScale;
uniform float texPower;
uniform float colorPower;
uniform vec3 materialColor;
uniform vec3 ambientSky;
uniform vec3 ambientEquator;
uniform vec3 ambientGround;
uniform vec3 ambientSH[9];
uniform vec2 tileCounts;
varying vec4 vCfxrCustom1;
varying vec4 vCfxrCustom2;
varying vec2 vCfxrUvFlip;
varying vec2 vCfxrUv1;
varying vec3 vCfxrWorldPosition;
out vec4 cfxrFragColor;

vec2 applyParticleUvFlip(vec2 uv) {
  vec2 counts = max(tileCounts, vec2(1.0));
  vec2 scaled = min(uv, vec2(1.0 - 1e-7)) * counts;
  vec2 cell = floor(scaled);
  vec2 localUv = fract(scaled);
  #ifdef CFXR_FLIP_X
    localUv.x = 1.0 - localUv.x;
  #endif
  #ifdef CFXR_FLIP_Y
    localUv.y = 1.0 - localUv.y;
  #endif
  localUv = mix(localUv, vec2(1.0) - localUv, vCfxrUvFlip);
  return (cell + localUv) / counts;
}

vec2 applyParallaxOcclusion(vec2 uv) {
  #ifndef CFXR_PARALLAX_OCCLUSION
    return uv;
  #else
    vec3 dpdx = dFdx(vCfxrWorldPosition);
    vec3 dpdy = dFdy(vCfxrWorldPosition);
    vec2 duvdx = dFdx(uv);
    vec2 duvdy = dFdy(uv);
    float det = duvdx.x * duvdy.y - duvdx.y * duvdy.x;
    vec3 tangent = normalize((dpdx * duvdy.y - dpdy * duvdx.y) / max(abs(det), 1e-6));
    vec3 bitangent = normalize((-dpdx * duvdy.x + dpdy * duvdx.x) / max(abs(det), 1e-6));
    vec3 normal = normalize(cross(tangent, bitangent));
    vec3 viewWorld = normalize(cameraPosition - vCfxrWorldPosition);
    vec3 viewTs = vec3(dot(viewWorld, tangent), dot(viewWorld, bitangent), abs(dot(viewWorld, normal)));

    // Exact constants and units from this source-hash-locked Shader Graph node:
    // Amplitude is authored in centimetres, Tiling/PrimitiveSize are (1,1), Steps=5,
    // LOD=0. Unity normalizes the UV-space view vector before marching.
    float maxHeight = parallaxAmplitude * 0.01;
    vec3 viewUv = normalize(vec3(viewTs.xy * maxHeight, max(viewTs.z, 1e-5)));
    const float steps = 5.0;
    const float stepSize = 1.0 / steps;
    vec2 texOffsetPerStep = stepSize * (viewUv.xy / -max(viewUv.z, 1e-5));

    vec2 texOffset = vec2(0.0);
    float prevHeight = texture2D(heightMap, uv + texOffset).r;
    texOffset += texOffsetPerStep;
    float currHeight = texture2D(heightMap, uv + texOffset).r;
    float rayHeight = 1.0 - stepSize;
    for (int i = 0; i < 5; i++) {
      if (currHeight > rayHeight) break;
      prevHeight = currHeight;
      rayHeight -= stepSize;
      texOffset += texOffsetPerStep;
      currHeight = texture2D(heightMap, uv + texOffset).r;
    }

    // Unity PerPixelDisplacement.hlsl refines the linear hit with three secant steps.
    float pt0 = rayHeight + stepSize;
    float pt1 = rayHeight;
    float delta0 = pt0 - prevHeight;
    float delta1 = pt1 - currHeight;
    vec2 refinedOffset = texOffset;
    for (int i = 0; i < 3; i++) {
      float denom = delta1 - delta0;
      if (abs(denom) < 1e-6) break;
      float intersectionHeight = (pt0 * delta1 - pt1 * delta0) / denom;
      refinedOffset = (1.0 - intersectionHeight) * texOffsetPerStep * steps;
      currHeight = texture2D(heightMap, uv + refinedOffset).r;
      float delta = intersectionHeight - currHeight;
      if (abs(delta) <= 0.01) break;
      if (delta < 0.0) {
        delta1 = delta;
        pt1 = intersectionHeight;
      } else {
        delta0 = delta;
        pt0 = intersectionHeight;
      }
    }
    return uv + refinedOffset;
  #endif
}

float unityNoiseHash(vec2 uv) {
  // Exact RandomValue kernel emitted by Unity Shader Graph's Simple Noise node. A different
  // hash may look equally noisy, but it changes the mask texture's second-stage lookup.
  return fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);
}
float unityValueNoise(vec2 uv) {
  vec2 i = floor(uv);
  vec2 f = fract(uv);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(unityNoiseHash(i), unityNoiseHash(i + vec2(1.0, 0.0)), f.x),
             mix(unityNoiseHash(i + vec2(0.0, 1.0)), unityNoiseHash(i + vec2(1.0)), f.x), f.y);
}
float unitySimpleNoise(vec2 uv, float scale) {
  return unityValueNoise(uv * scale) * 0.125
       + unityValueNoise(uv * (scale * 0.5)) * 0.25
       + unityValueNoise(uv * (scale * 0.25)) * 0.5;
}

void main() {
    #include <clipping_planes_fragment>
    vec4 vertColor = vColor;
    #include <logdepthbuf_fragment>

    vec4 texSample = vec4(1.0);
    vec4 coverageSample = vec4(1.0);
    #ifdef USE_MAP
      vec2 mainUv = applyParticleUvFlip(vUv);
      #ifdef CFXR_MAIN_UV_SHEAR
        mainUv.x += mainUv.y;
      #endif
      #ifdef CFXR_MAIN_UV_CUSTOM1_Y
        mainUv.x += vCfxrCustom1.y;
      #endif
      #ifdef CFXR_MAIN_UV_CUSTOM1_YX
        mainUv += vCfxrCustom1.yx;
      #endif
      #ifdef CFXR_MAIN_UV_Y_CUSTOM1_Y
        mainUv.y += vCfxrCustom1.y;
      #endif
      #ifdef CFXR_MAIN_UV_OFFSET_UV1
        mainUv += vCfxrUv1;
      #endif
      #ifdef CFXR_TRAIL_UV_V2
        vec2 centeredTrailUv = mainUv - vec2(0.5);
        float trailAngle = radians(trailUvRotation);
        float trailCs = cos(trailAngle);
        float trailSn = sin(trailAngle);
        // Shader Graph Rotate multiplies a row UV by float2x2(c,-s,s,c); GLSL uses
        // column vectors, so transpose that matrix here.
        mainUv = mat2(trailCs, -trailSn, trailSn, trailCs) * centeredTrailUv + vec2(0.5);
        if (trailUvStretch > 0.0) {
          if (trailUvStretchY > 0.5) mainUv.y = pow(max(mainUv.y, 0.0), trailUvStretch);
          else mainUv.x = pow(max(mainUv.x, 0.0), trailUvStretch);
        }
        vec2 trailDistUv = vUv + trailUvDistortionSpeed * effectTime;
        float trailDistSample = texture2D(distortionMap, trailDistUv).r;
        vec2 trailDistortion = clamp(
          pow(max((vUv + trailUvOffset) * trailDistSample, vec2(0.0)),
              vec2(trailUvDistortionPower)),
          vec2(0.0), vec2(1.0));
        vec2 trailScroll = trailUvScroll;
        #ifdef CFXR_TRAIL_SPEED_CUSTOM2
          trailScroll *= vCfxrCustom2.xy;
        #endif
        mainUv = (mainUv + trailDistortion) * trailUvTiling + trailScroll * effectTime;
      #endif
      coverageSample = texture2D(map, mainUv);
      mainUv = applyParallaxOcclusion(mainUv);
      texSample = texture2D(map, mainUv);
      #ifdef TILE_BLEND
        vec2 nextMainUv = applyParticleUvFlip(vUvNext);
        #ifdef CFXR_MAIN_UV_SHEAR
          nextMainUv.x += nextMainUv.y;
        #endif
        #ifdef CFXR_MAIN_UV_CUSTOM1_Y
          nextMainUv.x += vCfxrCustom1.y;
        #endif
        #ifdef CFXR_MAIN_UV_CUSTOM1_YX
          nextMainUv += vCfxrCustom1.yx;
        #endif
        #ifdef CFXR_MAIN_UV_OFFSET_UV1
          nextMainUv += vCfxrUv1;
        #endif
        vec4 nextCoverageSample = texture2D(map, nextMainUv);
        coverageSample = mix(coverageSample, nextCoverageSample, vUvBlend);
        nextMainUv = applyParallaxOcclusion(nextMainUv);
        texSample = mix(texSample, texture2D(map, nextMainUv), vUvBlend);
      #endif
    #endif

    float lum = max(texSample.r, max(texSample.g, texSample.b));
    // Trail / Slash graphs: pow(tex, _TexPower) before tint
    if (texPower > 1.001) {
      texSample.rgb = pow(max(texSample.rgb, 0.0), vec3(texPower));
      lum = pow(max(lum, 0.0), texPower);
    }
    vec3 rgb;
    float alpha;

    // Unity linear project (CFXR_PASSES):
    // - Shuriken vertex colors are gamma-authored → linearize
    // - _Color / _HdrMultiply are linear gains (may be >1) → apply AFTER linearize
    // - Albedo map already linear if SRGBColorSpace; coverage map is NoColorSpace
    vec3 vertLin = mix(
      vertColor.rgb / 12.92,
      pow(max(vertColor.rgb + 0.055, 0.0) / 1.055, vec3(2.4)),
      step(0.04045, vertColor.rgb)
    );
    #ifdef CFXR_VERTEX_COLOR_RAW
      vertLin = vertColor.rgb;
    #endif
    vertLin *= vertColorGain;
    #ifndef CFXR_SLASH_WORLD_V2
    if (colorPower > 1.001) {
      vertLin = pow(max(vertLin, 0.0), vec3(colorPower));
    }
    #endif
    // Shader Graph wiring: graphs that never sample Vertex Color must not be tinted/faded by it
    vertLin = mix(vec3(1.0), vertLin, vertColorRgbOn);
    float vertAlpha = mix(1.0, vertColor.a, vertColorAlphaOn);
    #ifdef CFXR_LEGACY_MULTIPLY
      vec4 legacyPrev = vec4(vertLin, vertAlpha) * texSample;
      rgb = mix(vec3(1.0), legacyPrev.rgb, legacyPrev.a);
      // Unity masks framebuffer alpha; keep a non-zero shader alpha so the generic
      // transparent-material overdraw cutoff cannot alter multiply semantics.
      alpha = mix(1.0, legacyPrev.a, legacyPrev.a);
    #elif defined(CFXR_LEGACY_PREMULTIPLY)
      rgb = vertLin * texSample.rgb * vertAlpha;
      alpha = texSample.a * vertAlpha * vertAlpha;
    #elif defined(CFXR_LEGACY_MULTIPLY_COLORED)
      // Cartoon FX/Legacy/Particle Multiply Colored.shader:
      // lerp(1, TintColor * vertex, texture * vertex.a), then Blend DstColor Zero.
      rgb = mix(vec3(1.0), materialColor * vertLin, texSample.rgb * vertAlpha);
      alpha = coverageSample.a * vertAlpha;
    #elif defined(CFXR_ORB_WARP_V1)
      // Source-hash-locked lowering shared by Orb Warp and Orb Warp Lit. The graph builds a
      // normalized two-octave, texture-authored domain warp, then applies a view Fresnel lerp.
      vec2 orbBaseUv = vUv * orbNoiseScale + orbNoiseAnimation * effectTime;
      float orbDomain = texture2D(
        distortionMap, orbBaseUv + orbWarpSpeed * effectTime).r;
      vec2 orbOctaveUv = (orbBaseUv + vec2(orbDomain * orbOctaveDomainWarping))
        * (orbNoiseFrequency * orbOctaveFrequencyScale);
      float orbOctave = texture2D(orbNoiseMap, orbOctaveUv).r;
      float orbDenominator = max(
        orbNoiseAmplitude * (1.0 + orbOctaveAmplitudeScale), 1e-6);
      float orbNoise = pow(max(
        (orbDomain + orbOctave * orbNoiseAmplitude * orbOctaveAmplitudeScale)
          / orbDenominator,
        0.0), orbNoisePower);
      vec3 orbDx = dFdx(vCfxrWorldPosition);
      vec3 orbDy = dFdy(vCfxrWorldPosition);
      vec3 orbNormal = normalize(cross(orbDx, orbDy));
      vec3 orbView = normalize(cameraPosition - vCfxrWorldPosition);
      float orbFresnel = pow(1.0 - saturate(abs(dot(orbNormal, orbView))), orbFresnelPower);
      float orbFresnelWeight = orbFresnelColor.a * orbFresnel;
      rgb = mix(orbNoise * orbColour, orbFresnelColor.rgb, orbFresnelWeight);
      #ifdef CFXR_ORB_ALPHA_TEXTURE
        float orbCoverage = texture2D(orbAlphaMap, vUv).r;
      #else
        float orbCoverage = 1.0;
      #endif
      #ifdef CFXR_ORB_ALPHA_GREEN
        alpha = orbCoverage * vertColor.g;
      #else
        alpha = orbCoverage * vertColor.a;
      #endif
    #elif defined(CFXR_SLASH_WORLD_V2)
      rgb = vertLin * texSample.rgb * colorPower;
      #ifdef CFXR_SLASH_WORLD_VERTEX_ALPHA
        alpha = vertAlpha;
      #else
        alpha = coverageSample.r * vertAlpha;
      #endif
    #elif defined(CFXR_TRAIL_FRONT_FACE_V2)
      // Exact, source-hash-locked lowering of Trail.shadergraph:
      // BaseColor = selectedVertex.rgb * softDepth
      //             * (IsFrontFace ? _FrontColor : _BackColor)
      //             * pow(MainTex.rgba, _TexPower).rgb
      // Alpha = selectedVertex.a * softDepth * MainTex.r * MaskTex.r.
      // Soft depth is applied below after reconstructing scene eye depth.
      vec3 faceTint = gl_FrontFacing ? materialColor : backColorMul;
      rgb = vertLin * faceTint * texSample.rgb;
      alpha = coverageSample.r * vertAlpha;
    #elif defined(CFXR_SINGLE_CHANNEL)
      rgb = vertLin * materialColor;
      #ifdef CFXR_COVERAGE_ALPHA
        alpha = coverageSample.a * vertAlpha;
      #elif defined(CFXR_COVERAGE_RED)
        #ifdef CFXR_SLASH_SCREEN_V1
          // Slash.shadergraph saturates the high-gain main coverage before the
          // downstream dissolve and mask products. Moving saturate after mask
          // expands low-valued mask texels by _Opacity and makes the arc 4–5× thicker.
          alpha = saturate(coverageSample.r * opacityGain) * vertAlpha;
        #else
          alpha = coverageSample.r * vertAlpha;
        #endif
      #elif defined(CFXR_COVERAGE_GREEN)
        alpha = coverageSample.g * vertAlpha;
      #else
        alpha = lum * vertAlpha;
      #endif
    #else
      #ifdef CFXR_FRONT_BACK
        // Trail-family Shader Graph: BaseColor = lerp(_BackColor, _FrontColor, tex)
        #ifdef CFXR_FRONT_FACE_SELECT
          vec3 faceTint = gl_FrontFacing ? materialColor : backColorMul;
          rgb = vertLin * mix(backColorMul, faceTint, saturate(lum));
        #else
          rgb = vertLin * mix(backColorMul, materialColor, saturate(lum));
        #endif
      #else
        rgb = vertLin * texSample.rgb * materialColor;
      #endif
      #ifdef CFXR_COVERAGE_ALPHA
        alpha = coverageSample.a * vertAlpha;
      #elif defined(CFXR_COVERAGE_RED)
        alpha = coverageSample.r * vertAlpha;
      #else
        alpha = lum * vertAlpha;
      #endif
    #endif

    #ifdef CFXR_URP_LIT_REFERENCE
      // The camera oracle has no realtime main light. URP Lit still evaluates the scene's
      // ambient probe; reconstruct a geometric world normal and apply the exported three-band
      // ambient gradient. This is an explicit scene-input lowering, not a material-name tint.
      vec3 litDx = dFdx(vCfxrWorldPosition);
      vec3 litDy = dFdy(vCfxrWorldPosition);
      vec3 litNormal = normalize(cross(litDx, litDy));
      if (!gl_FrontFacing) litNormal = -litNormal;
      // Unity's ShadeSH9 packing expanded back into its nine SphericalHarmonicsL2
      // coefficients. These coefficients already contain Unity's irradiance convolution.
      vec3 ambientProbe = ambientSH[0]
        + ambientSH[3] * litNormal.x
        + ambientSH[1] * litNormal.y
        + ambientSH[2] * litNormal.z
        + ambientSH[4] * (litNormal.x * litNormal.y)
        + ambientSH[5] * (litNormal.y * litNormal.z)
        + ambientSH[6] * (3.0 * litNormal.z * litNormal.z - 1.0)
        + ambientSH[7] * (litNormal.x * litNormal.z)
        + ambientSH[8] * (litNormal.x * litNormal.x - litNormal.y * litNormal.y);
      rgb *= max(ambientProbe, vec3(0.0));
    #endif

    #ifdef CFXR_MASK
      // The Slash graph has two independent UV branches. Rotation feeds only the first
      // _MaskTex sample; ScrollUV(default UV, speed, time) feeds Simple Noise. Reusing the
      // rotated coordinate for both silently changes the graph whenever rotation/offset is
      // authored, so keep the two values explicit in the lowering.
      vec2 maskUv = vUv + maskOffset;
      vec2 maskNoiseUv = vUv + maskSpeed * effectTime;
      float angle = radians(maskRotation);
      float cs = cos(angle);
      float sn = sin(angle);
      vec2 centeredMaskUv = maskUv - maskRotationCenter;
      // Shader Graph Rotate uses mul(rowUV, float2x2(c,-s,s,c)). GLSL multiplies
      // column vectors, so its constructor must contain the transposed coefficients.
      maskUv = mat2(cs, -sn, sn, cs) * centeredMaskUv + maskRotationCenter;
      #ifdef CFXR_MASK_WARP_SIMPLE_NOISE
        float innerMask = texture2D(maskMap, maskUv).r;
        // Graph topology: Rotate(UV0) feeds the inner mask directly; ScrollUV is used
        // only by Simple Noise. Applying scroll to the inner sample erases long streaks.
        float maskNoise = unitySimpleNoise(maskNoiseUv, maskNoiseScale);
        maskUv = vec2(innerMask * maskNoise);
      #endif
      vec4 maskSample = texture2D(maskMap, maskUv);
      #ifdef CFXR_MASK_ALPHA
        float mask = maskSample.a;
      #else
        float mask = maskSample.r;
      #endif
      alpha *= mask;
    #endif

    // _Opacity only exists in the connected Alpha DAGs that declare it. The reviewed
    // Trail graph has a stale property with this name, so its adapter excludes the gain.
    #if defined(CFXR_TRAIL_FRONT_FACE_V2) || defined(CFXR_SLASH_WORLD_V2) || defined(CFXR_SLASH_SCREEN_V1)
      alpha = saturate(alpha);
    #else
      alpha = saturate(alpha * opacityGain);
    #endif

    #ifdef CFXR_LEGACY_DOUBLE_TINT
      // Unity's reviewed built-in Additive/Alpha Blended particle programs return
      // 2 * texture * vertexColor * _TintColor before fixed-function blending.
      rgb *= 2.0;
      alpha = saturate(alpha * legacyAlphaTintFactor);
    #endif

    // Output linear HDR — the composer's OutputPass applies ACES + sRGB exactly like
    // the Unity demo Volume (Tonemapping mode: ACES), so no shader-side compression here.
    if (hdrMultiply > 0.0) {
      rgb *= hdrMultiply;
    }

    #ifdef CFXR_DISTORTION
      // Unity Slash-style BaseColor = refracted Scene Color + own emission chain (Add node);
      // both operands are linear HDR here, matching the graph's Add.
      vec2 distUv = gl_FragCoord.xy / max(sceneColorSize.xy, vec2(1.0));
      vec2 n;
      #ifdef CFXR_SLASH_WORLD_V2
        // Exact Slash World.shadergraph lowering:
        // NormalFromTexture(R, offset=.5, strength=8) × Rectangle(mainUv,1,1), then
        // horizontal smoothstep window × displaced UV.y before adding to screen UV.
        float normalOffset = 0.0125; // pow(0.5, 3) * 0.1
        float normalBase = texture2D(distortionMap, mainUv).r;
        float normalU = texture2D(distortionMap, mainUv + vec2(normalOffset, 0.0)).r;
        float normalV = texture2D(distortionMap, mainUv + vec2(0.0, normalOffset)).r;
        vec3 graphNormal = normalize(vec3(
          -(normalU - normalBase) * 8.0,
          -(normalV - normalBase) * 8.0,
          1.0));
        vec2 rectangleD = abs(mainUv * 2.0 - 1.0) - vec2(1.0);
        vec2 rectangleCoverage = saturate(1.0 - rectangleD / max(fwidth(rectangleD), vec2(1e-6)));
        float rectangle = min(rectangleCoverage.x, rectangleCoverage.y);
        vec2 meshDistortion = graphNormal.xy * distortionAmount * rectangle;
        vec2 displacedMeshUv = vUv + meshDistortion;
        float edgeWindow = smoothstep(0.0, 0.5, displacedMeshUv.x)
          * smoothstep(1.0, 0.5, displacedMeshUv.x)
          * displacedMeshUv.y;
        n = graphNormal.xy;
        distUv += meshDistortion * edgeWindow + slashWorldScreenOffset / 100.0;
      #else
        n = texture2D(distortionMap, vUv).rg * 2.0 - 1.0;
        distUv += n * distortionAmount;
      #endif
      vec3 scene = texture2D(sceneColorMap, clamp(distUv, 0.0, 1.0)).rgb;
      #ifdef CFXR_SLASH_SCREEN_V1
        rgb = scene * rgb + rgb;
      #else
        rgb = scene + rgb;
      #endif
      alpha = max(alpha, saturate(length(n)) * distortionAlphaFloor);
    #endif

    #ifdef CFXR_SLASH_SCREEN_V1
      float slashDissolve = 1.0 - texture2D(
        dissolveMap, vUv + dissolveScroll * effectTime).r;
      float slashDissolveTime = clamp(vCfxrCustom1.x, 0.0, 1.0);
      alpha *= saturate(
        mix(slashDissolve, 0.0, slashDissolveTime)
        + step(slashDissolveTime, slashDissolve));
    #elif defined(CFXR_DISSOLVE)
      float dissolveTime = clamp(vCfxrCustom1.x, 0.0, 1.0);
      float dissolveTex = texture2D(dissolveMap, vUv).r;
      #ifdef CFXR_INVERT_DISSOLVE
        dissolveTex = 1.0 - dissolveTex;
      #endif
      // Match CFXR.cginc: lerp(-sm, 1+sm, dissolveTime) + smoothstep(dissolve±sm, time)
      float sm = max(dissolveSmooth, 0.01);
      float dt = mix(-sm, 1.0 + sm, dissolveTime);
      alpha *= smoothstep(dissolveTex - sm, dissolveTex + sm, dt);
    #endif

    #ifdef CFXR_SOFT_FADE
      vec2 depthUv = gl_FragCoord.xy / max(sceneColorSize.xy, vec2(1.0));
      float sceneDepth = texture2D(sceneDepthMap, depthUv).x;
      float sceneViewZ = -(cameraNear * cameraFar)
        / ((cameraFar - cameraNear) * sceneDepth - cameraFar);
      float particleViewZ = -(cameraNear * cameraFar)
        / ((cameraFar - cameraNear) * gl_FragCoord.z - cameraFar);
      // The leading minus in the reconstruction converts three.js view Z to the same
      // positive eye-distance convention used by Shader Graph Scene Depth (Eye).
      float depthFade = saturate((sceneViewZ - particleViewZ) * softParticleStrength);
      float appliedDepthFade = mix(1.0, depthFade, softFadeAmount);
      alpha *= appliedDepthFade;
      #ifdef CFXR_TRAIL_FRONT_FACE_V2
        rgb *= appliedDepthFade;
      #endif
    #endif

    // Match Shader Graph Alpha Clip. Keep the tiny generic cutoff only for non-clipped
    // transparent materials to avoid zero-alpha overdraw.
    #ifdef CFXR_ORB_WARP_V1
      if (alpha < clamp(vUv.x * orbUvClipScale, 0.0, 1.0)) discard;
    #endif
    #ifdef CFXR_DYNAMIC_ALPHA_CLIP
      #ifdef CFXR_DYNAMIC_ALPHA_CLIP_Y
        float dynamicClipSource = vCfxrCustom1.y;
      #elif defined(CFXR_DYNAMIC_ALPHA_CLIP_Z)
        float dynamicClipSource = vCfxrCustom1.z;
      #elif defined(CFXR_DYNAMIC_ALPHA_CLIP_W)
        float dynamicClipSource = vCfxrCustom1.w;
      #elif defined(CFXR_DYNAMIC_ALPHA_CLIP_UV1_X)
        float dynamicClipSource = vCfxrUv1.x;
      #elif defined(CFXR_DYNAMIC_ALPHA_CLIP_UV1_Y)
        float dynamicClipSource = vCfxrUv1.y;
      #else
        float dynamicClipSource = vCfxrCustom1.x;
      #endif
      if (alpha < clamp(dynamicClipSource * dynamicAlphaClipScale, 0.0, 1.0)) discard;
    #endif
    if (alphaClipThreshold > 0.0) {
      if (alpha < alphaClipThreshold) discard;
    } else if (alpha < 0.02) {
      discard;
    }
    cfxrFragColor = vec4(rgb, saturate(alpha));
}
`;

  mat.needsUpdate = true;
  // Also owns deterministic material time (mask/dissolve scrolling), so every compiled
  // material participates even when it does not sample scene color/depth.
  sceneInputMaterials.add(mat);
}

export async function patchCfxrAfterBatch(batchRenderer: BatchedRenderer) {
  sceneInputMaterials.clear();
  for (const batch of batchRenderer.batches) {
    const settingsMat = batch.settings.material as MeshBasicMaterial & {
      userData?: { cfxr?: CfxrRuntimeProfile };
    };
    let profile = settingsMat.userData?.cfxr;

    // Fallback: resolve the profile computed in beforeBatch (clone may drop userData).
    // Never rebuild via propsToProfile here — that loses dissolveViaUvTile and mesh flags.
    if (!profile) {
      for (const sys of batch.systems) {
        const uuid = (sys.emitter as unknown as { uuid?: string })?.uuid ?? '';
        const stored = profilesByEmitter.get(uuid);
        if (stored) {
          profile = stored;
          break;
        }
      }
    }
    if (!profile) continue;

    const mat = batch.material as ShaderMaterial;
    if (!mat?.isShaderMaterial) continue;

    // Declare the instance stream before first shader compilation. The values are refreshed
    // after each simulation/batch update by updateCfxrCustomAttributes().
    updateCfxrCustomAttributes(batchRenderer);

    let dissolve: Texture | null = null;
    let mask: Texture | null = null;
    let distortion: Texture | null = null;
    let height: Texture | null = null;
    let orbAlpha: Texture | null = null;
    let orbNoise: Texture | null = null;
    if (profile.dissolve) {
      const url = profile.dissolveMapUrl || '/assets/quarks/cfxr_smoke_cloud_x4_dissolve.png';
      dissolve = await loadCfxrTexture(url, profile.dissolveMapSrgb, profile.dissolveSampler);
    }
    if (profile.useMask && profile.maskMapUrl) {
      mask = await loadCfxrTexture(profile.maskMapUrl, profile.maskMapSrgb, profile.maskSampler);
    }
    const orbWarp = profile.manualGraphLowering === 'orb-warp@1'
      || profile.manualGraphLowering === 'orb-warp-lit@1';
    if ((profile.useDistortion || profile.mainUvTransform === 'trail-front-face@2' || orbWarp)
        && profile.distortionMapUrl) {
      distortion = await loadCfxrTexture(
        profile.distortionMapUrl,
        profile.distortionMapSrgb,
        profile.distortionSampler,
      );
    }
    if (profile.heightMapUrl)
      height = await loadCfxrTexture(profile.heightMapUrl, profile.heightMapSrgb, profile.heightSampler);
    if (orbWarp && profile.orbAlphaMapUrl)
      orbAlpha = await loadCfxrTexture(
        profile.orbAlphaMapUrl, profile.orbAlphaMapSrgb, profile.orbAlphaSampler);
    if (orbWarp && profile.orbNoiseMapUrl)
      orbNoise = await loadCfxrTexture(
        profile.orbNoiseMapUrl, profile.orbNoiseMapSrgb, profile.orbNoiseSampler);
    injectCfxrShader(mat, profile, { dissolve, mask, distortion, height, orbAlpha, orbNoise });
  }
}

export interface StartDelayGate {
  delays: Map<string, number>;
  elapsed: number;
  armed: boolean;
}

export function createStartDelayGate(delays: Map<string, number>): StartDelayGate {
  return { delays, elapsed: 0, armed: false };
}

export function armStartDelays(root: Object3D, gate: StartDelayGate) {
  gate.elapsed = 0;
  gate.armed = true;
  root.traverse((child) => {
    if (child.type !== 'ParticleEmitter') return;
    const emitter = child as ParticleEmitter;
    const delay = gate.delays.get(emitter.uuid) ?? 0;
    const system = emitter.system as ParticleSystem;
    if (delay > 0) {
      system.restart();
      system.pause();
    } else {
      system.restart();
      system.play();
    }
  });
}

/**
 * Advance the global delay clock and return the exact simulation slice for every emitter.
 * A delay may land inside a fixed step (for example 0.14 within the 0.1333→0.15 step). Unity
 * simulates only the remainder of that step; starting Quarks and giving it the full dt advances
 * position, lifetime curves and Custom streams by one partial frame.
 */
export function tickStartDelays(
  root: Object3D,
  gate: StartDelayGate,
  dt: number,
): Map<ParticleSystem, number> {
  const deltas = new Map<ParticleSystem, number>();
  const previous = gate.elapsed;
  if (gate.armed) gate.elapsed += dt;
  root.traverse((child) => {
    if (child.type !== 'ParticleEmitter') return;
    const emitter = child as ParticleEmitter;
    const delay = gate.delays.get(emitter.uuid) ?? 0;
    const system = emitter.system as ParticleSystem;
    if (!gate.armed || delay <= previous) {
      deltas.set(system, dt);
      return;
    }
    if (gate.elapsed < delay) {
      deltas.set(system, 0);
      return;
    }
    if (system.paused) {
      system.restart();
      system.play();
    }
    deltas.set(system, Math.max(0, gate.elapsed - delay));
  });
  return deltas;
}

/** Optional CFXR_Effect light — enabled when JSON metadata present (future) or always mild. */
export class CfxrEffectLight {
  readonly light: PointLight;
  private elapsed = 0;
  private playing = false;
  private intensityStart = 21.11;
  private intensityEnd = 0;
  private duration = 0.5;
  private delay = 0;
  private intensityScale = 0.035;
  private mode: 'burst-curve' | 'linear-fade' | 'sampled-flicker' = 'burst-curve';
  private flickerAdd = 0;
  private flickerSmooth = 1;
  private flickerPhase = 0;
  private flickerDomainStep = 1 / 128;
  private flickerSamples: number[] = [0.5, 0.5];

  constructor() {
    this.light = new PointLight(new Color(1, 0.621, 0.204), 0, 10, 2);
    this.light.name = 'CFXR_EffectLight';
  }

  attach(parent: Object3D, localPos = new Vector3(0, 0.2, 0)) {
    this.light.position.copy(localPos);
    parent.add(this.light);
  }

  configure(meta?: {
    intensityStart?: number;
    duration?: number;
    color?: [number, number, number];
    range?: number;
    intensityEnd?: number;
    delay?: number;
    position?: [number, number, number];
    intensityScale?: number;
    mode?: 'burst-curve' | 'linear-fade' | 'sampled-flicker';
    flickerAdd?: number;
    flickerSmooth?: number;
    flickerPhase?: number;
    flickerDomainStep?: number;
    flickerSamples?: number[];
  }) {
    if (!meta) return;
    // configure() is called for every newly loaded effect. Reset all controller-only
    // state so a sampled flicker cannot leak into a later plain cfxrEffect payload.
    this.mode = meta.mode ?? 'burst-curve';
    this.flickerAdd = 0;
    this.flickerSmooth = 1;
    this.flickerPhase = 0;
    this.flickerDomainStep = 1 / 128;
    this.flickerSamples = [0.5, 0.5];
    if (meta.intensityStart != null) this.intensityStart = meta.intensityStart;
    if (meta.duration != null) this.duration = meta.duration;
    if (meta.color) this.light.color.setRGB(meta.color[0], meta.color[1], meta.color[2]);
    if (meta.range != null) this.light.distance = meta.range;
    if (meta.intensityEnd != null) this.intensityEnd = meta.intensityEnd;
    if (meta.delay != null) this.delay = Math.max(0, meta.delay);
    if (meta.position) this.light.position.set(meta.position[0], meta.position[1], meta.position[2]);
    if (meta.intensityScale != null) this.intensityScale = meta.intensityScale;
    if (meta.flickerAdd != null) this.flickerAdd = meta.flickerAdd;
    if (meta.flickerSmooth != null) this.flickerSmooth = Math.max(0, meta.flickerSmooth);
    if (meta.flickerPhase != null) this.flickerPhase = meta.flickerPhase;
    if (meta.flickerDomainStep != null) this.flickerDomainStep = Math.max(1e-8, meta.flickerDomainStep);
    if (meta.flickerSamples?.length) this.flickerSamples = [...meta.flickerSamples];
  }

  restart() {
    this.elapsed = 0;
    this.playing = true;
    this.light.intensity = this.delay > 0 ? 0 : this.intensityStart * this.intensityScale;
  }

  stop() {
    this.playing = false;
    this.light.intensity = 0;
  }

  update(dt: number) {
    if (!this.playing) return;
    if (this.mode === 'sampled-flicker') {
      const x = Math.max(0, (this.elapsed + this.flickerPhase) * this.flickerSmooth);
      const sample = x / this.flickerDomainStep;
      const index = Math.min(this.flickerSamples.length - 2, Math.floor(sample));
      const u = Math.max(0, Math.min(1, sample - index));
      const noise = this.flickerSamples[index]
        + (this.flickerSamples[index + 1] - this.flickerSamples[index]) * u;
      this.light.intensity = (this.intensityStart + this.flickerAdd * noise) * this.intensityScale;
      this.elapsed += dt;
      return;
    }
    if (this.mode === 'linear-fade') {
      // CFX_LightIntensityFade evaluates the current lifetime, then increments it.
      // Preserve that order so fixed-step frame zero starts at baseIntensity.
      if (this.elapsed < this.delay) {
        this.light.intensity = 0;
      } else {
        const localTime = this.elapsed - this.delay;
        const u = Math.max(0, Math.min(1, localTime / this.duration));
        this.light.intensity = (
          this.intensityStart + (this.intensityEnd - this.intensityStart) * u
        ) * this.intensityScale;
        if (u >= 1) this.playing = false;
      }
      this.elapsed += dt;
      return;
    }
    this.elapsed += dt;
    const u = Math.max(0, Math.min(1, this.elapsed / this.duration));
    let curve = 0;
    if (u < 0.1) curve = u / 0.1;
    else curve = Math.max(0, 1 - (u - 0.1) / 0.9);
    this.light.intensity = (
      this.intensityStart * curve + this.intensityEnd * (1 - curve)
    ) * this.intensityScale;
    if (u >= 1) {
      this.playing = false;
      this.light.intensity = 0;
    }
  }
}
