import {
  WEB_RUNTIME_ARTIFACT_SCHEMA,
  WEB_VFX_RUNTIME_V2_SCHEMA,
  assertWebVfxRuntimeV2,
  deriveBlendState,
  deriveConstantUniforms,
  VFX_ALPHA_TEST_DISABLED,
  VFX_BAKE_NON_DT_LEGACY_ALPHA_TINT_FACTOR,
  VFX_TRANSPARENT_OVERDRAW_ALPHA_FLOOR,
  VFX_UV_EDGE_CLAMP_EPS,
  type WebRuntimeArtifact,
  type WebVfxRuntimeV2,
  type VfxPipelineBlendState,
  type VfxBlendMode,
} from '@vfx-factory/artifact-schema';

/**
 * Soft invents mirrored from the runtime bridge. Keep values byte-identical so
 * dual-path bake/compare stays zero-diff.
 */
/** Soft-invent color/opacity identity (matches runtime CFXR_* soft invents). */
const CFXR_COLOR_MUL_SOFT_IDENTITY: [number, number, number, number] = [1, 1, 1, 1];
const CFXR_OPACITY_SOFT_IDENTITY = 1;
const CFXR_HDR_SOFT_INVENT = 0;
const CFXR_LEGACY_VERTEX_COLOR_GAIN_OFF_PATH = 1;
const CFXR_CUTOFF_SOFT_INVENT = VFX_ALPHA_TEST_DISABLED;
const CFXR_DOUBLE_SIDED_SOFT_INVENT = true;
/** Quarks JSON historical default when maxParticles omitted (compile signature). */
const CFXR_QUARKS_MAX_PARTICLES_SOFT = 256;
/** Quarks JSON historical defaults when tile counts omitted (compile signature). */
const CFXR_QUARKS_TILE_COUNT_SOFT = 1;
const CFXR_INITIAL_POSITION_SOFT: [number, number, number] = [0, 0, 0];
const CFXR_INITIAL_VELOCITY_SOFT: [number, number, number] = [0, 0, 0];
const CFXR_INITIAL_SIZE_SOFT: [number, number, number] = [1, 1, 1];
const CFXR_INITIAL_COLOR_SOFT: [number, number, number, number] = [1, 1, 1, 1];
const CFXR_MATERIAL_TINT_SOFT: [number, number, number, number] = [1, 1, 1, 1];
const CFXR_ALPHA_TEST_SOFT = VFX_ALPHA_TEST_DISABLED;
const CFXR_ALPHA_CLIP_THRESHOLD_SOFT = 0;
const CFXR_PARTICLE_LIFE_MIN = 0.0001;
const CFXR_DURATION_SOFT = 0;
const CFXR_START_LIFE_DURATION_FALLBACK = 1;
const CFXR_RENDER_MODE_SOFT = 0;
const CFXR_BURST_TIME_SOFT = 0;
const CFXR_STREAM_CUSTOM_ZERO_SOFT: [number, number, number, number] = [0, 0, 0, 0];

/** Input produced by the Unity/Quarks lowering stage. This boundary is
 * deliberately data-only: no Three.js or browser objects may cross it. */
export interface RuntimeArtifactInput {
  effectId: string;
  payload: Record<string, unknown>;
  sourceSchema?: string;
  resources?: Record<string, unknown>;
  materialVariants?: Record<string, unknown>;
  /** Always present, even when empty: proves semantic lowering ran offline. */
  cfxrState: Record<string, unknown>;
  runtimeConfig?: WebRuntimeArtifact['runtimeConfig'];
}

function assertJson(value: unknown, path: string): void {
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new Error(`Runtime artifact field '${path}' is not JSON serializable: ${String(error)}`);
  }
}

/** Package an already lowered Unity effect for the minimal online player. */
export function compileRuntimeArtifact(input: RuntimeArtifactInput): WebRuntimeArtifact {
  if (!input || typeof input.effectId !== 'string' || !input.effectId) {
    throw new Error('Runtime artifact requires a non-empty effectId.');
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new Error(`Runtime artifact '${input.effectId}' requires an object payload.`);
  }
  assertJson(input.payload, 'payload');
  if (input.resources != null) assertJson(input.resources, 'resources');
  if (input.materialVariants != null) assertJson(input.materialVariants, 'materialVariants');
  assertJson(input.cfxrState, 'cfxrState');
  return {
    schema: WEB_RUNTIME_ARTIFACT_SCHEMA,
    effectId: input.effectId,
    sourceSchema: input.sourceSchema,
    payload: input.payload,
    resources: input.resources,
    materialVariants: input.materialVariants,
    // An empty table is still explicit: it tells playback that semantic
    // lowering was completed and must not be re-run online.
    cfxrState: input.cfxrState,
    runtimeConfig: input.runtimeConfig,
  };
}

/** Wrap the runtime bundle in the envelope consumed by the player. */
export function compileArtifactEnvelope(input: RuntimeArtifactInput): Record<string, unknown> {
  const runtime = compileRuntimeArtifact(input);
  return {
    vfxIR: {
      schema: 'unity-vfx-ir@1',
      runtime: 'three-quarks-semantic@1',
      policy: 'strict',
      effectId: input.effectId,
      seed: 0,
      fixedDelta: 1 / 60,
      captureTimes: [0],
    },
    webRuntime: runtime,
  };
}

