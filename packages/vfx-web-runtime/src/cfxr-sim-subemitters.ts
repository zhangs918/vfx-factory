/**
 * Birth-edge and child-duration patches for EmitSubParticleSystem.
 */
import {
  ParticleSystem,
  type Behavior,
  type IParticleSystem,
  type Particle,
} from 'three.quarks';
import { readArtifactEmitterSim } from './artifact-emitter-sim';
import type { UnitySemanticParticle } from './cfxr-simulation-behaviors';

/** Soft invent when bag omits childDuration (non-calibrated / frozen). */
export const CFXR_CHILD_DURATION_SOFT = false;
/** Soft invent when Quarks counters/lists are absent mid-patch. */
export const CFXR_SUBEMITTER_COUNT_SOFT = 0;
export const CFXR_SUBEMITTER_DURATION_SOFT = 0;
export const CFXR_SUBEMITTER_ELAPSED_SOFT = 0;
/** Child-duration end compare slack. */
export const CFXR_SUBEMITTER_DURATION_END_EPS = 1e-7;

/**
 * three.quarks' Birth sub-emitter checks `particle.age === 0`. Calibrated Unity spawn state can
 * legitimately initialize a particle at a positive sub-frame age (or a negative scheduled age),
 * so equality loses the event completely. Convert it to an edge-triggered birth event while
 * retaining Quarks' live child-particle simulation.
 */
export function patchCalibratedBirthSubEmitters(system: ParticleSystem) {
  const hardResetters: Array<() => void> = [];
  for (const behavior of system.behaviors) {
    if (behavior.type !== 'EmitSubParticleSystem') continue;
    const sub = behavior as Behavior & {
      mode?: number;
      subEmissions?: unknown[];
      update: (particle: Particle, delta: number) => void;
      reset: () => void;
      __unityBirthEdge?: boolean;
      __unityHardReset?: () => void;
    };
    // quarks SubParticleEmitMode.Birth = 1. Frame/Death modes keep their stock semantics.
    if (sub.mode !== 1 || sub.__unityBirthEdge) continue;
    const originalUpdate = sub.update.bind(sub);
    const originalReset = sub.reset.bind(sub);
    let emittedObjects = new WeakSet<object>();
    const emittedParticleIds = new Set<string>();
    sub.update = (particle: Particle, delta: number) => {
      const semanticParticle = particle as UnitySemanticParticle;
      const particleId = semanticParticle.unityParticleId;
      // A calibrated one-cycle track is intentionally reused by UnityInitialState on every
      // authored loop. The stable logical birth identity is therefore track + effective root
      // spawn time, not track alone.
      let birthId: string | undefined;
      if (particleId) {
        if (typeof semanticParticle.unityGlobalSpawnTime !== 'number') {
          throw new Error(
            'calibrated birth sub-emitter: unityGlobalSpawnTime required when unityParticleId is set (no invent)',
          );
        }
        birthId = `${particleId}@${semanticParticle.unityGlobalSpawnTime}`;
      }
      if (particle.age < 0
          || (birthId ? emittedParticleIds.has(birthId) : emittedObjects.has(particle as object))) return;
      const age = particle.age;
      particle.age = 0;
      originalUpdate(particle, delta);
      particle.age = age;
      if (birthId) emittedParticleIds.add(birthId);
      else emittedObjects.add(particle as object);
    };
    sub.reset = () => {
      // Upstream EmitSubParticleSystem.reset() is empty, so replay otherwise retains every
      // previous child-emission instance. Do not clear Birth identity here: Quarks also calls
      // behavior.reset at an ordinary loop boundary while positive-age calibrated particles
      // remain alive, and clearing it would fire Birth twice for the same Unity particle.
      if (Array.isArray(sub.subEmissions)) sub.subEmissions.length = 0;
      originalReset();
    };
    sub.__unityHardReset = () => {
      emittedObjects = new WeakSet<object>();
      emittedParticleIds.clear();
      if (Array.isArray(sub.subEmissions)) sub.subEmissions.length = 0;
    };
    hardResetters.push(sub.__unityHardReset);
    sub.__unityBirthEdge = true;
  }
  const patchedSystem = system as ParticleSystem & { __unityBirthRestart?: boolean };
  if (hardResetters.length && !patchedSystem.__unityBirthRestart) {
    const originalRestart = system.restart.bind(system);
    system.restart = () => {
      originalRestart();
      for (const reset of hardResetters) reset();
    };
    patchedSystem.__unityBirthRestart = true;
  }
}

