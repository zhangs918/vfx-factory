/**
 * Record the live Three.js material program after the thick path has finished
 * inject/bind. This is the capture half of offline stamp — not qualification.
 */
import {
  AdditiveBlending,
  CustomBlending,
  DoubleSide,
  DstColorFactor,
  NoBlending,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcColorFactor,
  ZeroFactor,
  type ShaderMaterial,
  type Texture,
} from 'three';
import type { BatchedRenderer } from 'three.quarks';
import type { VfxPipelineBlendState, VfxPipelineUniformValues } from '@vfx-factory/artifact-schema';
import { blendStateFromProfile } from './cfxr-blend-state';

export const LIVE_MATERIAL_CAPTURE_SCHEMA = 'vfx-live-material-capture@1' as const;

/**
 * Host-synced / RT-bound uniforms. Capturing them freezes the clock or camera
 * from the capture freeze time (e.g. effectTime=0.05) and breaks later freezes.
 */
export const CAPTURE_SKIP_HOST_UNIFORMS = new Set([
  'effectTime',
  'cameraNear',
  'cameraFar',
  'sceneColorSize',
]);

export function isCaptureHostUniform(name: string): boolean {
  return CAPTURE_SKIP_HOST_UNIFORMS.has(name);
}

export type LiveMaterialBatchStamp = {
  batchIndex: number;
  injectMode: string;
  artifactExecutor?: string;
  artifactShaderId?: string;
  artifactFamilyId?: string;
  closureIds: string[];
  fragmentShader: string;
  vertexShader: string;
  glslVersion?: string;
  defines: Record<string, string | number | boolean>;
  blendState: VfxPipelineBlendState;
  uniformValues: VfxPipelineUniformValues;
  /** Every live scalar/vector uniform after thick inject (capture factory ABI). */
  capturedUniforms: Record<string, number | number[] | number[][]>;
  tileCounts?: [number, number];
  textureSlots: Record<string, {
    uniform: string;
    uuid?: string;
    name?: string;
    imageWidth?: number;
    imageHeight?: number;
  }>;
  offlineOwned: string[];
};

export type LiveMaterialCapture = {
  schema: typeof LIVE_MATERIAL_CAPTURE_SCHEMA;
  effectId: string;
  label: string;
  capturedAt: string;
  source: 'thick-quarks@1';
  batches: LiveMaterialBatchStamp[];
};

function readNumber3(value: unknown, label: string): [number, number, number] {
  if (Array.isArray(value) && value.length >= 3
    && value.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return [value[0], value[1], value[2]];
  }
  if (value && typeof value === 'object' && 'isVector3' in (value as object)) {
    const v = value as { x: number; y: number; z: number };
    return [v.x, v.y, v.z];
  }
  if (value && typeof value === 'object' && 'isColor' in (value as object)) {
    const c = value as { r: number; g: number; b: number };
    return [c.r, c.g, c.b];
  }
  throw new Error(`live-material-stamp: ${label} required as vec3 (no invent)`);
}