/**
 * Boundary for the new compiler. The input is already lowered into runtime
 * programs; this function only validates and packages it. Unity/Shader Graph
 * interpretation must happen before this boundary.
 */
export function writeRuntimeV2(artifact: WebVfxRuntimeV2): WebVfxRuntimeV2 {
  assertWebVfxRuntimeV2(artifact);
  if (artifact.schema !== WEB_VFX_RUNTIME_V2_SCHEMA) {
    throw new Error(`Unsupported runtime schema '${String(artifact.schema)}'.`);
  }
  const ids = new Set(artifact.materials.map((material) => material.id));
  for (const system of artifact.systems) {
    if (!ids.has(system.material)) throw new Error(`System '${system.id}' references missing material '${system.material}'.`);
  }
  return JSON.parse(JSON.stringify(artifact)) as WebVfxRuntimeV2;
}

/** Serialize a validated runtime artifact for the offline bundle writer.
 * Keeping this in the compiler package prevents the online player from ever
 * needing to know how an artifact was produced. */
export function serializeRuntimeV2(artifact: WebVfxRuntimeV2): string {
  return JSON.stringify(writeRuntimeV2(artifact), null, 2) + '\n';
}

export interface CompilerDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  path: string;
  message: string;
}

/** Emit the deterministic shader module used by v3 artifacts. The material IR has
 * already selected coverage, tint, alpha and blend semantics; the browser must not
 * infer them from Unity property names. Complex families can replace this template
 * through the same interface without changing the artifact schema. */
