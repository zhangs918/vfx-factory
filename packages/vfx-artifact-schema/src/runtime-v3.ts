/** Final offline/online boundary.  The player receives no Unity or Shader Graph concepts. */
export const VFX_RUNTIME_ARTIFACT_V3 = 'vfx-runtime-artifact@3' as const;

/** Shared bake invents — keep offline compiler and online bridge byte-identical. */
export const VFX_ALPHA_TEST_FLOOR = 0.001;
export const VFX_ALPHA_TEST_DISABLED = 0;
export const VFX_TONE_MAPPED_OFF = false as const;
/** Historical bake invent for non-legacyDoubleTint (full-inject profile off-path is 0). */
export const VFX_BAKE_NON_DT_LEGACY_ALPHA_TINT_FACTOR = 2;
/**
 * Generic transparent overdraw discard floor when alphaClipThreshold is unset/0.
 * Frozen-sensitive (Multiply Colored smoke / soft overdraw).
 */
export const VFX_TRANSPARENT_OVERDRAW_ALPHA_FLOOR = 0.02;
/**
 * UV edge clamp before flipbook cell math (min(uv, 1-eps)).
 * Load-bearing for Multiply Colored zero-diff — do not change casually.
 */
export const VFX_UV_EDGE_CLAMP_EPS = 1e-7;

export type VfxResourceKind = 'texture' | 'geometry' | 'lut' | 'binary';

export interface VfxResourceRef {
  id: string;
  kind: VfxResourceKind;
  uri: string;
  sha256: string;
  bytes?: number;
  mime?: string;
}

export interface VfxShaderModule {
  id: string;
  vertex: string;
  fragment: string;
  uniforms: Record<string, string>;
  attributes?: Record<string, string>;
  varyings?: Record<string, string>;
  /** How this module is consumed by the three.quarks material ABI. */
  execution?: 'quarks-fragment-v1' | 'validated-only';
  /**
   * When `quarks-vertex-v1`, `vertex` is a Quarks stock template with offline
   * CFXR patches already applied. Thin player binds it directly.
   */
  vertexExecution?: 'quarks-vertex-v1';
}

/** Constant fragment uniforms baked offline from the same CFXR profile fields the
 * runtime bridge historically wrote after injectCfxrShader. Optional for older
 * artifacts; when present the player can dual-compare or take authority. */
export type VfxPipelineUniformValues = {
  materialColor?: [number, number, number];
  opacityGain?: number;
  legacyAlphaTintFactor?: number;
  /** Present only when the material uses HDR punch; omit keeps non-HDR shaders byte-identical. */
  hdrMultiply?: number;
  /**
   * Bridge `vertColorGain` (legacyVertexColorGain). Present when ≠ 1 so non-gain
   * shaders stay byte-identical; default bridge value is 1.
   */
  vertColorGain?: number;
  /** Bridge-neutral operations are retained as uniforms to preserve GPU rounding order. */
  vertColorRgbOn?: number;
  vertColorAlphaOn?: number;
  texPower?: number;
  colorPower?: number;
};

/** Shared constant-uniform bake. Matches injectCfxrShader / bakeBridgeConstantUniforms. */
export function deriveConstantUniforms(input: {
  materialColor: [number, number, number];
  opacityGain: number;
  legacyAlphaTintFactor: number;
  hdrMultiply?: number;
  vertColorGain?: number;
  vertColorRgbOn?: number;
  vertColorAlphaOn?: number;
  texPower?: number;
  colorPower?: number;
}): Required<Pick<VfxPipelineUniformValues, 'materialColor' | 'opacityGain' | 'legacyAlphaTintFactor'>>
  & Pick<VfxPipelineUniformValues,
    'hdrMultiply' | 'vertColorGain' | 'vertColorRgbOn' | 'vertColorAlphaOn' | 'texPower' | 'colorPower'> {
  const values: ReturnType<typeof deriveConstantUniforms> = {
    materialColor: [
      Number(input.materialColor[0]),
      Number(input.materialColor[1]),
      Number(input.materialColor[2]),
    ],
    opacityGain: Math.max(0, Number(input.opacityGain)),
    legacyAlphaTintFactor: Math.max(0, Number(input.legacyAlphaTintFactor)),
  };
  if (input.hdrMultiply !== undefined) {
    values.hdrMultiply = Math.max(0, Number(input.hdrMultiply));
  }
  if (input.vertColorGain !== undefined) {
    values.vertColorGain = Math.max(0, Number(input.vertColorGain));
  }
  if (input.vertColorRgbOn !== undefined) values.vertColorRgbOn = Number(input.vertColorRgbOn);
  if (input.vertColorAlphaOn !== undefined) values.vertColorAlphaOn = Number(input.vertColorAlphaOn);
  if (input.texPower !== undefined) values.texPower = Math.max(0.01, Number(input.texPower));
  if (input.colorPower !== undefined) values.colorPower = Math.max(0.01, Number(input.colorPower));
  return values;
}

