/**
 * Production slim inject for artifact-shader@1 batches: blend + constant uniforms
 * + vertex patches only (offline fragment already bound). Thin player never uses this.
 */
import { Vector2, type ShaderMaterial } from 'three';
import {
  applyBakedBlendState,
  assertSameBlendState,
  blendStateFromProfile,
  type VfxPipelineBlendState,
} from './cfxr-blend-state';
import {
  applyConstantUniforms,
  assertSameConstantUniforms,
  constantUniformsFromProfile,
  type VfxPipelineUniformValues,
} from './cfxr-constant-uniforms';
import type { CfxrRuntimeProfile } from './cfxr-material-profile';
import type { MountPolicy } from './cfxr-mount-policy';
import { applyCfxrDualPathVertexPatches } from './cfxr-dual-path-vertex';

export type CfxrSlimInjectOptions = {
  /** Dual-path snapshot from after-batch (no URL reads in this module). */
  policy: MountPolicy;
  declaredVertexPatches?: string[];
  declaredBlendState?: VfxPipelineBlendState;
  declaredUniformValues?: VfxPipelineUniformValues;
  /** Offline pipeline/material tileCounts when emitters agree. */
  declaredTileCounts?: [number, number];
  /** Live-bridge capture stamps — skip profile dual-path asserts. */
  captureOwned?: boolean;
};

export function applyArtifactSlimInject(
  mat: ShaderMaterial,
  profile: CfxrRuntimeProfile,
  options: CfxrSlimInjectOptions,
): void {
  // Qualified artifact-shader path: offline fragment is already bound.
  // Own blend + constant uniforms + vertex patches via dual-path authority.
  // Do not install CFXR_* defines, CFXR sampler uniforms, or the ubershader body.
  const defines: Record<string, string> = { ...((mat.defines ?? {}) as Record<string, string>) };
  delete defines.USE_COLOR_AS_ALPHA;
  delete defines.USE_ALPHATEST;
  for (const key of Object.keys(defines)) {
    if (key.startsWith('CFXR_')) delete defines[key];
  }
  mat.defines = defines;
  // Do not force GLSL3 here. Quarks stock fragments still use gl_FragColor;
  // bindCompiledShaders sets GLSL3 only when the offline quarks-fragment-v1
  // body is actually written. Forcing GLSL3 before that bind breaks mixed
  // batches / provisional qualifies mid-flight.

  const offlineOwned: string[] = ['fragment'];
  const preferArtifactUniforms = options.policy.uniform === 'artifact';
  const preferArtifactBlend = options.policy.blend === 'artifact';
  const preferArtifactVertex = options.policy.vertex === 'artifact';
  const preferArtifact = preferArtifactUniforms || preferArtifactBlend || preferArtifactVertex;

  const declaredUniforms = options.declaredUniformValues;
  const captureOwned = !!options.captureOwned;
  if (preferArtifactUniforms) {
    if (!declaredUniforms) {
      throw new Error('slim-inject: uniformSource=artifact requires declaredUniformValues');
    }
    // Live-bridge captures already equal the thick path; do not re-assert against
    // profile soft invent (e.g. non-DT legacyAlphaTintFactor bake 0 vs invent 2).
    if (!captureOwned) {
      assertSameConstantUniforms(
        'slim-inject',
        declaredUniforms,
        constantUniformsFromProfile(profile),
      );
    }
    applyConstantUniforms(mat, declaredUniforms);
    offlineOwned.push('uniforms');
  } else {
    applyConstantUniforms(mat, constantUniformsFromProfile(profile));
  }

  const tiles = preferArtifact
    ? options.declaredTileCounts
    : (options.declaredTileCounts ?? profile.tileCounts);
  if (!tiles) {
    throw new Error(
      preferArtifact
        ? 'slim-inject: artifact path requires declaredTileCounts'
        : 'slim-inject: missing offline tileCounts (declared or profile)',
    );
  }
  mat.uniforms.tileCounts = {
    value: new Vector2(Number(tiles[0]), Number(tiles[1])),
  };

  const declaredBlend = options.declaredBlendState;
  if (preferArtifactBlend) {
    if (!declaredBlend) {
      throw new Error('slim-inject: blendSource=artifact requires declaredBlendState');
    }
    // Shared Quarks batch live-bridge stamps can disagree with per-emitter
    // propsToProfile paths; captured blend is authoritative when captureOwned.
    if (!captureOwned) {
      assertSameBlendState('slim-inject', declaredBlend, blendStateFromProfile(profile));
    }
    applyBakedBlendState(mat, declaredBlend);
    offlineOwned.push('blend');
  } else {
    const bridgeBlend = blendStateFromProfile(profile);
    if (declaredBlend && !captureOwned) {
      assertSameBlendState('slim-inject', declaredBlend, bridgeBlend);
    }
    applyBakedBlendState(mat, bridgeBlend);
  }

  if (preferArtifactVertex) {
    if (!options.declaredVertexPatches) {
      throw new Error('slim-inject: vertexSource=artifact requires declaredVertexPatches');
    }
  }
  const vertex = applyCfxrDualPathVertexPatches(
    mat.vertexShader,
    profile,
    options.declaredVertexPatches,
    preferArtifactVertex,
    { skipDivergenceAssert: captureOwned },
  );
  mat.vertexShader = vertex.vertexShader;
  if (vertex.usedArtifactPatches) offlineOwned.push('vertex');

  const userData = mat.userData as {
    cfxrInjectMode?: string;
    offlineOwned?: string[];
  };
  userData.cfxrInjectMode = 'artifact-slim';
  userData.offlineOwned = offlineOwned.sort();
  mat.needsUpdate = true;
}
