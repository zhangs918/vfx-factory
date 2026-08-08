export const VFX_RUNTIME_ARTIFACT_V3 = 'vfx-runtime-artifact@3';
export const VFX_ALPHA_TEST_FLOOR = 0.001;
export const VFX_ALPHA_TEST_DISABLED = 0;
export const VFX_TONE_MAPPED_OFF = false;
export const VFX_BAKE_NON_DT_LEGACY_ALPHA_TINT_FACTOR = 2;
export const VFX_TRANSPARENT_OVERDRAW_ALPHA_FLOOR = 0.02;
export const VFX_UV_EDGE_CLAMP_EPS = 1e-7;
export const VFX_VERTEX_PATCH_IDS = Object.freeze([
  'cfxr-custom-attrs@1',
  'unity-centered-stretch@1',
  'unity-vertical-billboard@1',
]);

const SHA256 = /^[a-f0-9]{64}$/;
const RESOURCE_KINDS = new Set(['texture', 'geometry', 'lut', 'binary']);
const BLENDS = new Set(['opaque', 'alpha-test', 'alpha', 'premultiplied-alpha', 'additive', 'multiply']);
const QUALIFICATION = new Set(['bridge', 'capture-stamped', 'pixel-qualified']);

export function deriveConstantUniforms(input) {
  const values = {
    materialColor: input.materialColor.map(Number),
    opacityGain: Math.max(0, Number(input.opacityGain)),
    legacyAlphaTintFactor: Math.max(0, Number(input.legacyAlphaTintFactor)),
  };
  if (input.hdrMultiply !== undefined) values.hdrMultiply = Math.max(0, Number(input.hdrMultiply));
  if (input.vertColorGain !== undefined) values.vertColorGain = Math.max(0, Number(input.vertColorGain));
  if (input.vertColorRgbOn !== undefined) values.vertColorRgbOn = Number(input.vertColorRgbOn);
  if (input.vertColorAlphaOn !== undefined) values.vertColorAlphaOn = Number(input.vertColorAlphaOn);
  if (input.texPower !== undefined) values.texPower = Math.max(0.01, Number(input.texPower));
  if (input.colorPower !== undefined) values.colorPower = Math.max(0.01, Number(input.colorPower));
  return values;
}

export function deriveBlendState(input) {
  let path = 'semantic';
  let blending = 'normal';
  let premultipliedAlpha = false;
  if (input.legacyMultiply) path = 'legacy-multiply';
  else if (input.legacyPremultiply) path = 'legacy-premultiply';
  else if (input.legacyMultiplyColored) path = 'legacy-multiply-colored';
  else if (input.blendMode === 'opaque' || input.blendMode === 'alpha-test') blending = 'no';
  else if (input.blendMode === 'additive' || input.additive) blending = 'additive';
  else premultipliedAlpha = input.blendMode === 'premultiplied-alpha';
  return {
    path,
    blending,
    premultipliedAlpha,
    depthWrite: !!input.depthWrite,
    transparent: input.blendMode !== 'opaque' && input.blendMode !== 'alpha-test',
    alphaTest: input.blendMode === 'alpha-test'
      ? Math.max(VFX_ALPHA_TEST_FLOOR, Number(input.cutoff) || VFX_ALPHA_TEST_DISABLED)
      : VFX_ALPHA_TEST_DISABLED,
    side: input.doubleSided ? 'double' : 'front',
    toneMapped: false,
  };
}