export function emitMaterialShader(program: any): {
  vertex: string;
  fragment: string;
  uniforms: Record<string, string>;
  execution: 'quarks-fragment-v1' | 'validated-only';
  /** False means one serialized material resolves to incompatible per-emitter flags. */
  profileCompatible: boolean;
} {
  const operations = new Set<string>((program?.operations ?? []).map((op: any) => op?.op));
  const emitterProfiles = Array.isArray(program?.emitterProfiles) ? program.emitterProfiles : [];
  const unsupported = new Set([
    'dissolve', 'dynamic-alpha-clip', 'hdr-multiply', 'mask',
    'manual-graph-lowering', 'manual-material-lowering', 'soft-particle-depth',
    'scene-color', 'distortion', 'front-back-lerp',
  ]);
  const executable = [...operations].every((operation) => !unsupported.has(operation)
    && !operation.startsWith('legacy-'))
    && !(program?.operations ?? []).some((operation: any) =>
      operation?.op === 'blend' && !['opaque', 'alpha'].includes(String(operation.mode ?? '')));
  const usesMap = operations.has('sample-main');
  const usesCoverage = operations.has('coverage');
  const coverageOp = (program?.operations ?? []).find((op: any) => op?.op === 'coverage');
  // Mirror bridge CFXR_COVERAGE_* selection. Do NOT invent a luminance fallback
  // when IR says source=alpha — that diverged from CFXR_COVERAGE_ALPHA and broke
  // opaque-alpha HDR sheets (ice SubIce/SubExplosion).
  let coverageSource: string;
  if (usesCoverage) {
    if (coverageOp?.source == null || coverageOp.source === '') {
      throw new Error('compileArtifactShader: coverage op requires source (no invent)');
    }
    coverageSource = String(coverageOp.source);
  } else {
    coverageSource = 'alpha';
  }
  const usesLegacyMultiply = operations.has('legacy-particle-multiply')
    || emitterProfiles.some((profile: any) => profile?.legacyMultiply === true);
  // Match the bridge's #if/#elif precedence: plain Multiply wins when an old
  // exporter redundantly marks the same material Multiply Colored as well.
  const usesLegacyMultiplyColored = !usesLegacyMultiply && (
    operations.has('legacy-multiply-colored')
    || emitterProfiles.some((profile: any) => profile?.legacyMultiplyColored === true));
  const usesMultiplyTexture = usesLegacyMultiply || usesLegacyMultiplyColored ||
    (program?.operations ?? []).some((op: any) => op?.op === 'blend' && op?.mode === 'multiply');
  const usesVertexColor = operations.has('vertex-color');
  const usesTint = operations.has('tint') || operations.has('front-back-lerp');
  // Live CFXR profiles are the bridge authority for legacy-double-tint. The
  // materials.manifest operation list can carry a stale LDT marker while the
  // exporter's pending props leave legacyDoubleTint unset (ice SubIce/SubExplosion:
  // op LDT + profile HDR, bridge definesLDT=false). Prefer profiles when present.
  const usesLegacyDoubleTint = emitterProfiles.length > 0
    ? emitterProfiles.some((profile: any) => profile?.legacyDoubleTint === true)
    : operations.has('legacy-double-tint');
  const usesLegacyPremultiply = operations.has('legacy-particle-premultiply')
    || emitterProfiles.some((profile: any) => profile?.legacyPremultiply === true);
  const usesRawVertexColor = operations.has('vertex-color-space');
  // Mirror bridge CFXR_SINGLE_CHANNEL: Alpha8 / single-channel sheets contribute
  // coverage only. Multiplying rgb by texel.rgb (the generic coverage path) is
  // wrong — those textures are not color maps.
  const usesSingleChannel = program?.profile?.singleChannel === true
    || emitterProfiles.some((profile: any) => profile?.singleChannel === true)
    || /alpha8/i.test(String(program?.lowering ?? ''));
  // Mirror bridge alphaClipThreshold: Multiply Colored exports 0.01 and the
  // ubershader discards against that uniform. Soft-invent 0 only when nothing authored.
  const authoredClip = [
    program?.profile?.alphaClipThreshold,
    ...emitterProfiles.map((profile: any) => profile?.alphaClipThreshold),
  ].filter((value): value is number => typeof value === 'number');
  const alphaClipThreshold = Math.max(
    0,
    ...(authoredClip.length ? authoredClip : [CFXR_ALPHA_CLIP_THRESHOLD_SOFT]),
  );
  // Mirror bridge applyParticleUvFlip. Even with tileCounts=(1,1) and no
  // per-particle flip, the min(uv, 1-eps) clamp is load-bearing: Multiply
  // Colored smoke failed zero-diff without it (fire_explosion clouds).
  const flipX = program?.profile?.flipX === true
    || emitterProfiles.some((profile: any) => profile?.flipX === true);
  const flipY = program?.profile?.flipY === true
    || emitterProfiles.some((profile: any) => profile?.flipY === true);
  // Mirror bridge vertLin *= vertColorGain for every vertex-color material.
  // Soft-invent off-path gain only when nothing authored.
  const authoredVertGain = [
    program?.profile?.legacyVertexColorGain,
    ...emitterProfiles.map((profile: any) => profile?.legacyVertexColorGain),
  ].filter((value): value is number => typeof value === 'number');
  const vertColorGain = Math.max(
    0,
    ...(authoredVertGain.length ? authoredVertGain : [CFXR_LEGACY_VERTEX_COLOR_GAIN_OFF_PATH]),
  );
  const usesVertColorGain = usesVertexColor;
  const coverageExpr = usesMultiplyTexture
    ? '1.0 - dot(coverageSample.rgb, vec3(0.299, 0.587, 0.114))'
    : coverageSource === 'red' ? 'coverageSample.r'
    : coverageSource === 'green' ? 'coverageSample.g'
    : coverageSource === 'luminance' || coverageSource === 'max-rgb'
      ? 'max(coverageSample.r, max(coverageSample.g, coverageSample.b))'
      : 'coverageSample.a';
  const fragment = `
precision highp float;
#if __VERSION__ >= 300
out vec4 artifactFragColor;
#define gl_FragColor artifactFragColor
#define texture2D texture
#endif
uniform sampler2D map;
uniform vec3 materialColor;
uniform float opacityGain;
uniform float legacyAlphaTintFactor;
uniform float hdrMultiply;
uniform float vertColorRgbOn;
uniform float vertColorAlphaOn;
uniform float texPower;
uniform float colorPower;
${usesVertColorGain ? 'uniform float vertColorGain;' : ''}
${usesMap ? 'uniform vec2 tileCounts;' : ''}
varying vec2 vUv;
varying vec4 vColor;
${usesMap ? 'varying vec2 vCfxrUvFlip;' : ''}
#ifdef TILE_BLEND
varying vec2 vUvNext;
varying float vUvBlend;
#endif
${usesMap ? `vec2 applyParticleUvFlip(vec2 uv) {
  vec2 counts = max(tileCounts, vec2(1.0));
  vec2 scaled = min(uv, vec2(1.0 - ${VFX_UV_EDGE_CLAMP_EPS})) * counts;
  vec2 cell = floor(scaled);
  vec2 localUv = fract(scaled);
  ${flipX ? 'localUv.x = 1.0 - localUv.x;' : ''}
  ${flipY ? 'localUv.y = 1.0 - localUv.y;' : ''}
  localUv = mix(localUv, vec2(1.0) - localUv, vCfxrUvFlip);
  return (cell + localUv) / counts;
}` : ''}
void main() {
  vec4 coverageSample = ${usesMap ? 'texture2D(map, applyParticleUvFlip(vUv))' : 'vec4(1.0)'};
  vec4 texel = ${usesMap ? 'texture2D(map, applyParticleUvFlip(vUv))' : 'vec4(1.0)'};
  ${usesMap ? `#ifdef TILE_BLEND
  vec4 nextCoverageSample = texture2D(map, applyParticleUvFlip(vUvNext));
  coverageSample = mix(coverageSample, nextCoverageSample, vUvBlend);
  texel = mix(texel, nextCoverageSample, vUvBlend);
  #endif` : ''}
  float coverage = ${coverageExpr};
  if (texPower > 1.001) {
    texel.rgb = pow(max(texel.rgb, 0.0), vec3(texPower));
    ${coverageSource === 'luminance' || coverageSource === 'max-rgb'
      ? 'coverage = pow(max(coverage, 0.0), texPower);'
      : ''}
  }
  vec3 vertexRgb = vColor.rgb;
  ${usesVertexColor && !usesRawVertexColor ? `vertexRgb = mix(
    vertexRgb / 12.92,
    pow(max(vertexRgb + 0.055, 0.0) / 1.055, vec3(2.4)),
    step(0.04045, vertexRgb)
  );` : ''}
  ${usesVertColorGain ? 'vertexRgb *= vertColorGain;' : ''}
  if (colorPower > 1.001) vertexRgb = pow(max(vertexRgb, 0.0), vec3(colorPower));
  vertexRgb = mix(vec3(1.0), vertexRgb, vertColorRgbOn);
  float vertexAlpha = mix(1.0, vColor.a, vertColorAlphaOn);
  float alpha = ${usesLegacyMultiply
    ? `mix(1.0, texel.a${usesVertexColor ? ' * vertexAlpha' : ''}, texel.a${usesVertexColor ? ' * vertexAlpha' : ''})`
    : usesLegacyMultiplyColored
    ? `texel.a${usesVertexColor ? ' * vertexAlpha' : ''}`
    : usesLegacyPremultiply
    ? `texel.a${usesVertexColor ? ' * vertexAlpha * vertexAlpha' : ''}`
    : `coverage${usesVertexColor ? ' * vertexAlpha' : ''}`};
  vec3 rgb = ${usesLegacyMultiply
    ? `mix(vec3(1.0), vertexRgb * texel.rgb, texel.a${usesVertexColor ? ' * vertexAlpha' : ''})`
    : usesLegacyMultiplyColored
    ? `mix(vec3(1.0), materialColor * vertexRgb, texel.rgb${usesVertexColor ? ' * vertexAlpha' : ''})`
    : usesLegacyPremultiply
    ? `vertexRgb * texel.rgb${usesVertexColor ? ' * vertexAlpha' : ''}`
    : usesMultiplyTexture
    ? 'vec3(0.0)'
    : usesCoverage
    ? usesSingleChannel
      ? `${usesVertexColor ? 'vertexRgb' : 'vec3(1.0)'}${usesTint ? ' * materialColor' : ''}`
      : `${usesVertexColor ? 'vertexRgb' : 'vec3(1.0)'}${usesMap ? ' * texel.rgb' : ''}${usesTint ? ' * materialColor' : ''}`
    : `${usesMap ? 'texel.rgb' : 'vec3(1.0)'}${usesVertexColor ? ' * vertexRgb' : ''}${usesTint ? ' * materialColor' : ''}`};
  alpha = clamp(alpha * opacityGain, 0.0, 1.0);
  ${usesLegacyDoubleTint ? `rgb *= 2.0;
  alpha = clamp(alpha * legacyAlphaTintFactor, 0.0, 1.0);` : ''}
  if (hdrMultiply > 0.0) rgb *= hdrMultiply;
  // Mirror bridge: explicit clip threshold wins; otherwise keep the generic
  // transparent overdraw floor.
  ${alphaClipThreshold > 0
    ? `if (alpha < ${alphaClipThreshold.toFixed(8)}) discard;`
    : `if (alpha < ${VFX_TRANSPARENT_OVERDRAW_ALPHA_FLOOR}) discard;`}
  // Mirror bridge cfxrFragColor = vec4(rgb, saturate(alpha)).
  gl_FragColor = vec4(rgb, clamp(alpha, 0.0, 1.0));
}`.trim();
  return {
    vertex: `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
