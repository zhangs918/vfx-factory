import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, PlaneGeometry, TextureLoader, type Object3D, type ShaderMaterial } from 'three';
import type { WebVfxRuntimeV2, RuntimeResource } from '@vfx-factory/artifact-schema';
import { createRuntimeMaterial } from './RuntimeMaterialFactory';
import { createRuntimeSystemState, updateRuntimeSystem, type RuntimeParticleSystemState } from './RuntimeProgramExecutor';
import type { RuntimeBackend, RuntimeHandle } from './RuntimeBackend';

/** Soft invent when flipbook tile counts omitted (matches compiler CFXR_QUARKS_TILE_COUNT_SOFT). */
const CFXR_QUARKS_TILE_COUNT_SOFT = 1;

export interface ThreeRuntimeContext { parent?: Object3D; resourceBaseUrl?: string; }
type RenderRecord = { state: RuntimeParticleSystemState; mesh: InstancedMesh<BufferGeometry, ShaderMaterial>; position: InstancedBufferAttribute; size: InstancedBufferAttribute; color: InstancedBufferAttribute; custom1: InstancedBufferAttribute };
function resolveUri(uri: string, base = ''): string { if (/^(https?:|data:|blob:|\/)/.test(uri)) return uri; return `${base.replace(/\/$/, '')}/${uri.replace(/^\//, '')}`; }

function geometryFor(system: WebVfxRuntimeV2['systems'][number], resources: Map<string, RuntimeResource>): BufferGeometry {
  if (system.renderMode !== 'mesh' || !system.geometry) return new PlaneGeometry(1, 1);
  const resource = resources.get(system.geometry);
  const data = resource?.metadata as { positions?: number[]; indices?: number[]; uvs?: number[]; normals?: number[] } | undefined;
  if (!data?.positions?.length) return new PlaneGeometry(1, 1);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(data.positions), 3));
  if (data.uvs?.length) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(data.uvs), 2));
  if (data.normals?.length) geometry.setAttribute('normal', new BufferAttribute(new Float32Array(data.normals), 3));
  if (data.indices?.length) geometry.setIndex(data.indices);
  geometry.computeBoundingSphere();
  return geometry;
}

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
      if (system.renderMode === 'trail') throw new Error(`Runtime v2 system '${system.id}' render mode 'trail' requires a compiled trail program.`);
      const material = materials.get(system.material);
      if (!material) throw new Error(`Runtime v2 system '${system.id}' references missing material '${system.material}'.`);
      const systemMaterial = material.clone();
      systemMaterial.uniforms.uTileColumns = {
        value: system.flipbook?.columns ?? CFXR_QUARKS_TILE_COUNT_SOFT,
      };
      systemMaterial.uniforms.uTileRows = {
        value: system.flipbook?.rows ?? CFXR_QUARKS_TILE_COUNT_SOFT,
      };
      const mesh = new InstancedMesh(geometryFor(system, resources), systemMaterial, system.capacity);
      const position = new InstancedBufferAttribute(new Float32Array(system.capacity * 3), 3).setUsage(DynamicDrawUsage);
      const size = new InstancedBufferAttribute(new Float32Array(system.capacity * 3), 3).setUsage(DynamicDrawUsage);
      const color = new InstancedBufferAttribute(new Float32Array(system.capacity * 4), 4).setUsage(DynamicDrawUsage);
      const frame = new InstancedBufferAttribute(new Float32Array(system.capacity), 1).setUsage(DynamicDrawUsage);
      const custom1 = new InstancedBufferAttribute(new Float32Array(system.capacity * 4), 4).setUsage(DynamicDrawUsage);
      mesh.geometry.setAttribute('instancePosition', position); mesh.geometry.setAttribute('instanceSize', size); mesh.geometry.setAttribute('instanceColor', color); mesh.geometry.setAttribute('instanceFrame', frame); mesh.geometry.setAttribute('instanceCustom1', custom1); mesh.count = 0;
      root.add(mesh); records.push({ state: createRuntimeSystemState(system), mesh, position, size, color, custom1 });
    }
    context.parent?.add(root);
    const updateBuffers = () => { for (const record of records) { let count = 0; for (const particle of record.state.particles) { if (!particle.alive) continue; record.position.setXYZ(count, ...particle.position); record.size.setXYZ(count, ...particle.size); record.color.setXYZW(count, ...particle.color); record.custom1.setXYZW(count, ...particle.custom1); (record.mesh.geometry.getAttribute('instanceFrame') as InstancedBufferAttribute).setX(count, particle.frame); count++; } record.mesh.count = count; record.position.needsUpdate = true; record.size.needsUpdate = true; record.color.needsUpdate = true; record.custom1.needsUpdate = true; (record.mesh.geometry.getAttribute('instanceFrame') as InstancedBufferAttribute).needsUpdate = true; } };
    return { root, update: (dt) => { records.forEach((record) => updateRuntimeSystem(record.state, programs, dt)); updateBuffers(); }, restart: () => { records.forEach((record) => { record.state.elapsed = 0; record.state.particles.length = 0; }); updateBuffers(); }, pause: () => {}, resume: () => {}, dispose: () => { context.parent?.remove(root); root.traverse((node: any) => { node.geometry?.dispose?.(); node.material?.dispose?.(); }); textureCache.forEach((texture) => texture.dispose?.()); } };
  }
}