function assertSha(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function isSafeAssetUri(value, prefix) {
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

function assertQualification(value, label, executor) {
  if (!value || value.baseline !== 'frozen-semantic@1' || !QUALIFICATION.has(value.status)) {
    throw new Error(`${label} has invalid qualification`);
  }
  if (executor === 'artifact-shader@1' && value.status === 'bridge') throw new Error(`${label} artifact shader remains bridge`);
  if (executor === 'semantic-bridge@1' && value.status !== 'bridge') throw new Error(`${label} semantic bridge has non-bridge proof`);
  if (value.status === 'capture-stamped' && value.evidence?.captureProvenance !== 'live-bridge-capture@1') {
    throw new Error(`${label} capture stamp lacks provenance`);
  }
  if (value.status === 'pixel-qualified') {
    const evidence = value.evidence;
    if (!evidence || typeof evidence.compilerVersion !== 'string' || !evidence.compilerVersion
      || !Array.isArray(evidence.captureTimes) || !evidence.captureTimes.length
      || evidence.captureTimes.some((time) => !Number.isFinite(time))
      || evidence.changedPixels !== 0 || evidence.maxChannelDelta !== 0) {
      throw new Error(`${label} pixel proof is incomplete`);
    }
  }
}

export function assertVfxRuntimeArtifactV3(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('vfx-runtime-artifact@3 must be an object');
  const artifact = value;
  if (artifact.schema !== VFX_RUNTIME_ARTIFACT_V3) throw new Error('Unsupported runtime artifact schema');
  if (!artifact.effectId || typeof artifact.effectId !== 'string') throw new Error('Artifact effectId is required');
  if (!artifact.compiler || typeof artifact.compiler.name !== 'string' || !artifact.compiler.name
    || typeof artifact.compiler.version !== 'string' || !artifact.compiler.version) throw new Error('Artifact compiler identity is required');
  if ((!artifact.simulation || typeof artifact.simulation !== 'object') && !artifact.files?.config) throw new Error('Artifact simulation or external config is required');
  if (!artifact.pipelines || typeof artifact.pipelines !== 'object') throw new Error('Artifact pipelines are required');
  if ((!artifact.shaders || typeof artifact.shaders !== 'object') && !artifact.files?.shaders) throw new Error('Artifact shaders or external shader files are required');
  if (!artifact.resources || typeof artifact.resources !== 'object') throw new Error('Artifact resources are required');
  if (artifact.execution?.material !== 'per-pipeline@1'
    || !['semantic-bridge@1', 'quarks-native@1', 'artifact-emitter-sim@1'].includes(artifact.execution?.simulation)
    || !['semantic-bridge@1', 'artifact-trajectory@1'].includes(artifact.execution?.trajectory)) throw new Error('Artifact execution ownership is invalid');
  if (!artifact.metadata || !Number.isFinite(artifact.metadata.seed)
    || !Number.isFinite(artifact.metadata.fixedDelta) || artifact.metadata.fixedDelta <= 0) throw new Error('Artifact deterministic metadata is invalid');
  if ((!artifact.runtimeState || typeof artifact.runtimeState !== 'object') && !artifact.files?.config) throw new Error('Artifact runtimeState or external config is required');
  if (artifact.runtimeState && (!artifact.runtimeState.cfxrState || typeof artifact.runtimeState.cfxrState !== 'object'
    || !artifact.runtimeState.runtimeConfig || typeof artifact.runtimeState.runtimeConfig !== 'object')) throw new Error('Artifact runtimeState is incomplete');

  for (const [id, resource] of Object.entries(artifact.resources)) {
    if (!resource || resource.id !== id || !RESOURCE_KINDS.has(resource.kind)
      || !isSafeAssetUri(resource.uri, '/assets/v3-resources/')) throw new Error(`Resource '${id}' is invalid`);
    assertSha(resource.sha256, `Resource '${id}' sha256`);
    if (resource.bytes !== undefined && (!Number.isInteger(resource.bytes) || resource.bytes < 0)) throw new Error(`Resource '${id}' bytes is invalid`);
  }
  for (const [id, pipeline] of Object.entries(artifact.pipelines)) {
    if (typeof pipeline.materialId !== 'string' || !pipeline.materialId) {
      throw new Error(`Pipeline '${id}' is missing its source material binding`);
    }
    if (!pipeline || !BLENDS.has(pipeline.blend) || !Number.isFinite(pipeline.srcBlend)
      || !Number.isFinite(pipeline.dstBlend) || typeof pipeline.zWrite !== 'boolean'
      || typeof pipeline.shader !== 'string' || !['semantic-bridge@1', 'artifact-shader@1'].includes(pipeline.executor)) throw new Error(`Pipeline '${id}' is invalid`);
    assertQualification(pipeline.qualification, `Pipeline '${id}'`, pipeline.executor);
    for (const key of ['hdrMultiply', 'vertColorGain', 'vertColorRgbOn', 'vertColorAlphaOn', 'texPower', 'colorPower']) {
      if (pipeline.uniformValues?.[key] !== undefined && !Number.isFinite(pipeline.uniformValues[key])) {
        throw new Error(`Pipeline '${id}' ${key} is invalid`);
      }
    }
    if (!artifact.shaders?.[pipeline.shader] && !artifact.files?.shaders?.[pipeline.shader]) throw new Error(`Pipeline '${id}' references missing shader`);
    for (const resourceId of Object.values(pipeline.textures ?? {})) if (!artifact.resources[resourceId]) throw new Error(`Pipeline '${id}' references missing resource`);
  }
  for (const [id, shader] of Object.entries(artifact.shaders ?? {})) {
    if (!shader || shader.id !== id || typeof shader.vertex !== 'string' || !shader.vertex.includes('void main')
      || typeof shader.fragment !== 'string' || !shader.fragment.includes('void main')
      || !shader.uniforms || typeof shader.uniforms !== 'object') throw new Error(`Shader '${id}' is invalid`);
  }
  for (const [id, closure] of Object.entries(artifact.batchClosures ?? {})) {
    if (!closure || closure.id !== id || !Array.isArray(closure.emitterIds) || !closure.emitterIds.length
      || !Array.isArray(closure.pipelineIds) || !closure.pipelineIds.length || typeof closure.renderSignature !== 'string') throw new Error(`Batch closure '${id}' is invalid`);
    assertQualification(closure.qualification, `Batch closure '${id}'`);
    if (closure.vertexPatches?.some((patch) => !VFX_VERTEX_PATCH_IDS.includes(patch))) throw new Error(`Batch closure '${id}' has unknown vertex patch`);
    for (const pipelineId of closure.pipelineIds) if (!artifact.pipelines[pipelineId]) throw new Error(`Batch closure '${id}' references missing pipeline`);
  }
  if (artifact.files) {
    if (!isSafeAssetUri(artifact.files.config?.uri, '/assets/v3-code/') || !artifact.files.shaders) throw new Error('Artifact files split is incomplete');
    assertSha(artifact.files.config.sha256, 'Artifact config sha256');
    for (const [id, shader] of Object.entries(artifact.files.shaders)) {
      if (!shader || shader.id !== id || !isSafeAssetUri(shader.vertex?.uri, '/assets/v3-code/')
        || !isSafeAssetUri(shader.fragment?.uri, '/assets/v3-code/') || !shader.uniforms || typeof shader.uniforms !== 'object') throw new Error(`Artifact split shader '${id}' is incomplete`);
      assertSha(shader.vertex.sha256, `Artifact split shader '${id}' vertex sha256`);
      assertSha(shader.fragment.sha256, `Artifact split shader '${id}' fragment sha256`);
    }
  }
}