varying vec2 vUv;
varying vec4 vColor;
void main() { vUv = uv; vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`.trim(),
    fragment,
    uniforms: {
      map: 'sampler2D',
      materialColor: 'vec3',
      opacityGain: 'float',
      legacyAlphaTintFactor: 'float',
      hdrMultiply: 'float',
      vertColorRgbOn: 'float',
      vertColorAlphaOn: 'float',
      texPower: 'float',
      colorPower: 'float',
      ...(usesMap ? { tileCounts: 'vec2' } : {}),
      ...(usesVertColorGain ? { vertColorGain: 'float' } : {}),
    },
    // A supported IR operation list alone does not prove compatibility with the
    // three.quarks batch fragment ABI (instance attributes, atlas UVs and map
    // bindings are supplied by that ABI). Modules become executable only after
    // a material-family pixel qualification pass writes that proof into the
    // artifact. Until then they are compile-time validation output, not a live
    // replacement for the qualified semantic shader.
    execution: 'validated-only',
    profileCompatible: executable,
  };
}

/** Mirror propsToProfile + injectCfxrShader constant writes. Keep formulas
 * byte-identical to the bridge so dual-path compare stays zero-diff. */
export function bakeBridgeConstantUniforms(props: any): {
  materialColor: [number, number, number];
  opacityGain: number;
  legacyAlphaTintFactor: number;
  hdrMultiply?: number;
  vertColorGain?: number;
  vertColorRgbOn: number;
  vertColorAlphaOn: number;
  texPower: number;
  colorPower: number;
} {
  const colorRaw = props?.frontColor ?? props?.color;
  // Mirror propsToProfile: v3 pending stamps hdrMultiply; refuse soft invent for siblings.
  const stampedPending = typeof props?.hdrMultiply === 'number';
  if (stampedPending) {
    if (!(Array.isArray(colorRaw) && colorRaw.length >= 3)) {
      throw new Error('bakeBridgeConstantUniforms: color required when hdrMultiply stamped (no invent)');
    }
    if (typeof props?.opacity !== 'number') {
      throw new Error('bakeBridgeConstantUniforms: opacity required when hdrMultiply stamped (no invent)');
    }
    if (typeof props?.legacyVertexColorGain !== 'number') {
      throw new Error(
        'bakeBridgeConstantUniforms: legacyVertexColorGain required when hdrMultiply stamped (no invent)',
      );
    }
  }
  // v3 corpus stamps color/opacity; soft-invent identity only when unauthored.
  const color = stampedPending
    ? colorRaw!
    : (Array.isArray(colorRaw) && colorRaw.length >= 3
      ? colorRaw
      : CFXR_COLOR_MUL_SOFT_IDENTITY);
  const opacity = stampedPending
    ? props!.opacity!
    : (typeof props?.opacity === 'number' ? props.opacity : CFXR_OPACITY_SOFT_IDENTITY);
  // hdrMultiply mirrors mat.uniforms.hdrMultiply = Math.max(0, profile.hdr).
  const hdr = stampedPending
    ? Number(props!.hdrMultiply)
    : Number(props?.hdrMultiply ?? props?.hdr ?? CFXR_HDR_SOFT_INVENT);
  const vertColorGain = stampedPending
    ? Number(props!.legacyVertexColorGain)
    : (typeof props?.legacyVertexColorGain === 'number'
      ? Number(props.legacyVertexColorGain)
      : CFXR_LEGACY_VERTEX_COLOR_GAIN_OFF_PATH);
  // Mirror constantUniformsFromProfile: non-DT bake invent is always 2.
  let legacyAlphaTintFactor: number;
  if (props?.legacyDoubleTint) {
    if (typeof props?.legacyAlphaTintFactor !== 'number') {
      throw new Error(
        'bakeBridgeConstantUniforms: legacyDoubleTint requires legacyAlphaTintFactor (no invent)',
      );
    }
    legacyAlphaTintFactor = Number(props.legacyAlphaTintFactor);
  } else {
    if (stampedPending && typeof props?.legacyAlphaTintFactor !== 'number') {
      throw new Error(
        'bakeBridgeConstantUniforms: legacyAlphaTintFactor required when hdrMultiply stamped (no invent)',
      );
    }
    // Bake non-DT path still uses schema factor 2 (not profile off-path 0).
    legacyAlphaTintFactor = VFX_BAKE_NON_DT_LEGACY_ALPHA_TINT_FACTOR;
  }
  return deriveConstantUniforms({
    materialColor: [Number(color[0]), Number(color[1]), Number(color[2])],
    opacityGain: Math.max(0, Number(opacity)),
    legacyAlphaTintFactor: Math.max(0, legacyAlphaTintFactor),
    hdrMultiply: Math.max(0, hdr),
    vertColorGain,
    vertColorRgbOn: typeof props?.vertexColorRgb === 'boolean' ? (props.vertexColorRgb ? 1 : 0) : 1,
    vertColorAlphaOn: typeof props?.vertexColorAlpha === 'boolean' ? (props.vertexColorAlpha ? 1 : 0) : 1,
    texPower: Math.max(0.01, Number(props?.texPower ?? 1)),
    colorPower: Math.max(0.01, Number(props?.colorPower ?? 1)),
  }) as ReturnType<typeof deriveConstantUniforms> & {
    vertColorRgbOn: number;
    vertColorAlphaOn: number;
    texPower: number;
    colorPower: number;
  };
}

/** Mirror propsToProfile blend fields + applySemanticBlendState / slim-inject
 * extras. Coarse material-index blend enums are NOT used — they can disagree
 * with the live bridge (legacy premultiply). */
export function bakeBridgeBlendState(props: any): VfxPipelineBlendState {
  const stampedPending = typeof props?.hdrMultiply === 'number';
  // Soft !! invent only for frozen/unstamped; stamped path gates the boolean below.
  const legacyPremultiply = stampedPending
    ? props.legacyPremultiply
    : !!props?.legacyPremultiply;
  if (stampedPending) {
    if (typeof props?.blendMode !== 'string') {
      throw new Error('bakeBridgeBlendState: blendMode required when hdrMultiply stamped (no invent)');
    }
    if (typeof props?.zWrite !== 'boolean') {
      throw new Error('bakeBridgeBlendState: zWrite required when hdrMultiply stamped (no invent)');
    }
    if (typeof props?.doubleSided !== 'boolean') {
      throw new Error('bakeBridgeBlendState: doubleSided required when hdrMultiply stamped (no invent)');
    }
    if (typeof props?.cutoff !== 'number') {
      throw new Error('bakeBridgeBlendState: cutoff required when hdrMultiply stamped (no invent)');
    }
    if (typeof props?.additive !== 'boolean'
      || typeof props?.legacyPremultiply !== 'boolean'
      || typeof props?.legacyMultiply !== 'boolean'
      || typeof props?.legacyMultiplyColored !== 'boolean') {
      throw new Error(
        'bakeBridgeBlendState: additive/legacyPremultiply/legacyMultiply/legacyMultiplyColored required when hdrMultiply stamped (no invent)',
      );
    }
  }
  // v3 corpus stamps blendMode; frozen/unstamped may still invent from legacy flags.
  // Do NOT invent bare 'alpha' when nothing matches.
  let blendMode = props?.blendMode as VfxBlendMode | undefined;
  if (!blendMode) {
    if (props?.unityMode === 0) blendMode = 'opaque';
    else if (props?.unityMode === 1) blendMode = 'alpha-test';
    else if (legacyPremultiply) blendMode = 'premultiplied-alpha';
    else if (props?.additive) blendMode = 'additive';
    else throw new Error('bakeBridgeBlendState: blendMode required (no invent)');
  }
  return deriveBlendState({
    blendMode,
    additive: stampedPending ? props.additive : !!props?.additive,
    depthWrite: stampedPending
      ? props.zWrite
      : (typeof props?.zWrite === 'boolean'
        ? props.zWrite
        : (blendMode === 'opaque' || blendMode === 'alpha-test')),
    cutoff: stampedPending
      ? props.cutoff
      : (() => {
        if (typeof props?.cutoff === 'number') return props.cutoff;
        if (blendMode === 'alpha-test') {
          throw new Error('bakeBridgeBlendState: alpha-test requires cutoff (no invent)');
        }
        return CFXR_CUTOFF_SOFT_INVENT;
      })(),
    // v3 corpus stamps doubleSided; frozen/unstamped may still invent historical true.
    doubleSided: stampedPending
      ? props.doubleSided
      : (typeof props?.doubleSided === 'boolean'
        ? props.doubleSided
        : CFXR_DOUBLE_SIDED_SOFT_INVENT),
    legacyMultiply: stampedPending ? props.legacyMultiply : !!props?.legacyMultiply,
    legacyPremultiply: stampedPending ? props.legacyPremultiply : legacyPremultiply,
    legacyMultiplyColored: stampedPending ? props.legacyMultiplyColored : !!props?.legacyMultiplyColored,
  });
}

export interface SourceCompileResult {
  artifact?: WebVfxRuntimeV2;
  diagnostics: CompilerDiagnostic[];
}

const numberValue = (value: any, fallback = CFXR_DURATION_SOFT) =>
  typeof value === 'number' ? value : Number(value?.value ?? fallback);

const COVERAGE_TINT_VERTEX = `
attribute vec3 instancePosition;
attribute vec3 instanceSize;
attribute vec4 instanceColor;
attribute float instanceFrame;
attribute vec4 instanceCustom1;
uniform float uTileColumns;
uniform float uTileRows;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vCustom1;
void main() {
  float tile = max(1.0, uTileColumns * uTileRows);
  float col = mod(instanceFrame, max(1.0, uTileColumns));
  float row = floor(instanceFrame / max(1.0, uTileColumns));
  vUv = (uv + vec2(col, row)) / vec2(max(1.0, uTileColumns), max(1.0, uTileRows));
  vColor = instanceColor;
  vCustom1 = instanceCustom1;
  vec3 p = position * instanceSize + instancePosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const COVERAGE_TINT_FRAGMENT = `
precision highp float;
uniform sampler2D uMainMap;
uniform sampler2D uMask;
uniform sampler2D uSceneColor;
uniform float uUseMask;
uniform float uUseSceneColor;
uniform float uUseDissolve;
uniform vec4 uTint;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vCustom1;
void main() {
  vec4 texel = texture2D(uMainMap, vUv);
  float coverage = texel.r;
  if (uUseDissolve > 0.5) coverage *= smoothstep(vCustom1.x - 0.05, vCustom1.x + 0.05, texel.a);
  if (uUseMask > 0.5) coverage *= texture2D(uMask, vUv).r;
  vec3 rgb = uTint.rgb * vColor.rgb;
  if (uUseSceneColor > 0.5) rgb += texture2D(uSceneColor, vUv).rgb;
  float alpha = coverage * uTint.a * vColor.a;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(rgb, alpha);
}`;

function walkNodes(node: any, visit: (node: any) => void): void {
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node.children)) node.children.forEach((child: any) => walkNodes(child, visit));
}

