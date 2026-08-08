import type { RuntimeProgram, RuntimeSystem } from '@vfx-factory/artifact-schema';

/** Soft invents mirrored from the Unity→runtime@2 compile path. */
const CFXR_INITIAL_POSITION_SOFT: [number, number, number] = [0, 0, 0];
const CFXR_INITIAL_VELOCITY_SOFT: [number, number, number] = [0, 0, 0];
const CFXR_INITIAL_SIZE_SOFT: [number, number, number] = [1, 1, 1];
const CFXR_INITIAL_COLOR_SOFT: [number, number, number, number] = [1, 1, 1, 1];
const CFXR_STREAM_CUSTOM_ZERO_SOFT: [number, number, number, number] = [0, 0, 0, 0];
const CFXR_FRAME_SOFT = 0;
const CFXR_QUARKS_TILE_COUNT_SOFT = 1;
const CFXR_COLOR_CHANNEL_SOFT = 1;
const CFXR_SIZE_OVER_LIFE_SOFT = 1;
const CFXR_VELOCITY_AXIS_SOFT = 0;
const CFXR_PARTICLE_LIFE_MIN = 1e-4;
const CFXR_INITIAL_LIST_LEN_SOFT = 1;

export interface RuntimeParticle {
  age: number;
  life: number;
  position: [number, number, number];
  velocity: [number, number, number];
  size: [number, number, number];
  color: [number, number, number, number];
  frame: number;
  custom1: [number, number, number, number];
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
    const value = scalar(curve, CFXR_SIZE_OVER_LIFE_SOFT);
    particle.size[0] *= value;
    particle.size[1] *= value;
    particle.size[2] *= value;
  } else if (program.op === 'ColorOverLife') {
    const color = params.color?.color ?? params.color;
    if (color?.color) {
      particle.color = [
        Number(color.color.r ?? CFXR_COLOR_CHANNEL_SOFT),
        Number(color.color.g ?? CFXR_COLOR_CHANNEL_SOFT),
        Number(color.color.b ?? CFXR_COLOR_CHANNEL_SOFT),
        Number(color.color.a ?? CFXR_COLOR_CHANNEL_SOFT),
      ];
    }
  } else if (program.op === 'FrameOverLife') {
    const frameCount = Math.max(
      1,
      Number(params.frame?.count ?? params.frameCount ?? CFXR_QUARKS_TILE_COUNT_SOFT),
    );
    particle.frame = Math.min(frameCount - 1, Math.floor(normalizedAge * frameCount));
  } else if (program.op === 'VelocityOverLife') {
    const velocity = params.velocity ?? params;
    particle.velocity[0] += scalar(velocity.x, CFXR_VELOCITY_AXIS_SOFT);
    particle.velocity[1] += scalar(velocity.y, CFXR_VELOCITY_AXIS_SOFT);
    particle.velocity[2] += scalar(velocity.z, CFXR_VELOCITY_AXIS_SOFT);
  }
}

export function updateRuntimeSystem(state: RuntimeParticleSystemState, programs: Map<string, RuntimeProgram>, dt: number): void {
  const step = Math.max(0, dt);
  const previous = state.elapsed;
  state.elapsed += step;
  for (const burst of state.system.emission.bursts ?? []) {
    if ((burst.time > previous || (previous === 0 && burst.time === 0)) && burst.time <= state.elapsed) {
      const count = Math.min(state.system.capacity, Math.max(0, Math.floor(burst.count)));
      for (let i = 0; i < count && state.particles.length < state.system.capacity; i++) {
        const initial = state.system.initialParticles?.[
          i % (state.system.initialParticles.length || CFXR_INITIAL_LIST_LEN_SOFT)
        ];
        state.particles.push({
          age: 0,
          life: Math.max(CFXR_PARTICLE_LIFE_MIN, initial?.life ?? state.system.particleLife),
          position: [...(initial?.position ?? CFXR_INITIAL_POSITION_SOFT)],
          velocity: [...(initial?.velocity ?? CFXR_INITIAL_VELOCITY_SOFT)],
          size: [...(initial?.size ?? CFXR_INITIAL_SIZE_SOFT)],
          color: [...(initial?.color ?? CFXR_INITIAL_COLOR_SOFT)],
          frame: initial?.frame ?? CFXR_FRAME_SOFT,
          custom1: [...(initial?.custom1 ?? CFXR_STREAM_CUSTOM_ZERO_SOFT)],
          alive: true,
        });
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
