import { Object3D } from 'three';
import type { VfxSemanticContract } from './artifact-contract';

export interface ParticleStateSnapshot {
  schema: 'web-particle-state@2';
  effectId: string;
  seed: number;
  simulationTime: number;
  simulationUpdates: number[];
  bakedFrame?: number;
  emitters: Array<{
    id: string;
    name: string;
    path: string;
    count: number;
    particles: Array<{
      position: [number, number, number];
      velocity: [number, number, number];
      size: [number, number, number];
      color: [number, number, number, number];
      age: number;
      life: number;
      frame: number;
      seed?: number;
      rotation?: number | [number, number, number, number] | null;
      rotationEuler?: number[];
      custom1?: [number, number, number, number];
    }>;
  }>;
}

export function snapshotParticleState(
  effectRoot: Object3D,
  contract: VfxSemanticContract,
  clock: { time: number; updates: readonly number[] },
): ParticleStateSnapshot {
  const emitters: ParticleStateSnapshot['emitters'] = [];
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  effectRoot.traverse((object) => {
    if (object.type !== 'ParticleEmitter') return;
    const emitter = object as Object3D & { system?: {
      particleNum: number;
      particles: Array<{
        position: { x: number; y: number; z: number };
        velocity: { x: number; y: number; z: number };
        size: { x: number; y: number; z: number };
        color: { x: number; y: number; z: number; w: number };
        age: number; life: number; uvTile: number;
        rotation?: number | { x: number; y: number; z: number; w: number };
        unitySeed?: number;
      }>;
    } };
    const system = emitter.system;
    if (!system) return;
    const names: string[] = [];
    for (let parent: Object3D | null = emitter; parent; parent = parent.parent) {
      names.push(parent.name);
      if (parent === effectRoot) break;
    }
    emitters.push({
      id: emitter.uuid,
      name: emitter.name,
      path: names.reverse().join('/'),
      count: system.particleNum,
      particles: system.particles.slice(0, system.particleNum).map((particle) => ({
        position: [round(particle.position.x), round(particle.position.y), round(particle.position.z)],
        velocity: [round(particle.velocity.x), round(particle.velocity.y), round(particle.velocity.z)],
        size: [round(particle.size.x), round(particle.size.y), round(particle.size.z)],
        color: [round(particle.color.x), round(particle.color.y), round(particle.color.z), round(particle.color.w)],
        age: round(particle.age), life: round(particle.life), frame: round(particle.uvTile), seed: particle.unitySeed,
        rotation: typeof particle.rotation === 'number'
          ? round(particle.rotation)
          : particle.rotation
            ? [round(particle.rotation.x), round(particle.rotation.y), round(particle.rotation.z), round(particle.rotation.w)]
            : null,
        rotationEuler: (particle as any).unityRotationEuler?.map(round),
        custom1: (particle as any).unityCustom1?.map(round),
      })),
    });
  });
  emitters.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema: 'web-particle-state@2',
    effectId: contract.effectId,
    seed: contract.seed,
    simulationTime: round(clock.time),
    simulationUpdates: [...clock.updates],
    emitters,
  };
}