function renderModeOf(value: number): 'billboard' | 'stretched-billboard' | 'mesh' | 'trail' {
  if (value === 2) return 'mesh';
  if (value === 1) return 'stretched-billboard';
  if (value === 3) return 'trail';
  return 'billboard';
}

/** Lower the subset already represented by the exporter material IR. */
export function compileLegacyQuarksSource(source: any, compilerVersion = 'unity-vfx-compiler@0.2'): SourceCompileResult {
  const diagnostics: CompilerDiagnostic[] = [];
  const materials = new Map<string, any>();
  for (const material of source?.materials ?? []) materials.set(material.uuid, material);
  const resources: WebVfxRuntimeV2['resources'] = [];
  for (const texture of source?.textures ?? []) {
    const image = (source.images ?? []).find((entry: any) => entry.uuid === texture.image);
    if (!image?.url) {
      diagnostics.push({ severity: 'error', code: 'TEXTURE_IMAGE_MISSING', path: `$.textures.${texture.uuid}`, message: `Texture '${texture.uuid}' has no image URL.` });
      continue;
    }
    resources.push({ id: texture.uuid, kind: 'texture', uri: image.url, colorSpace: image.sRGB ? 'srgb' : 'linear' });
  }
  for (const geometry of source?.geometries ?? []) {
    if (!Array.isArray(geometry.positions) || geometry.positions.length < 3) continue;
    resources.push({
      id: geometry.uuid,
      kind: 'geometry',
      uri: `embedded:${geometry.uuid}`,
      metadata: {
        positions: geometry.positions,
        indices: geometry.indices ?? [],
        uvs: geometry.uvs ?? [],
        normals: geometry.normals ?? [],
      },
    });
  }
  const runtimeMaterials: WebVfxRuntimeV2['materials'] = [];
  for (const material of materials.values()) {
    const program = material.vfxProgram;
    if (!program || program.schema !== 'particle-material-program@2') {
      diagnostics.push({ severity: 'error', code: 'MATERIAL_PROGRAM_MISSING', path: `$.materials.${material.uuid}`, message: `Material '${material.name ?? material.uuid}' has no explicit material program.` });
      continue;
    }
    if (program.lowering !== 'verified-supported-subset' && program.lowering !== 'slash-screen@2') {
      diagnostics.push({ severity: 'error', code: 'MATERIAL_LOWERING_UNSUPPORTED', path: `$.materials.${material.uuid}.vfxProgram.lowering`, message: `Unsupported material lowering '${program.lowering}'.` });
      continue;
    }
    const supportedOperations = new Set([
      'sample-main', 'coverage', 'vertex-color', 'tint', 'dissolve',
      'soft-particle-depth', 'dynamic-alpha-clip', 'hdr-multiply', 'blend',
      'manual-graph-lowering', 'mask',
    ]);
    for (const operation of program.operations ?? []) {
      if (!supportedOperations.has(operation.op)) {
        diagnostics.push({ severity: 'error', code: 'MATERIAL_OPERATION_UNSUPPORTED', path: `$.materials.${material.uuid}.vfxProgram.operations`, message: `Operation '${operation.op}' is not implemented by the runtime@2 shader compiler.` });
      }
      if (operation.op === 'manual-graph-lowering' && operation.id !== 'slash-screen@2') {
        diagnostics.push({ severity: 'error', code: 'MANUAL_LOWERING_UNSUPPORTED', path: `$.materials.${material.uuid}.vfxProgram.operations`, message: `Manual lowering '${operation.id}' is not implemented by the runtime@2 shader compiler.` });
      }
    }
    const shaderId = `shader-${material.uuid}`;
    runtimeMaterials.push({
      id: material.uuid,
      vertexShader: COVERAGE_TINT_VERTEX,
      fragmentShader: COVERAGE_TINT_FRAGMENT,
      textures: Object.fromEntries(Object.entries(material.maps ?? {})
        .filter(([slot]) => slot === 'main' || slot === 'mask')
        .map(([slot, id]) => [slot === 'main' ? 'uMainMap' : 'uMask', String(id)])),
      uniforms: {
        uTint: material.color ?? CFXR_MATERIAL_TINT_SOFT,
        operations: program.operations ?? [],
        uUseMask: (program.operations ?? []).some((operation: any) => operation.op === 'mask') ? 1 : 0,
        uUseSceneColor: (program.operations ?? []).some((operation: any) => operation.op === 'manual-graph-lowering' && operation.id === 'slash-screen@2') ? 1 : 0,
        uUseDissolve: (program.operations ?? []).some((operation: any) => operation.op === 'dissolve') ? 1 : 0,
      },
      renderState: {
        blend: program.blend === 'additive' ? 'additive' : program.blend === 'premultiplied-alpha' ? 'premultiplied' : program.blend === 'multiply' ? 'multiply' : program.blend === 'opaque' ? 'opaque' : 'alpha',
        depthTest: material.depthTest !== false,
        depthWrite: material.depthWrite === true,
        cull: 'none',
        alphaTest: Number(material.alphaTest ?? CFXR_ALPHA_TEST_SOFT),
        toneMapped: false,
      },
    });
  }
  const programs: WebVfxRuntimeV2['programs'] = [];
  const systems: WebVfxRuntimeV2['systems'] = [];
  walkNodes(source?.object, (node) => {
    if (node.type !== 'ParticleEmitter' || !node.ps || !node.uuid) return;
    const ps = node.ps;
    const behaviorIds: string[] = [];
    for (const behavior of ps.behaviors ?? []) {
      const supported = new Set(['ColorOverLife', 'SizeOverLife', 'FrameOverLife', 'LimitSpeedOverLife', 'RotationOverLife']);
      if (!supported.has(behavior.type)) {
        diagnostics.push({ severity: 'error', code: 'BEHAVIOR_UNSUPPORTED', path: `$.object.${node.uuid}.ps.behaviors`, message: `Behavior '${behavior.type}' is not yet compiled by runtime@2.` });
        continue;
      }
      const id = `${node.uuid}:${behavior.type}`;
      behaviorIds.push(id);
      programs.push({ id, op: behavior.type, params: behavior });
    }
    const startDelay = numberValue(ps.startDelay);
    systems.push({
      id: node.uuid,
      nodeId: node.uuid,
      material: String(ps.material),
      geometry: ps.instancingGeometry ? String(ps.instancingGeometry) : undefined,
      capacity: Math.max(1, Number(ps.maxParticles ?? CFXR_QUARKS_MAX_PARTICLES_SOFT)),
      duration: Math.max(0, Number(ps.duration ?? CFXR_DURATION_SOFT)),
      particleLife: Math.max(
        CFXR_PARTICLE_LIFE_MIN,
        numberValue(ps.startLife, Number(ps.duration ?? CFXR_START_LIFE_DURATION_FALLBACK)),
      ),
      looping: !!ps.looping,
      startDelay,
      emission: {
        bursts: (ps.emissionBursts ?? []).map((burst: any) => ({
          time: Number(burst.time ?? CFXR_BURST_TIME_SOFT),
          count: Math.max(0, Math.floor(numberValue(burst.count))),
        })),
        rateOverTime: numberValue(ps.emissionOverTime),
      },
      initialParticles: (ps.unityInitialState ?? []).map((state: any) => ({
        position: state.position ?? CFXR_INITIAL_POSITION_SOFT,
        velocity: state.velocity ?? CFXR_INITIAL_VELOCITY_SOFT,
        size: state.size ?? CFXR_INITIAL_SIZE_SOFT,
        color: state.color ?? CFXR_INITIAL_COLOR_SOFT,
        life: Number(state.life ?? numberValue(ps.startLife, CFXR_START_LIFE_DURATION_FALLBACK)),
        frame: state.frame == null || state.frame < 0 ? undefined : Number(state.frame),
        custom1: Array.isArray(state.custom1) ? state.custom1 : [...CFXR_STREAM_CUSTOM_ZERO_SOFT],
      })),
      flipbook: {
        columns: Math.max(1, Number(ps.uTileCount ?? CFXR_QUARKS_TILE_COUNT_SOFT)),
        rows: Math.max(1, Number(ps.vTileCount ?? CFXR_QUARKS_TILE_COUNT_SOFT)),
      },
      renderMode: renderModeOf(Number(ps.renderMode ?? CFXR_RENDER_MODE_SOFT)),
      programs: behaviorIds,
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    });
  });
  if (diagnostics.some((entry) => entry.severity === 'error')) return { diagnostics };
  const contract = source.vfxIR ?? {};
  if (typeof contract.seed !== 'number') {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_SEED',
      path: '$.vfxIR.seed',
      message: 'vfxIR.seed is required (no invent).',
    });
  }
  if (!(typeof contract.fixedDelta === 'number' && contract.fixedDelta > 0)) {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_FIXED_DELTA',
      path: '$.vfxIR.fixedDelta',
      message: 'vfxIR.fixedDelta must be a positive number (no invent).',
    });
  }
  if (diagnostics.some((entry) => entry.severity === 'error')) return { diagnostics };
  return {
    diagnostics,
    artifact: writeRuntimeV2({
      schema: 'web-vfx-runtime@2',
      effectId: String(contract.effectId ?? source.object?.name ?? 'effect'),
      compilerVersion,
      seed: contract.seed,
      fixedDelta: contract.fixedDelta,
      duration: Number(contract.lifecycle?.terminalTime ?? CFXR_DURATION_SOFT),
      looping: false,
      resources,
      materials: runtimeMaterials,
      programs,
      systems,
    }),
  };
}