export type VfxBlendMode =
  | 'opaque' | 'alpha-test' | 'alpha' | 'premultiplied-alpha' | 'additive' | 'multiply';

/** Effective Three.js material blend state produced by applySemanticBlendState +
 * the slim-inject extras (side / toneMapped). Coarse pipeline.blend / srcBlend
 * may disagree with the live bridge (legacy premultiply); this bake is the
 * authority dual-path. Optional for older artifacts. */
export type VfxPipelineBlendState = {
  path: 'legacy-multiply' | 'legacy-premultiply' | 'legacy-multiply-colored' | 'semantic';
  /** Meaningful when path === 'semantic'; legacy paths install CustomBlending. */
  blending: 'no' | 'additive' | 'normal';
  premultipliedAlpha: boolean;
  depthWrite: boolean;
  transparent: boolean;
  alphaTest: number;
  side: 'front' | 'double';
  toneMapped: false;
};

/** Derive the portable blend bake from the same profile fields the bridge uses.
 * Shared by the offline compiler and the runtime dual-path so formulas cannot drift. */
export function deriveBlendState(input: {
  blendMode: VfxBlendMode;
  additive?: boolean;
  depthWrite: boolean;
  cutoff: number;
  doubleSided: boolean;
  legacyMultiply?: boolean;
  legacyPremultiply?: boolean;
  legacyMultiplyColored?: boolean;
}): VfxPipelineBlendState {
  const blendMode = input.blendMode;
  let path: VfxPipelineBlendState['path'] = 'semantic';
  let blending: VfxPipelineBlendState['blending'] = 'normal';
  let premultipliedAlpha = false;
  if (input.legacyMultiply) {
    path = 'legacy-multiply';
  } else if (input.legacyPremultiply) {
    path = 'legacy-premultiply';
  } else if (input.legacyMultiplyColored) {
    path = 'legacy-multiply-colored';
  } else if (blendMode === 'opaque' || blendMode === 'alpha-test') {
    blending = 'no';
  } else if (blendMode === 'additive' || input.additive) {
    blending = 'additive';
  } else {
    blending = 'normal';
    premultipliedAlpha = blendMode === 'premultiplied-alpha';
  }
  return {
    path,
    blending,
    premultipliedAlpha,
    depthWrite: !!input.depthWrite,
    transparent: blendMode !== 'opaque' && blendMode !== 'alpha-test',
    alphaTest: blendMode === 'alpha-test'
      ? Math.max(VFX_ALPHA_TEST_FLOOR, Number(input.cutoff) || VFX_ALPHA_TEST_DISABLED)
      : VFX_ALPHA_TEST_DISABLED,
    side: input.doubleSided ? 'double' : 'front',
    toneMapped: VFX_TONE_MAPPED_OFF,
  };
}

export interface VfxPipelineState {
  /** Source Quarks material UUID; explicit binding survives namespaced pipeline ids. */
  materialId: string;
  blend: VfxBlendMode;
  srcBlend: number;
  dstBlend: number;
  zWrite: boolean;
  zTest?: number;
  alphaTest?: number;
  side?: 'front' | 'back' | 'double';
  shader: string;
  textures: Record<string, string>;
  defines?: Record<string, string | number | boolean>;
  /** Offline-baked constant uniforms for the artifact fragment ABI. */
  uniformValues?: VfxPipelineUniformValues;
  /** Offline-baked effective blend state (bridge-equivalent). */
  blendState?: VfxPipelineBlendState;
  /** Offline UV flipbook tile counts (`tileCounts` uniform) when emitters agree. */
  tileCounts?: [number, number];
  /**
   * Full live uniform table recorded from a thick-path capture.
   * Optional; present for capture-stamped artifact-shader pipelines.
   */
  capturedUniforms?: Record<string, number | number[]>;
  /** Explicit execution ownership. Runtime code must never infer this from shader names. */
  executor: 'semantic-bridge@1' | 'artifact-shader@1';
  qualification: {
    status: 'bridge' | 'capture-stamped' | 'pixel-qualified';
    familyId: string;
    baseline: 'frozen-semantic@1';
    evidence?: {
      compilerVersion?: string;
      captureTimes?: number[];
      changedPixels?: number;
      maxChannelDelta?: number;
      /** Present when executor ownership came from a live thick-path dump. */
      captureProvenance?: 'live-bridge-capture@1';
      capturedAt?: string;
      injectMode?: string;
    };
  };
}

