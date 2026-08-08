/**
 * Protocol boundary between the Unity compiler and every playback backend.
 *
 * This package deliberately contains no Three.js, Unity, DOM, or Quarks code.
 * It is the only place where the artifact envelope and its compatibility rules
 * are defined.  The first release accepts the existing unity-vfx-ir@1 payload
 * as a legacy envelope so the runtime can migrate without changing playback.
 */

export const VFX_ARTIFACT_SCHEMA = 'vfx-artifact@1' as const;
export const LEGACY_UNITY_IR_SCHEMA = 'unity-vfx-ir@1' as const;
export const MATERIAL_PROGRAM_SCHEMA = 'particle-material-program@2' as const;
export const WEB_RUNTIME_ARTIFACT_SCHEMA = 'web-vfx-runtime@1' as const;
export {
  VFX_RUNTIME_ARTIFACT_V3,
  VFX_ALPHA_TEST_FLOOR,
  VFX_ALPHA_TEST_DISABLED,
  VFX_TONE_MAPPED_OFF,
  VFX_BAKE_NON_DT_LEGACY_ALPHA_TINT_FACTOR,
  VFX_TRANSPARENT_OVERDRAW_ALPHA_FLOOR,
  VFX_UV_EDGE_CLAMP_EPS,
  assertVfxRuntimeArtifactV3,
  deriveBlendState,
  deriveConstantUniforms,
} from './runtime-v3';
export {
  VFX_VERTEX_PATCH_IDS,
} from './runtime-v3';
export type {
  VfxRuntimeArtifactV3,
  VfxResourceRef,
  VfxResourceKind,
  VfxShaderModule,
  VfxPipelineState,
  VfxPipelineUniformValues,
  VfxPipelineBlendState,
  VfxBlendMode,
  VfxBatchClosure,
  VfxVertexPatchId,
} from './runtime-v3';
export { WEB_VFX_RUNTIME_V2_SCHEMA, isWebVfxRuntimeV2, assertWebVfxRuntimeV2 } from './runtime-v2';
export type {
  WebVfxRuntimeV2,
  RuntimeBlend,
  RuntimeResource,
  RuntimeMaterial,
  RuntimeProgram,
  RuntimeEmission,
  RuntimeSystem,
} from './runtime-v2';

export interface WebRuntimeArtifact {
  schema: typeof WEB_RUNTIME_ARTIFACT_SCHEMA;
  effectId: string;
  sourceSchema?: string;
  payload: Record<string, unknown>;
  resources?: Record<string, unknown>;
  materialVariants?: Record<string, unknown>;
  cfxrState?: Record<string, unknown>;
  runtimeConfig?: {
    startDelays?: Array<[string, number]>;
    controllers?: unknown[];
    cfxrEffect?: Record<string, unknown>;
  };
}

export type BlendMode =
  | 'opaque' | 'alpha-test' | 'alpha' | 'premultiplied-alpha' | 'additive' | 'multiply';

export interface MaterialProgramOperation {
  op?: string;
  source?: string;
  model?: string;
  [key: string]: unknown;
}

export interface MaterialProgramProfile {
  shaderFamily?: string;
  blendMode?: BlendMode;
  unityMode?: number;
  srcBlend?: number;
  dstBlend?: number;
  zWrite?: boolean;
  effectiveZWrite?: boolean;
  cutoff?: number;
  [key: string]: unknown;
}

export interface ParticleMaterialProgram {
  schema: typeof MATERIAL_PROGRAM_SCHEMA;
  blend: BlendMode;
  operations: readonly MaterialProgramOperation[];
  profile?: MaterialProgramProfile;
  [key: string]: unknown;
}

export const BLEND_MODES: readonly BlendMode[] = [
  'opaque', 'alpha-test', 'alpha', 'premultiplied-alpha', 'additive', 'multiply',
];

export function isBlendMode(value: unknown): value is BlendMode {
  return typeof value === 'string' && (BLEND_MODES as readonly string[]).includes(value);
}

export function isParticleMaterialProgram(value: unknown): value is ParticleMaterialProgram {
  if (!isObject(value)) return false;
  return value.schema === MATERIAL_PROGRAM_SCHEMA
    && isBlendMode(value.blend)
    && Array.isArray(value.operations);
}

export function isWebRuntimeArtifact(value: unknown): value is WebRuntimeArtifact {
  return isObject(value)
    && value.schema === WEB_RUNTIME_ARTIFACT_SCHEMA
    && typeof value.effectId === 'string'
    && isObject(value.payload);
}

/** Production artifacts must expose the deterministic legacy contract until the
 * compiler emits the vfx-artifact@1 envelope for every asset. */
export function isStrictArtifact(value: unknown): boolean {
  if (!isObject(value)) return false;
  const ir = value.vfxIR;
  return isObject(ir)
    && ir.schema === LEGACY_UNITY_IR_SCHEMA
    && ir.runtime === 'three-quarks-semantic@1'
    && ir.policy === 'strict';
}