/**
 * Validate and lower a Unity/Quarks source document. Unsupported semantics
 * become diagnostics and block artifact emission; no online fallback is used.
 */
export function compileSourceJson(source: unknown): SourceCompileResult {
  const diagnostics: CompilerDiagnostic[] = [];
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { diagnostics: [{ severity: 'error', code: 'SOURCE_NOT_OBJECT', path: '$', message: 'Source document must be an object.' }] };
  }
  const value = source as Record<string, unknown>;
  const contract = value.vfxIR;
  if (!contract || typeof contract !== 'object') {
    diagnostics.push({ severity: 'error', code: 'MISSING_SOURCE_CONTRACT', path: '$.vfxIR', message: 'Unity source is missing the semantic contract.' });
  }
  if (!value.object || typeof value.object !== 'object') {
    diagnostics.push({ severity: 'error', code: 'MISSING_OBJECT', path: '$.object', message: 'Unity source is missing its Object3D hierarchy.' });
  }
  if (!Array.isArray(value.materials)) {
    diagnostics.push({ severity: 'error', code: 'MISSING_MATERIALS', path: '$.materials', message: 'Unity source is missing serialized materials.' });
  }
  if (!Array.isArray(value.textures)) {
    diagnostics.push({ severity: 'error', code: 'MISSING_TEXTURES', path: '$.textures', message: 'Unity source is missing serialized textures.' });
  }
  if (diagnostics.some((entry) => entry.severity === 'error')) return { diagnostics };
  const lowered = compileLegacyQuarksSource(value);
  return {
    artifact: lowered.artifact,
    diagnostics: [...diagnostics, ...lowered.diagnostics],
  };
}