/** Vertex patches that injectCfxrShader may apply on top of the Quarks stock
 * vertex program. Audit-only until an offline vertex ABI is executable. */
export const VFX_VERTEX_PATCH_IDS = [
  'cfxr-custom-attrs@1',
  'unity-centered-stretch@1',
  'unity-vertical-billboard@1',
] as const;
export type VfxVertexPatchId = (typeof VFX_VERTEX_PATCH_IDS)[number];

/** A closure is the exact set of pipelines that three.quarks may merge into one
 * draw batch for this effect. Transparent material migration is only safe when
 * the complete closure has been reviewed together; replacing one member can
 * alter compositing order even if its isolated shader is pixel-equivalent. */
export interface VfxBatchClosure {
  id: string;
  emitterIds: string[];
  pipelineIds: string[];
  /** Canonical offline representation of three.quarks' batch equality inputs. */
  renderSignature: string;
  /** Declared inject vertex patches for this closure (audit / future dual-path). */
  vertexPatches?: VfxVertexPatchId[];
  qualification: {
    status: 'bridge' | 'capture-stamped' | 'pixel-qualified';
    baseline: 'frozen-semantic@1';
    evidence?: {
      compilerVersion?: string;
      captureTimes?: number[];
      changedPixels?: number;
      maxChannelDelta?: number;
      captureProvenance?: 'live-bridge-capture@1';
      capturedAt?: string;
      injectMode?: string;
    };
  };
}

export interface VfxRuntimeArtifactV3 {
  schema: typeof VFX_RUNTIME_ARTIFACT_V3;
  effectId: string;
  compiler: { name: string; version: string };
  simulation?: Record<string, unknown>;
  pipelines: Record<string, VfxPipelineState>;
  /** Optional on migration artifacts produced before batch-closure analysis. */
  batchClosures?: Record<string, VfxBatchClosure>;
  shaders?: Record<string, VfxShaderModule>;
  resources: Record<string, VfxResourceRef>;
  metadata: { sourceSchema?: string; seed: number; fixedDelta: number };
  execution: {
    material: 'per-pipeline@1';
    simulation: 'semantic-bridge@1' | 'quarks-native@1' | 'artifact-emitter-sim@1';
    trajectory: 'semantic-bridge@1' | 'artifact-trajectory@1';
  };
  /** Fully compiled runtime state. This is part of the contract, not a legacy sidecar. */
  runtimeState?: { cfxrState: Record<string, unknown>; runtimeConfig: Record<string, unknown> };
  /** Physical code/config split. Optional only for pre-split migration artifacts. */
  files?: {
    config: { uri: string; sha256: string };
    shaders: Record<string, {
      id: string;
      vertex: { uri: string; sha256: string };
      fragment: { uri: string; sha256: string };
      uniforms: Record<string, string>;
      attributes?: Record<string, string>;
      varyings?: Record<string, string>;
      execution?: 'quarks-fragment-v1' | 'validated-only';
      vertexExecution?: 'quarks-vertex-v1';
    }>;
  };
}

const blends = new Set<VfxPipelineState['blend']>([
  'opaque', 'alpha-test', 'alpha', 'premultiplied-alpha', 'additive', 'multiply',
]);
const resourceKinds = new Set<VfxResourceKind>(['texture', 'geometry', 'lut', 'binary']);
const sha256Pattern = /^[a-f0-9]{64}$/;

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
}