function readUniformNumber(uniforms: Record<string, { value?: unknown }>, key: string): number | undefined {
  const raw = uniforms[key]?.value;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function readUniformValues(mat: ShaderMaterial): VfxPipelineUniformValues {
  const baked = mat.userData?.artifactUniformValues as VfxPipelineUniformValues | undefined;
  if (baked?.materialColor && typeof baked.opacityGain === 'number'
    && typeof baked.legacyAlphaTintFactor === 'number') {
    return { ...baked };
  }
  const uniforms = mat.uniforms as Record<string, { value?: unknown }>;
  const materialColor = readNumber3(uniforms.materialColor?.value, 'materialColor');
  const opacityGain = readUniformNumber(uniforms, 'opacityGain');
  if (opacityGain === undefined) {
    throw new Error('live-material-stamp: opacityGain uniform required (no invent)');
  }
  const legacyAlphaTintFactor = readUniformNumber(uniforms, 'legacyAlphaTintFactor');
  if (legacyAlphaTintFactor === undefined) {
    throw new Error('live-material-stamp: legacyAlphaTintFactor uniform required (no invent)');
  }
  const values: VfxPipelineUniformValues = {
    materialColor,
    opacityGain,
    legacyAlphaTintFactor,
  };
  const hdrMultiply = readUniformNumber(uniforms, 'hdrMultiply');
  if (hdrMultiply !== undefined) values.hdrMultiply = hdrMultiply;
  const vertColorGain = readUniformNumber(uniforms, 'vertColorGain');
  if (vertColorGain !== undefined) values.vertColorGain = vertColorGain;
  return values;
}

function inferBlendPath(mat: ShaderMaterial): VfxPipelineBlendState['path'] {
  if (mat.blending === CustomBlending) {
    if (mat.blendSrc === ZeroFactor && mat.blendDst === SrcColorFactor) return 'legacy-multiply';
    if (mat.blendSrc === OneFactor && mat.blendDst === OneMinusSrcAlphaFactor) return 'legacy-premultiply';
    if (mat.blendSrc === DstColorFactor && mat.blendDst === ZeroFactor) return 'legacy-multiply-colored';
  }
  return 'semantic';
}

function readBlendState(mat: ShaderMaterial): VfxPipelineBlendState {
  const baked = mat.userData?.artifactBlendState as VfxPipelineBlendState | undefined;
  if (baked?.path && baked.blending !== undefined) return { ...baked, toneMapped: false };

  const profile = mat.userData?.cfxr;
  if (profile) {
    try {
      return blendStateFromProfile(profile);
    } catch {
      // Fall through to live Three material fields.
    }
  }

  const path = inferBlendPath(mat);
  let blending: VfxPipelineBlendState['blending'] = 'normal';
  if (mat.blending === NoBlending) blending = 'no';
  else if (mat.blending === AdditiveBlending) blending = 'additive';
  else if (mat.blending === NormalBlending) blending = 'normal';
  else if (path === 'semantic') blending = 'normal';

  return {
    path,
    blending,
    premultipliedAlpha: !!mat.premultipliedAlpha,
    depthWrite: !!mat.depthWrite,
    transparent: !!mat.transparent,
    alphaTest: typeof mat.alphaTest === 'number' ? mat.alphaTest : 0,
    side: mat.side === DoubleSide ? 'double' : 'front',
    toneMapped: false,
  };
}

function readTileCounts(mat: ShaderMaterial): [number, number] | undefined {
  const offline = mat.userData?.artifactTileCounts as [number, number] | undefined;
  if (Array.isArray(offline) && offline.length === 2
    && offline.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return [offline[0], offline[1]];
  }
  const profileTiles = mat.userData?.cfxr?.tileCounts;
  if (Array.isArray(profileTiles) && profileTiles.length === 2) {
    return [Number(profileTiles[0]), Number(profileTiles[1])];
  }
  const uniform = mat.uniforms?.tileCounts?.value as { x?: number; y?: number } | number[] | undefined;
  if (Array.isArray(uniform) && uniform.length >= 2) {
    return [Number(uniform[0]), Number(uniform[1])];
  }
  if (uniform && !Array.isArray(uniform) && typeof uniform.x === 'number' && typeof uniform.y === 'number') {
    return [uniform.x, uniform.y];
  }
  return undefined;
}

function readCapturedUniforms(mat: ShaderMaterial): Record<string, number | number[] | number[][]> {
  const out: Record<string, number | number[] | number[][]> = {};
  for (const [name, entry] of Object.entries(mat.uniforms ?? {})) {
    if (isCaptureHostUniform(name)) continue;
    const value = (entry as { value?: unknown })?.value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[name] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      out[name] = [...value];
      continue;
    }
    // ambientSH etc.: array of Vector3
    if (Array.isArray(value)
      && value.length > 0
      && value.every((item) => item && typeof item === 'object'
        && 'isVector3' in item
        && typeof (item as { x?: unknown }).x === 'number'
        && typeof (item as { y?: unknown }).y === 'number'
        && typeof (item as { z?: unknown }).z === 'number')) {
      out[name] = value.map((item) => {
        const v = item as { x: number; y: number; z: number };
        return [v.x, v.y, v.z];
      });
      continue;
    }
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if ('isVector2' in v && typeof v.x === 'number' && typeof v.y === 'number') {
        out[name] = [v.x, v.y];
      } else if ('isVector3' in v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') {
        out[name] = [v.x, v.y, v.z];
      } else if ('isVector4' in v
        && typeof v.x === 'number' && typeof v.y === 'number'
        && typeof v.z === 'number' && typeof v.w === 'number') {
        out[name] = [v.x, v.y, v.z, v.w];
      } else if ('isColor' in v && typeof v.r === 'number' && typeof v.g === 'number' && typeof v.b === 'number') {
        out[name] = [v.r, v.g, v.b];
      }
    }
  }
  return out;
}

