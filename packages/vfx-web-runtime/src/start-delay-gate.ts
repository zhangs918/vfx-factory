/**
 * Unity startDelay gating for Quarks emitters. Extracted from cfxrQuarksFidelity
 * so the thin artifact player can arm/tick delays without pulling the full bridge.
 */
import type { Object3D } from 'three';
import type { ParticleEmitter, ParticleSystem } from 'three.quarks';

export interface StartDelayGate {
  delays: Map<string, number>;
  elapsed: number;
  armed: boolean;
}

/** Soft-fill when frozen payloads omit an explicit 0 startDelay entry. */
export const CFXR_START_DELAY_SOFT_FILL = 0;

export function createStartDelayGate(delays: Map<string, number>): StartDelayGate {
  return { delays, elapsed: 0, armed: false };
}

/**
 * Older / frozen-quarks payloads omit zero delays from runtimeConfig.startDelays.
 * Production soft-fills explicit 0 so arm/tick never invents at tick time.
 * Thin players must call requireStartDelayCoverage after offline-complete stamps.
 */
export function ensureStartDelayCoverage(root: Object3D, delays: Map<string, number>): void {
  root.traverse((child) => {
    if (child.type !== 'ParticleEmitter') return;
    const uuid = (child as ParticleEmitter).uuid;
    if (!delays.has(uuid)) delays.set(uuid, CFXR_START_DELAY_SOFT_FILL);
  });
}

/**
 * Thin contract: every emitter uuid must be offline-authored in startDelays (including 0).
 */
export function requireStartDelayCoverage(root: Object3D, delays: Map<string, number>): void {
  root.traverse((child) => {
    if (child.type !== 'ParticleEmitter') return;
    const uuid = (child as ParticleEmitter).uuid;
    if (!delays.has(uuid)) {
      throw new Error(`startDelay missing for emitter '${uuid}' (no invent)`);
    }
  });
}

function requireDelay(gate: StartDelayGate, emitterUuid: string): number {
  if (!gate.delays.has(emitterUuid)) {
    throw new Error(`startDelay missing for emitter '${emitterUuid}' (no invent)`);
  }
  return gate.delays.get(emitterUuid)!;
}

export function armStartDelays(root: Object3D, gate: StartDelayGate) {
  gate.elapsed = 0;
  gate.armed = true;
  root.traverse((child) => {
    if (child.type !== 'ParticleEmitter') return;
    const emitter = child as ParticleEmitter;
    const delay = requireDelay(gate, emitter.uuid);
    const system = emitter.system as ParticleSystem;
    if (delay > 0) {
      system.restart();
      system.pause();
    } else {
      system.restart();
      system.play();
    }
  });
}

/**
 * Advance the global delay clock and return the exact simulation slice for every emitter.
 * A delay may land inside a fixed step (for example 0.14 within the 0.1333→0.15 step). Unity
 * simulates only the remainder of that step; starting Quarks and giving it the full dt advances
 * position, lifetime curves and Custom streams by one partial frame.
 */
export function tickStartDelays(
  root: Object3D,
  gate: StartDelayGate,
  dt: number,
): Map<ParticleSystem, number> {
  const deltas = new Map<ParticleSystem, number>();
  const previous = gate.elapsed;
  if (gate.armed) gate.elapsed += dt;
  root.traverse((child) => {
    if (child.type !== 'ParticleEmitter') return;
    const emitter = child as ParticleEmitter;
    const delay = requireDelay(gate, emitter.uuid);
    const system = emitter.system as ParticleSystem;
    if (!gate.armed || delay <= previous) {
      deltas.set(system, dt);
      return;
    }
    if (gate.elapsed < delay) {
      deltas.set(system, 0);
      return;
    }
    if (system.paused) {
      system.restart();
      system.play();
    }
    deltas.set(system, Math.max(0, gate.elapsed - delay));
  });
  return deltas;
}
