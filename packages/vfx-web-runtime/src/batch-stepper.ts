import { BatchedRenderer } from 'three.quarks';
import { updateCfxrCustomAttributes } from './cfxrQuarksFidelity';

type RuntimeSystem = {
  update: (delta: number) => void;
  particleNum?: number;
  particles?: Array<{ age?: number; life?: number; previous?: unknown[] }>;
};

/** Advance each Quarks system exactly once and rebuild its render batches. */
export function updateBatchesExactlyOnce(
  renderer: BatchedRenderer,
  dt: number,
  emitterDeltas = new Map<object, number>(),
) {
  const systems = [...renderer.systemToBatchIndex.keys()] as unknown as RuntimeSystem[];
  for (const system of systems) {
    system.update(emitterDeltas.get(system) ?? dt);
    cullUnityExpiredParticles(system);
  }
  for (const batch of renderer.batches) batch.update();
  updateCfxrCustomAttributes(renderer);
}

function cullUnityExpiredParticles(system: RuntimeSystem) {
  if (!system.particles || typeof system.particleNum !== 'number') return;
  const epsilon = 1e-9;
  let count = system.particleNum;
  for (let i = count - 1; i >= 0; i--) {
    const particle = system.particles[i];
    if (particle?.previous && particle.previous.length > 0) continue;
    if (!Number.isFinite(particle?.age) || !Number.isFinite(particle?.life)) continue;
    if ((particle.age as number) + epsilon < (particle.life as number)) continue;
    const last = count - 1;
    system.particles[i] = system.particles[last];
    system.particles[last] = particle;
    count = last;
    system.particleNum = count;
  }
}