/** Quarks reuses `EmissionState.time` as the looping child's phase and wraps it to zero, while
 * EmitSubParticleSystem also uses that same value as instance elapsed time. Consequently a
 * looping child can never reach the intended duration-removal edge. Keep an orthogonal event
 * instance clock and leave the child's live looping phase untouched. */
type UnitySubEmitterInheritance = {
  schema: 'unity-sub-emitter-inheritance@1';
  size: boolean;
  color: boolean;
  rotation: boolean;
  lifetime: boolean;
};

export function patchChildDurationSubEmitters(
  system: ParticleSystem,
  inheritanceSpecs: UnitySubEmitterInheritance[] = [],
) {
  for (const inheritance of inheritanceSpecs) {
    if (inheritance.schema !== 'unity-sub-emitter-inheritance@1'
      || typeof inheritance.size !== 'boolean'
      || typeof inheritance.color !== 'boolean'
      || typeof inheritance.rotation !== 'boolean'
      || typeof inheritance.lifetime !== 'boolean') {
      throw new Error(
        'unity-sub-emitter-inheritance@1: size/color/rotation/lifetime required (no invent)',
      );
    }
  }
  let edgeIndex = 0;
  for (const behavior of system.behaviors) {
    if (behavior.type !== 'EmitSubParticleSystem') continue;
    const inheritance = inheritanceSpecs[edgeIndex++];
    const sub = behavior as Behavior & {
      subParticleSystem?: { uuid?: string; system?: IParticleSystem };
      subEmissions?: Array<{
        particle?: Particle;
        matrix: { elements?: number[] };
        __unityInstanceElapsed?: number;
        __unityInstanceId?: number;
        __unityLifetimeScale?: number;
      }>;
      setMatrixFromParticle?: (matrix: unknown, particle: Particle) => void;
      frameUpdate: (delta: number) => void;
      update: (particle: Particle, delta: number) => void;
      reset: () => void;
      __unityChildDuration?: boolean;
    };
    const targetUuid = sub.subParticleSystem?.uuid;
    const targetSystem = sub.subParticleSystem?.system as object | undefined;
    const childDuration = targetSystem
      ? !!readArtifactEmitterSim(targetSystem)?.childDuration
      : CFXR_CHILD_DURATION_SOFT;
    if (!targetUuid || !childDuration || sub.__unityChildDuration) continue;
    const originalReset = sub.reset.bind(sub);
    const originalUpdate = sub.update.bind(sub);
    let nextInstanceId = 1;
    sub.update = (particle: Particle, delta: number) => {
      const beforeStates = sub.subEmissions?.length ?? CFXR_SUBEMITTER_COUNT_SOFT;
      originalUpdate(particle, delta);
      const states = sub.subEmissions ?? [];
      const target = sub.subParticleSystem?.system as (IParticleSystem & {
        particleNum?: number;
        particles?: Particle[];
      }) | undefined;
      // Unity Birth sub-emitters begin emitting on the same fixed step as the
      // parent birth. Quarks queues the event for its next frameUpdate, which
      // creates a one-frame deficit in every calibrated child instance.
      for (let i = beforeStates; i < states.length; i++) {
        const state = states[i];
        if (state.__unityInstanceId == null) state.__unityInstanceId = nextInstanceId++;
        if (state.__unityLifetimeScale == null) state.__unityLifetimeScale = particle.life;
        if (!target) continue;
        const before = target.particleNum ?? CFXR_SUBEMITTER_COUNT_SOFT;
        target.emit(delta, state as any, state.matrix as any);
        state.__unityInstanceElapsed = Math.max(0, delta);
        const after = target.particleNum ?? before;
        if (target.particles) {
          for (let particleIndex = before; particleIndex < after; particleIndex++) {
            (target.particles[particleIndex] as Particle & { __unitySubEmitterInstanceId?: number })
              .__unitySubEmitterInstanceId = state.__unityInstanceId;
          }
          if (inheritance?.lifetime) {
            // Set above when null; do not invent a second default here.
            const scale = Math.max(0, state.__unityLifetimeScale as number);
            for (let particleIndex = before; particleIndex < after; particleIndex++) {
              target.particles[particleIndex].life *= scale;
            }
          }
        }
      }
    };
    sub.frameUpdate = (delta: number) => {
      const states = sub.subEmissions ?? [];
      const target = sub.subParticleSystem?.system as (IParticleSystem & {
        particleNum?: number;
        particles?: Particle[];
        duration?: number;
      }) | undefined;
      if (target && typeof target.duration !== 'number') {
        throw new Error('unity-subemitter: target.duration required (no invent)');
      }
      const duration = target?.duration ?? CFXR_SUBEMITTER_DURATION_SOFT;
      for (let i = states.length - 1; i >= 0; i--) {
        const state = states[i];
        const next = (state.__unityInstanceElapsed ?? CFXR_SUBEMITTER_ELAPSED_SOFT) + Math.max(0, delta);
        if (duration > 0 && next + CFXR_SUBEMITTER_DURATION_END_EPS >= duration) {
          // Unity's parent-event child instance is destroyed at its authored
          // duration, including already-emitted child particles. Quarks only
          // stops the emission state, so mark births with the instance id and
          // remove the complete owned set at this boundary.
          const instanceId = state.__unityInstanceId;
          if (instanceId != null && target?.particles && typeof target.particleNum === 'number') {
            let count = target.particleNum;
            for (let particleIndex = count - 1; particleIndex >= 0; particleIndex--) {
              const child = target.particles[particleIndex] as Particle & { __unitySubEmitterInstanceId?: number };
              if (child.__unitySubEmitterInstanceId !== instanceId) continue;
              const last = count - 1;
              target.particles[particleIndex] = target.particles[last];
              target.particles[last] = child;
              count = last;
            }
            target.particleNum = count;
          }
          states.splice(i, 1);
          continue;
        }
        const parent = state.particle as UnitySemanticParticle | undefined;
        if (state.__unityInstanceId == null) state.__unityInstanceId = nextInstanceId++;
        if (state.__unityLifetimeScale == null && parent) state.__unityLifetimeScale = parent.life;
        state.__unityInstanceElapsed = next;
        if (!target) continue;
        if (parent && parent.age < parent.life) {
          sub.setMatrixFromParticle?.(state.matrix, parent);
          if (inheritance?.size && state.matrix.elements) {
            const e = state.matrix.elements;
            for (const index of [0, 1, 2]) e[index] *= parent.size.x;
            for (const index of [4, 5, 6]) e[index] *= parent.size.y;
            for (const index of [8, 9, 10]) e[index] *= parent.size.z;
          }
        } else {
          state.particle = undefined;
        }
        const before = target.particleNum ?? CFXR_SUBEMITTER_COUNT_SOFT;
        target.emit(delta, state as any, state.matrix as any);
        if (inheritance?.color && parent && target.particles) {
          const after = target.particleNum ?? before;
          for (let particleIndex = before; particleIndex < after; particleIndex++) {
            const child = target.particles[particleIndex];
            child.startColor.x *= parent.color.x;
            child.startColor.y *= parent.color.y;
            child.startColor.z *= parent.color.z;
            child.startColor.w *= parent.color.w;
            child.color.copy(child.startColor);
          }
        }
        if (inheritance?.lifetime && target.particles) {
          const after = target.particleNum ?? before;
          // Unity's Inherit Lifetime scales the child module's authored lifetime by
          // the normalized lifetime of the owning parent at emission. Quarks exposes
          // the newly emitted range synchronously, so apply the same scale once at birth.
          const lifetimeScale = Math.max(0, state.__unityLifetimeScale as number);
          for (let particleIndex = before; particleIndex < after; particleIndex++) {
            const child = target.particles[particleIndex];
            child.life *= lifetimeScale;
          }
        }
        if (target.particles) {
          const after = target.particleNum ?? before;
          for (let particleIndex = before; particleIndex < after; particleIndex++) {
            (target.particles[particleIndex] as Particle & { __unitySubEmitterInstanceId?: number })
              .__unitySubEmitterInstanceId = state.__unityInstanceId;
          }
        }
      }
      // A child-duration instance owns the entire child system. Once the last
      // live parent-event state has expired, no child particle may leak into a
      // later root frame (including particles that were born before ownership
      // tagging was attached).
      if (states.length === 0 && target?.particles && typeof target.particleNum === 'number') {
        target.particleNum = 0;
      }
    };
    sub.reset = () => {
      originalReset();
      nextInstanceId = 1;
    };
    sub.__unityChildDuration = true;
  }
}
