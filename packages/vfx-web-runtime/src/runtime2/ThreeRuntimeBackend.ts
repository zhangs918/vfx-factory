import { DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, PlaneGeometry, TextureLoader, type Object3D, type ShaderMaterial } from 'three';
import type { WebVfxRuntimeV2, RuntimeResource } from '@vfx-factory/artifact-schema';
import { createRuntimeMaterial } from './RuntimeMaterialFactory';
import { createRuntimeSystemState, updateRuntimeSystem, type RuntimeParticleSystemState } from './RuntimeProgramExecutor';
import type { RuntimeBackend, RuntimeHandle } from './RuntimeBackend';

export interface ThreeRuntimeContext { parent?: Object3D; resourceBaseUrl?: string; }
type RenderRecord = { state: RuntimeParticleSystemState; mesh: InstancedMesh<PlaneGeometry, ShaderMaterial>; position: InstancedBufferAttribute; size: InstancedBufferAttribute; color: InstancedBufferAttribute };
function resolveUri(uri: string, base = ''): string { if (/^(https?:|data:|blob:|\/)/.test(uri)) return uri; return `${base.replace(/\/$/, '')}/${uri.replace(/^\//, '')}`; }

/** Basic runtime@2 backend: compiled billboard systems + instanced buffers. */
export class ThreeRuntimeBackend implements RuntimeBackend<ThreeRuntimeContext> {
  async instantiate(artifact: WebVfxRuntimeV2, context: ThreeRuntimeContext): Promise<RuntimeHandle> {
    const root = new Group();
    const resources = new Map(artifact.resources.map((resource) => [resource.id, resource]));
    const textureCache = new Map<string, any>();
    const textureResolver = { resolve: (resource: RuntimeResource) => {
      const uri = resolveUri(resource.uri, context.resourceBaseUrl);
      if (!textureCache.has(uri)) textureCache.set(uri, new TextureLoader().load(uri));
      return textureCache.get(uri);
    }};
    const materials = new Map(artifact.materials.map((spec) => [spec.id, createRuntimeMaterial(spec, resources, textureResolver)]));
    const programs = new Map(artifact.programs.map((program) => [program.id, program]));
    const records: RenderRecord[] = [];
    for (const system of artifact.systems) {
      if (system.renderMode !== 'billboard' && system.renderMode !== 'stretched-billboard') throw new Error(`Runtime v2 system '${system.id}' render mode '${system.renderMode}' is not supported by the basic Three backend.`);
      const material = materials.get(system.material);
      if (!material) throw new Error(`Runtime v2 system '${system.id}' references missing material '${system.material}'.`);
      const systemMaterial = material.clone();
      systemMaterial.uniforms.uTileColumns = { value: system.flipbook?.columns ?? 1 };
      systemMaterial.uniforms.uTileRows = { value: system.flipbook?.rows ?? 1 };
      const mesh = new InstancedMesh(new PlaneGeometry(1, 1), systemMaterial, system.capacity);
      const position = new InstancedBufferAttribute(new Float32Array(system.capacity * 3), 3).setUsage(DynamicDrawUsage);
      const size = new InstancedBufferAttribute(new Float32Array(system.capacity * 3), 3).setUsage(DynamicDrawUsage);
      const color = new InstancedBufferAttribute(new Float32Array(system.capacity * 4), 4).setUsage(DynamicDrawUsage);
      const frame = new InstancedBufferAttribute(new Float32Array(system.capacity), 1).setUsage(DynamicDrawUsage);
      mesh.geometry.setAttribute('instancePosition', position); mesh.geometry.setAttribute('instanceSize', size); mesh.geometry.setAttribute('instanceColor', color); mesh.geometry.setAttribute('instanceFrame', frame); mesh.count = 0;
      root.add(mesh); records.push({ state: createRuntimeSystemState(system), mesh, position, size, color });
    }
    context.parent?.add(root);
    const updateBuffers = () => { for (const record of records) { let count = 0; for (const particle of record.state.particles) { if (!particle.alive) continue; record.position.setXYZ(count, ...particle.position); record.size.setXYZ(count, ...particle.size); record.color.setXYZW(count, ...particle.color); (record.mesh.geometry.getAttribute('instanceFrame') as InstancedBufferAttribute).setX(count, particle.frame); count++; } record.mesh.count = count; record.position.needsUpdate = true; record.size.needsUpdate = true; record.color.needsUpdate = true; (record.mesh.geometry.getAttribute('instanceFrame') as InstancedBufferAttribute).needsUpdate = true; } };
    return { root, update: (dt) => { records.forEach((record) => updateRuntimeSystem(record.state, programs, dt)); updateBuffers(); }, restart: () => { records.forEach((record) => { record.state.elapsed = 0; record.state.particles.length = 0; }); updateBuffers(); }, pause: () => {}, resume: () => {}, dispose: () => { context.parent?.remove(root); root.traverse((node: any) => { node.geometry?.dispose?.(); node.material?.dispose?.(); }); textureCache.forEach((texture) => texture.dispose?.()); } };
  }
}