function readTextureSlots(mat: ShaderMaterial): LiveMaterialBatchStamp['textureSlots'] {
  const slots: LiveMaterialBatchStamp['textureSlots'] = {};
  const uniforms = mat.uniforms ?? {};
  for (const [name, entry] of Object.entries(uniforms)) {
    const value = (entry as { value?: unknown })?.value as Texture | null | undefined;
    if (!value || typeof value !== 'object' || !('isTexture' in value) || !(value as Texture).isTexture) {
      continue;
    }
    const image = value.image as { width?: number; height?: number } | undefined;
    slots[name] = {
      uniform: name,
      uuid: value.uuid,
      name: value.name || undefined,
      imageWidth: typeof image?.width === 'number' ? image.width : undefined,
      imageHeight: typeof image?.height === 'number' ? image.height : undefined,
    };
  }
  return slots;
}

function readDefines(mat: ShaderMaterial): Record<string, string | number | boolean> {
  const raw = mat.defines ?? {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/** Dump every live batch material after thick-path inject/bind. */
export function dumpLiveMaterialCapture(input: {
  effectId: string;
  label: string;
  batchRenderer: BatchedRenderer;
}): LiveMaterialCapture {
  const batches: LiveMaterialBatchStamp[] = [];
  for (let batchIndex = 0; batchIndex < input.batchRenderer.batches.length; batchIndex++) {
    const batch = input.batchRenderer.batches[batchIndex];
    const mat = batch.material as ShaderMaterial;
    if (!mat?.isShaderMaterial) {
      throw new Error(`live-material-stamp: batch ${batchIndex} is not a ShaderMaterial`);
    }
    if (typeof mat.fragmentShader !== 'string' || !mat.fragmentShader.trim()) {
      throw new Error(`live-material-stamp: batch ${batchIndex} missing fragmentShader`);
    }
    if (typeof mat.vertexShader !== 'string' || !mat.vertexShader.trim()) {
      throw new Error(`live-material-stamp: batch ${batchIndex} missing vertexShader`);
    }

    const closureIds = [...new Set(
      Array.from(batch.systems)
        .map((system) => (system as { __artifactBatchClosureId?: string }).__artifactBatchClosureId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )].sort();

    const settingsMat = batch.settings?.material as ShaderMaterial | undefined;
    const metaMat = settingsMat ?? mat;
    batches.push({
      batchIndex,
      injectMode: String(mat.userData?.cfxrInjectMode ?? metaMat.userData?.cfxrInjectMode ?? 'unknown'),
      artifactExecutor: metaMat.userData?.artifactExecutor,
      artifactShaderId: metaMat.userData?.artifactShaderId,
      artifactFamilyId: metaMat.userData?.artifactFamilyId,
      closureIds,
      fragmentShader: mat.fragmentShader,
      vertexShader: mat.vertexShader,
      glslVersion: mat.glslVersion ? String(mat.glslVersion) : undefined,
      defines: readDefines(mat),
      blendState: readBlendState(mat),
      uniformValues: readUniformValues(mat),
      capturedUniforms: readCapturedUniforms(mat),
      tileCounts: readTileCounts(mat),
      textureSlots: readTextureSlots(mat),
      offlineOwned: [...(mat.userData?.offlineOwned ?? metaMat.userData?.offlineOwned ?? [])].map(String).sort(),
    });
  }

  return {
    schema: LIVE_MATERIAL_CAPTURE_SCHEMA,
    effectId: input.effectId,
    label: input.label,
    capturedAt: new Date().toISOString(),
    source: 'thick-quarks@1',
    batches,
  };
}
