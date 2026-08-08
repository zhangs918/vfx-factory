import {
  AdditiveBlending,
  CustomBlending,
  DoubleSide,
  MultiplyBlending,
  NoBlending,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Texture,
  ZeroFactor,
} from 'three';
import type { RuntimeMaterial, RuntimeResource } from '@vfx-factory/artifact-schema';
import { VFX_TONE_MAPPED_OFF } from '@vfx-factory/artifact-schema';

export interface RuntimeTextureResolver {
  resolve(resource: RuntimeResource): Texture | null;
}

/** Creates a material from compiled shader/render state only. No Unity or CFXR data is accepted. */
export function createRuntimeMaterial(
  spec: RuntimeMaterial,
  resources: Map<string, RuntimeResource>,
  textures: RuntimeTextureResolver,
): ShaderMaterial {
  const uniforms: Record<string, { value: unknown }> = {};
  for (const [name, value] of Object.entries(spec.uniforms ?? {})) uniforms[name] = { value };
  for (const [name, resourceId] of Object.entries(spec.textures ?? {})) {
    const resource = resources.get(resourceId);
    if (!resource || resource.kind !== 'texture') throw new Error(`Missing runtime texture '${resourceId}'.`);
    uniforms[name] = { value: textures.resolve(resource) };
  }
  const material = new ShaderMaterial({
    vertexShader: spec.vertexShader,
    fragmentShader: spec.fragmentShader,
    uniforms,
    transparent: spec.renderState.blend !== 'opaque',
    depthTest: spec.renderState.depthTest,
    depthWrite: spec.renderState.depthWrite,
    toneMapped: spec.renderState.toneMapped ?? VFX_TONE_MAPPED_OFF,
    side: spec.renderState.cull === 'none' ? DoubleSide : spec.renderState.cull === 'front' ? 1 : 0,
  });
  material.blending = spec.renderState.blend === 'additive'
    ? AdditiveBlending
    : spec.renderState.blend === 'multiply'
      ? MultiplyBlending
      : spec.renderState.blend === 'opaque'
        ? NoBlending
        : NormalBlending;
  if (spec.renderState.blend === 'premultiplied') {
    material.blending = CustomBlending;
    material.blendSrc = OneFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
    material.premultipliedAlpha = true;
  }
  if (spec.renderState.alphaTest != null) material.alphaTest = spec.renderState.alphaTest;
  return material;
}
