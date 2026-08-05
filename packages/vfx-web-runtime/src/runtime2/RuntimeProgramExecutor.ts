import type { RuntimeProgram, RuntimeSystem } from '@vfx-factory/artifact-schema';

export interface RuntimeParticle {
  age: number;
  life: number;
  position: [number, number, number];
  velocity: [number, number, number];
  size: [number, number, number];
  color: [number, number, number, number];
  frame: number;
  alive: boolean;
}

export interface RuntimeParticleSystemState {
  system: RuntimeSystem;
  elapsed: number;
  particles: RuntimeParticle[];
}

const scalar = (value: any, fallback: number) =>
  typeof value === 'number' ? value : Number(value?.value ?? fallback);

export function createRuntimeSystemState(system: RuntimeSystem): RuntimeParticleSystemState {
  return { system, elapsed: 0, particles: [] };
}

function applyProgram(program: RuntimeProgram, particle: RuntimeParticle, normalizedAge: number): void {
  const params = program.params as any;
  if (program.op === 'SizeOverLife') {
    const curve = params.size?.curve ?? params.curve;
    const value = scalar(curve, 1);
    particle.size[0] *= value;
    particle.size[1] *= value;
    particle.size[2] *= value;
  } else if (program.op === 'ColorOverLife') {
    const color = params.color?.color ?? params.color;
    if (color?.color) particle.color = [Number(color.color.r ?? 1), Number(color.color.g ?? 1), Number(color.color.b ?? 1), Number(color.color.a ?? 1)];
  } else if (program.op === 'FrameOverLife') {
    const frameCount = Math.max(1, Number(params.frame?.count ?? params.frameCount ?? 1));
    particle.frame = Math.min(frameCount - 1, Math.floor(normalizedAge * frameCount));
  } else if (program.op === 'VelocityOverLife') {
    const velocity = params.velocity ?? params;
    particle.velocity[0] += scalar(velocity.x, 0);
    particle.velocity[1] += scalar(velocity.y, 0);
    particle.velocity[2] += scalar(velocity.z, 0);
  }
}

export function updateRuntimeSystem(state: RuntimeParticleSystemState, programs: Map<string, RuntimeProgram>, dt: number): void {
  const step = Math.max(0, dt);
  const previous = state.elapsed;
  state.elapsed += step;
  for (const burst of state.system.emission.bursts ?? []) {
    if (burst.time > previous && burst.time <= state.elapsed) {
      const count = Math.min(state.system.capacity, Math.max(0, Math.floor(burst.count)));
      for (let i = 0; i < count && state.particles.length < state.system.capacity; i++) {
        state.particles.push({ age: 0, life: Math.max(1e-4, state.system.duration), position: [0, 0, 0], velocity: [0, 0, 0], size: [1, 1, 1], color: [1, 1, 1, 1], frame: 0, alive: true });
      }
    }
  }
  for (const particle of state.particles) {
    if (!particle.alive) continue;
    particle.age += step;
    if (particle.age >= particle.life) { particle.alive = false; continue; }
    particle.position[0] += particle.velocity[0] * step;
    particle.position[1] += particle.velocity[1] * step;
    particle.position[2] += particle.velocity[2] * step;
    const normalizedAge = particle.age / particle.life;
    for (const id of state.system.programs) {
      const program = programs.get(id);
      if (program) applyProgram(program, particle, normalizedAge);
    }
  }
}
