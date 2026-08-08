import * as runtime from '../packages/vfx-artifact-schema/runtime-v3.mjs';
import * as source from '../packages/vfx-artifact-schema/src/runtime-v3.ts';

const input = {
  blendMode: 'premultiplied-alpha' as const,
  depthWrite: false,
  cutoff: 0,
  doubleSided: true,
};
const uniformInput = {
  materialColor: [0.25, 0.5, 1] as [number, number, number],
  opacityGain: 2,
  legacyAlphaTintFactor: 0.5,
  hdrMultiply: 3,
};
const artifact = {
  schema: 'vfx-runtime-artifact@3',
  effectId: 'schema-parity',
  compiler: { name: 'parity-check', version: '1' },
  simulation: {},
  pipelines: {
    material: {
      materialId: 'material',
      blend: 'alpha', srcBlend: 1, dstBlend: 1, zWrite: false,
      shader: 'shader', textures: {}, executor: 'semantic-bridge@1',
      qualification: { status: 'bridge', familyId: 'family', baseline: 'frozen-semantic@1' },
    },
  },
  shaders: {
    shader: { id: 'shader', vertex: 'void main() {}', fragment: 'void main() {}', uniforms: {} },
  },
  resources: {},
  metadata: { seed: 1, fixedDelta: 1 / 60 },
  execution: { material: 'per-pipeline@1', simulation: 'semantic-bridge@1', trajectory: 'semantic-bridge@1' },
  runtimeState: { cfxrState: {}, runtimeConfig: {} },
};

const equal = (left: unknown, right: unknown, label: string) => {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`${label} drifted between TS and Node runtime`);
};
equal(runtime.VFX_VERTEX_PATCH_IDS, source.VFX_VERTEX_PATCH_IDS, 'vertex patch ids');
equal(runtime.deriveBlendState(input), source.deriveBlendState(input), 'blend derivation');
equal(runtime.deriveConstantUniforms(uniformInput), source.deriveConstantUniforms(uniformInput), 'uniform derivation');
runtime.assertVfxRuntimeArtifactV3(artifact);
source.assertVfxRuntimeArtifactV3(artifact);
const invalid = structuredClone(artifact);
invalid.compiler.name = '';
for (const [name, validator] of [
  ['Node', runtime.assertVfxRuntimeArtifactV3],
  ['TypeScript', source.assertVfxRuntimeArtifactV3],
] as const) {
  let rejected = false;
  try { validator(invalid); } catch { rejected = true; }
  if (!rejected) throw new Error(`${name} schema validator accepted invalid compiler identity`);
}
console.log('runtime-v3 schema TS/Node parity passed');
