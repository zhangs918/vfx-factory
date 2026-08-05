/** Runtime entrypoint for Node validators and non-TypeScript compiler tools. */
export const VFX_ARTIFACT_SCHEMA = 'vfx-artifact@1';
export const LEGACY_UNITY_IR_SCHEMA = 'unity-vfx-ir@1';
export const MATERIAL_PROGRAM_SCHEMA = 'particle-material-program@2';
export const WEB_RUNTIME_ARTIFACT_SCHEMA = 'web-vfx-runtime@1';

export const BLEND_MODES = Object.freeze([
  'opaque', 'alpha-test', 'alpha', 'premultiplied-alpha', 'additive', 'multiply',
]);

export function isBlendMode(value) {
  return typeof value === 'string' && BLEND_MODES.includes(value);
}

export function isParticleMaterialProgram(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && value.schema === MATERIAL_PROGRAM_SCHEMA
    && isBlendMode(value.blend)
    && Array.isArray(value.operations);
}

export function isWebRuntimeArtifact(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && value.schema === WEB_RUNTIME_ARTIFACT_SCHEMA
    && typeof value.effectId === 'string'
    && !!value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload);
}

export function isStrictArtifact(value) {
  const ir = value && typeof value === 'object' && !Array.isArray(value) ? value.vfxIR : null;
  return !!ir && typeof ir === 'object' && !Array.isArray(ir)
    && ir.schema === LEGACY_UNITY_IR_SCHEMA
    && ir.runtime === 'three-quarks-semantic@1'
    && ir.policy === 'strict';
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const hasFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Runtime counterpart of the typed reader. It intentionally accepts the legacy
 * unity-vfx-ir@1 payload while migration is in progress. */
export function readVfxArtifact(raw) {
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
    if (!hasFiniteNumber(artifact.contract.seed)
        || !hasFiniteNumber(artifact.contract.fixedDelta)
        || !Array.isArray(artifact.contract.captureTimes)) {
      throw new Error('vfx-artifact@1 has invalid deterministic playback fields.');
    }
    return { kind: 'artifact', contract: artifact, source: raw };
  }

  const legacy = raw.vfxIR;
  if (isObject(legacy) && legacy.schema === LEGACY_UNITY_IR_SCHEMA) {
    if (typeof legacy.effectId !== 'string' || !hasFiniteNumber(legacy.seed)
        || !hasFiniteNumber(legacy.fixedDelta) || !Array.isArray(legacy.captureTimes)) {
      throw new Error('unity-vfx-ir@1 has invalid deterministic playback fields.');
    }
    return { kind: 'legacy-unity-ir', contract: legacy, source: raw };
  }
  throw new Error('Missing vfx-artifact@1 or legacy unity-vfx-ir@1 contract.');
}

export const assertVfxArtifact = readVfxArtifact;