function isSafeAssetUri(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string' || !value.startsWith(prefix)
    || value.includes('\\') || value.includes('?') || value.includes('#')) return false;
  const relative = value.slice(prefix.length);
  if (!relative) return false;
  try {
    return relative.split('/').every((segment) => {
      const decoded = decodeURIComponent(segment);
      return segment.length > 0 && decoded !== '.' && decoded !== '..'
        && !decoded.includes('/') && !decoded.includes('\\');
    });
  } catch {
    return false;
  }
}

export function assertVfxRuntimeArtifactV3(value: unknown): asserts value is VfxRuntimeArtifactV3 {
  if (!value || typeof value !== 'object') throw new Error('vfx-runtime-artifact@3 must be an object');
  const artifact = value as Partial<VfxRuntimeArtifactV3>;
  if (artifact.schema !== VFX_RUNTIME_ARTIFACT_V3) throw new Error('Unsupported runtime artifact schema');
  if (!artifact.effectId || typeof artifact.effectId !== 'string') throw new Error('Artifact effectId is required');
  if (!artifact.compiler || typeof artifact.compiler.name !== 'string' || !artifact.compiler.name
    || typeof artifact.compiler.version !== 'string' || !artifact.compiler.version) {
    throw new Error('Artifact compiler identity is required');
  }
  if ((!artifact.simulation || typeof artifact.simulation !== 'object') && !artifact.files?.config) throw new Error('Artifact simulation or external config is required');
  if (!artifact.pipelines || typeof artifact.pipelines !== 'object') throw new Error('Artifact pipelines are required');
  if ((!artifact.shaders || typeof artifact.shaders !== 'object') && !artifact.files?.shaders) throw new Error('Artifact shaders or external shader files are required');
  if (!artifact.resources || typeof artifact.resources !== 'object') throw new Error('Artifact resources are required');
  if (artifact.execution?.material !== 'per-pipeline@1'
    || !['semantic-bridge@1', 'quarks-native@1', 'artifact-emitter-sim@1'].includes(artifact.execution?.simulation ?? '')
    || !['semantic-bridge@1', 'artifact-trajectory@1'].includes(artifact.execution?.trajectory ?? '')) {
    throw new Error('Artifact execution ownership is missing or invalid');
  }
  if (!artifact.metadata || !Number.isFinite(artifact.metadata.seed) || !Number.isFinite(artifact.metadata.fixedDelta)
    || artifact.metadata.fixedDelta <= 0) {
    throw new Error('Artifact metadata must contain deterministic seed and fixedDelta');
  }
  if ((!artifact.runtimeState || typeof artifact.runtimeState !== 'object') && !artifact.files?.config) {
    throw new Error('Artifact runtimeState or external config is required');
  }
  if (artifact.runtimeState && (typeof artifact.runtimeState !== 'object'
    || !artifact.runtimeState.cfxrState || typeof artifact.runtimeState.cfxrState !== 'object'
    || !artifact.runtimeState.runtimeConfig || typeof artifact.runtimeState.runtimeConfig !== 'object')) {
    throw new Error('Artifact runtimeState must contain compiled cfxrState and runtimeConfig');
  }
  for (const [id, pipeline] of Object.entries(artifact.pipelines)) {
    if (!pipeline || !blends.has(pipeline.blend)) throw new Error(`Pipeline '${id}' has invalid blend mode`);
    if (typeof pipeline.materialId !== 'string' || !pipeline.materialId
      || !Number.isFinite(pipeline.srcBlend) || !Number.isFinite(pipeline.dstBlend)
      || typeof pipeline.zWrite !== 'boolean' || typeof pipeline.shader !== 'string') {
      throw new Error(`Pipeline '${id}' has invalid fixed render state`);
    }
    if (!['semantic-bridge@1', 'artifact-shader@1'].includes(pipeline.executor)
      || !pipeline.qualification
      || pipeline.qualification.baseline !== 'frozen-semantic@1'
      || !['bridge', 'capture-stamped', 'pixel-qualified'].includes(pipeline.qualification.status)
      || (pipeline.executor === 'artifact-shader@1'
        && pipeline.qualification.status === 'bridge')
      || (pipeline.executor === 'semantic-bridge@1'
        && pipeline.qualification.status !== 'bridge')) {
      throw new Error(`Pipeline '${id}' has invalid execution qualification`);
    }
    if (pipeline.qualification.status === 'capture-stamped'
      && pipeline.qualification.evidence?.captureProvenance !== 'live-bridge-capture@1') {
      throw new Error(`Pipeline '${id}' is capture-stamped without live-bridge-capture provenance`);
    }
    if (pipeline.uniformValues !== undefined) {
      const values = pipeline.uniformValues;
      if (!values || typeof values !== 'object') {
        throw new Error(`Pipeline '${id}' has invalid uniformValues`);
      }
      if (values.materialColor !== undefined
        && (!Array.isArray(values.materialColor) || values.materialColor.length !== 3
          || values.materialColor.some((channel) => !Number.isFinite(channel)))) {
        throw new Error(`Pipeline '${id}' materialColor must be a finite vec3`);
      }
      if (values.opacityGain !== undefined && !Number.isFinite(values.opacityGain)) {
        throw new Error(`Pipeline '${id}' opacityGain must be finite`);
      }
      if (values.legacyAlphaTintFactor !== undefined && !Number.isFinite(values.legacyAlphaTintFactor)) {
        throw new Error(`Pipeline '${id}' legacyAlphaTintFactor must be finite`);
      }
      if (values.hdrMultiply !== undefined && !Number.isFinite(values.hdrMultiply)) {
        throw new Error(`Pipeline '${id}' hdrMultiply must be finite`);
      }
      if (values.vertColorGain !== undefined && !Number.isFinite(values.vertColorGain)) {
        throw new Error(`Pipeline '${id}' vertColorGain must be finite`);
      }
      for (const key of ['vertColorRgbOn', 'vertColorAlphaOn', 'texPower', 'colorPower'] as const) {
        if (values[key] !== undefined && !Number.isFinite(values[key])) {
          throw new Error(`Pipeline '${id}' ${key} must be finite`);
        }
      }
    }
    if (pipeline.blendState !== undefined) {
      const state = pipeline.blendState;
      const paths = new Set(['legacy-multiply', 'legacy-premultiply', 'legacy-multiply-colored', 'semantic']);
      const blendings = new Set(['no', 'additive', 'normal']);
      if (!state || typeof state !== 'object'
        || !paths.has(state.path)
        || !blendings.has(state.blending)
        || typeof state.premultipliedAlpha !== 'boolean'
        || typeof state.depthWrite !== 'boolean'
        || typeof state.transparent !== 'boolean'
        || !Number.isFinite(state.alphaTest)
        || (state.side !== 'front' && state.side !== 'double')
        || state.toneMapped !== VFX_TONE_MAPPED_OFF) {
        throw new Error(`Pipeline '${id}' has invalid blendState`);
      }
    }
    if (pipeline.tileCounts !== undefined) {
      const tiles = pipeline.tileCounts;
      if (!Array.isArray(tiles) || tiles.length !== 2
        || !Number.isFinite(tiles[0]) || !Number.isFinite(tiles[1])
        || tiles[0] < 1 || tiles[1] < 1) {
        throw new Error(`Pipeline '${id}' tileCounts must be a finite [u,v] pair >= 1`);
      }
    }
    const evidence = pipeline.qualification.evidence;
    if (pipeline.qualification.status === 'pixel-qualified'
      && (!evidence || typeof evidence.compilerVersion !== 'string' || !evidence.compilerVersion
        || !Array.isArray(evidence.captureTimes) || evidence.captureTimes.length === 0
        || evidence.captureTimes.some((time) => !Number.isFinite(time))
        || evidence.changedPixels !== 0 || evidence.maxChannelDelta !== 0)) {
      throw new Error(`Pipeline '${id}' is pixel-qualified without zero-delta multi-time evidence`);
    }
    if (!artifact.shaders?.[pipeline.shader] && !artifact.files?.shaders?.[pipeline.shader]) throw new Error(`Pipeline '${id}' references missing shader '${pipeline.shader}'`);
    for (const [slot, resource] of Object.entries(pipeline.textures ?? {})) {
      if (!artifact.resources[resource]) throw new Error(`Pipeline '${id}' texture '${slot}' references missing resource '${resource}'`);
    }
  }
  const knownVertexPatches = new Set<string>(VFX_VERTEX_PATCH_IDS);
  for (const [id, closure] of Object.entries(artifact.batchClosures ?? {})) {
    if (!closure || closure.id !== id || !Array.isArray(closure.emitterIds)
      || !closure.emitterIds.length || !Array.isArray(closure.pipelineIds)
      || !closure.pipelineIds.length || typeof closure.renderSignature !== 'string'
      || closure.qualification?.baseline !== 'frozen-semantic@1'
      || !['bridge', 'capture-stamped', 'pixel-qualified'].includes(closure.qualification?.status ?? '')) {
      throw new Error(`Batch closure '${id}' is invalid`);
    }
    if (closure.vertexPatches !== undefined) {
      if (!Array.isArray(closure.vertexPatches)
        || closure.vertexPatches.some((patch) => !knownVertexPatches.has(patch))) {
        throw new Error(`Batch closure '${id}' has unknown vertexPatches`);
      }
    }
    for (const pipelineId of closure.pipelineIds) {
      if (!artifact.pipelines[pipelineId]) {
        throw new Error(`Batch closure '${id}' references missing pipeline '${pipelineId}'`);
      }
      if (closure.qualification.status === 'pixel-qualified'
        && artifact.pipelines[pipelineId].qualification.status !== 'pixel-qualified') {
        throw new Error(`Batch closure '${id}' is pixel-qualified while pipeline '${pipelineId}' remains unproven`);
      }
      if (closure.qualification.status === 'capture-stamped'
        && !['capture-stamped', 'pixel-qualified'].includes(
          artifact.pipelines[pipelineId].qualification.status,
        )) {
        throw new Error(`Batch closure '${id}' is capture-stamped while pipeline '${pipelineId}' remains bridge`);
      }
    }
    const evidence = closure.qualification.evidence;
    if (closure.qualification.status === 'pixel-qualified'
      && (!evidence || typeof evidence.compilerVersion !== 'string' || !evidence.compilerVersion
        || !Array.isArray(evidence.captureTimes) || !evidence.captureTimes.length
        || evidence.captureTimes.some((time) => !Number.isFinite(time))
        || evidence.changedPixels !== 0 || evidence.maxChannelDelta !== 0)) {
      throw new Error(`Batch closure '${id}' is pixel-qualified without zero-delta multi-time evidence`);
    }
  }
  for (const [id, shader] of Object.entries(artifact.shaders ?? {})) {
    if (!shader || shader.id !== id || typeof shader.vertex !== 'string' || typeof shader.fragment !== 'string'
      || !shader.vertex.includes('void main') || !shader.fragment.includes('void main')
      || !shader.uniforms || typeof shader.uniforms !== 'object'
      || (shader.execution !== undefined && shader.execution !== 'quarks-fragment-v1' && shader.execution !== 'validated-only')
      || (shader.vertexExecution !== undefined && shader.vertexExecution !== 'quarks-vertex-v1')) {
      throw new Error(`Shader '${id}' is not an executable GLSL module`);
    }
  }
  for (const [id, resource] of Object.entries(artifact.resources)) {
    if (!resource || resource.id !== id || !resourceKinds.has(resource.kind)
      || !isSafeAssetUri(resource.uri, '/assets/v3-resources/')) {
      throw new Error(`Resource '${id}' is not a split v3 resource reference`);
    }
    assertSha256(resource.sha256, `Resource '${id}' sha256`);
    if (resource.bytes !== undefined && (!Number.isInteger(resource.bytes) || resource.bytes < 0)) {
      throw new Error(`Resource '${id}' bytes must be a non-negative integer`);
    }
  }
  if (artifact.files) {
    if (!isSafeAssetUri(artifact.files.config?.uri, '/assets/v3-code/')
      || !artifact.files.shaders) {
      throw new Error('Artifact files split is incomplete');
    }
    assertSha256(artifact.files.config.sha256, 'Artifact config sha256');
    for (const [id, shader] of Object.entries(artifact.files.shaders)) {
      if (shader.id !== id || !isSafeAssetUri(shader.vertex?.uri, '/assets/v3-code/')
        || !isSafeAssetUri(shader.fragment?.uri, '/assets/v3-code/')
        || !shader.uniforms || typeof shader.uniforms !== 'object') {
        throw new Error(`Artifact split shader '${id}' is incomplete`);
      }
      assertSha256(shader.vertex.sha256, `Artifact split shader '${id}' vertex sha256`);
      assertSha256(shader.fragment.sha256, `Artifact split shader '${id}' fragment sha256`);
    }
  }
}