export type ArtifactRepresentation = 'live-particles@1' | 'camera-baked@1';
export type ArtifactDisposition = 'production' | 'candidate' | 'rejected';

export interface ArtifactDiagnostic {
  severity: 'info' | 'warning' | 'error' | string;
  code: string;
  domain?: string;
  path: string;
  message: string;
  productionDisposition?: string;
  requiredAction?: string;
}

export interface VfxArtifactContract {
  schema: typeof VFX_ARTIFACT_SCHEMA;
  compiler: {
    name: string;
    version: string;
    unityVersion?: string;
  };
  effect: {
    id: string;
    duration?: number;
    looping?: boolean;
  };
  representation: ArtifactRepresentation;
  disposition: ArtifactDisposition;
  source?: {
    unityIrSchema?: typeof LEGACY_UNITY_IR_SCHEMA | string;
    sourceGraphHashes?: string[];
  };
  contract: {
    runtime: 'three-quarks-semantic@1' | string;
    policy: 'strict' | string;
    seed: number;
    fixedDelta: number;
    captureTimes: number[];
    lifecycle: Record<string, unknown>;
    referenceCamera: Record<string, unknown>;
  };
  diagnostics: ArtifactDiagnostic[];
}

/** The top-level field added by the new protocol. Resources remain sibling fields. */
export interface VfxArtifactEnvelope {
  artifact: VfxArtifactContract;
  [key: string]: unknown;
}

export interface LegacyUnityIrContract {
  schema: typeof LEGACY_UNITY_IR_SCHEMA;
  runtime: string;
  policy: string;
  effectId: string;
  seed: number;
  fixedDelta: number;
  referenceCamera: Record<string, unknown>;
  captureTimes: number[];
  lifecycle: Record<string, unknown>;
  diagnostics?: ArtifactDiagnostic[];
  representation?: ArtifactRepresentation;
  qualification?: Record<string, unknown>;
  editability?: Record<string, unknown>;
}

export type ArtifactReadResult =
  | { kind: 'artifact'; contract: VfxArtifactContract; source: VfxArtifactEnvelope }
  | { kind: 'legacy-unity-ir'; contract: LegacyUnityIrContract; source: Record<string, unknown> };

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reads both the new envelope and the current exported JSON during migration.
 * This function performs structural checks only; runtime-specific qualification
 * remains in the playback package.
 */
export function readVfxArtifact(raw: unknown): ArtifactReadResult {
  if (!isObject(raw)) throw new Error('VFX artifact must be a JSON object.');

  const artifact = raw.artifact;
  if (isObject(artifact) && artifact.schema === VFX_ARTIFACT_SCHEMA) {
    if (!isObject(artifact.compiler) || !isObject(artifact.effect) || !isObject(artifact.contract)) {
      throw new Error('vfx-artifact@1 requires compiler, effect, and contract objects.');
    }
    if (typeof artifact.effect.id !== 'string' || typeof artifact.compiler.version !== 'string') {
      throw new Error('vfx-artifact@1 has invalid compiler/effect identity.');
    }
    if (!['live-particles@1', 'camera-baked@1'].includes(String(artifact.representation))) {
      throw new Error(`Unsupported artifact representation '${String(artifact.representation)}'.`);
    }
    if (!['production', 'candidate', 'rejected'].includes(String(artifact.disposition))) {
      throw new Error(`Unsupported artifact disposition '${String(artifact.disposition)}'.`);
    }
    if (!hasFiniteNumber(artifact.contract.seed) || !hasFiniteNumber(artifact.contract.fixedDelta)
        || !Array.isArray(artifact.contract.captureTimes)) {
      throw new Error('vfx-artifact@1 has invalid deterministic playback fields.');
    }
    return { kind: 'artifact', contract: artifact as VfxArtifactContract, source: raw as VfxArtifactEnvelope };
  }

  const legacy = raw.vfxIR;
  if (isObject(legacy) && legacy.schema === LEGACY_UNITY_IR_SCHEMA) {
    if (typeof legacy.effectId !== 'string' || !hasFiniteNumber(legacy.seed)
        || !hasFiniteNumber(legacy.fixedDelta) || !Array.isArray(legacy.captureTimes)) {
      throw new Error('unity-vfx-ir@1 has invalid deterministic playback fields.');
    }
    return { kind: 'legacy-unity-ir', contract: legacy as LegacyUnityIrContract, source: raw };
  }

  throw new Error('Missing vfx-artifact@1 or legacy unity-vfx-ir@1 contract.');
}

/** Strict entry point for new consumers. Legacy support is explicit and observable. */
export function assertVfxArtifact(raw: unknown): ArtifactReadResult {
  return readVfxArtifact(raw);
}
