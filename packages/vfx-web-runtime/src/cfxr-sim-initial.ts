/**
 * Calibrated Unity initial-state, global-age, spawn-visibility, and trajectory cache.
 * Also owns the shared effect clock (thin-safe; no scene-color / ubershader).
 */
import {
  Vector3 as QuarksVector3,
  Vector4 as QuarksVector4,
  Quaternion as QuarksQuaternion,
  type Behavior,
  type Particle,
} from 'three.quarks';
import type { UnitySemanticParticle } from './cfxr-simulation-behaviors';
import {
  CFXR_STREAM_CUSTOM_ZERO,
  CFXR_STREAM_FLIP_IDENTITY,
} from './batch-stepper';

/** Loop duration below this is treated as non-looping (not a soft invent of period). */
export const CFXR_INITIAL_LOOP_DURATION_EPS = 1e-6;
/** Spawn-visibility compare slack vs effect clock (Unity before-spawn edge). */
export const CFXR_GLOBAL_SPAWN_TIME_EPS = 1e-9;
/** Trajectory sample / termination age denominators. */
export const CFXR_TRAJECTORY_AGE_EPS = 1e-6;
/** Loop-wrap detect slack past cycle end (keep freeze@duration on first cycle). */
export const CFXR_LOOP_WRAP_DETECT_EPS = 1e-4;
/** Cycle index floor nudge when wrapping spawn times. */
export const CFXR_LOOP_WRAP_INDEX_EPS = 1e-7;
/** Trajectory sampleRate → sampleEpsilon scale numerator (Unity fixed clock). */
export const CFXR_TRAJECTORY_SAMPLE_EPS_NUMERATOR = 0.01;
export const CFXR_TRAJECTORY_SAMPLE_EPS_CAP = 1e-4;
/** Velocity blend endpoints near sample boundaries. */
export const CFXR_TRAJECTORY_VELOCITY_BLEND_EPS = 1e-4;

let sharedEffectTime = 0;

export function getCfxrEffectTime(): number {
  return sharedEffectTime;
}

export function setCfxrEffectTime(seconds: number): void {
  sharedEffectTime = seconds;
}

interface UnityInitialParticleState {
  position: [number, number, number];
  velocity: [number, number, number];
  size: [number, number, number];
  baseSize?: [number, number, number];
  color: [number, number, number, number];
  life: number;
  seed: number;
  particleId?: string;
  spawnAgeOffset?: number;
  spawnTime?: number;
  scheduleTime?: number;
  globalSpawnTime?: number;
  sizeCurveLerp?: number;
  rotationCurveLerp?: [number, number, number];
  rotationEulerRadians?: [number, number, number];
  rotationBase?: [number, number, number, number];
  frame?: number;
  rendererFlip?: [boolean, boolean];
  custom1?: [number, number, number, number];
  custom2?: [number, number, number, number];
  rotation?: number | [number, number, number, number];
}

interface UnityTrajectorySample {
  age: number;
  position: [number, number, number];
  velocity: [number, number, number];
  rotation?: number | [number, number, number, number];
  size?: [number, number, number];
  frame?: number;
  color?: [number, number, number, number];
  custom1?: [number, number, number, number];
  custom2?: [number, number, number, number];
}

interface UnityTrajectoryTermination {
  /** Last age for which Unity returned the particle from GetParticles. */
  lastVisibleAge: number;
  /** First fixed-clock age for which Unity no longer returned the particle. */
  firstAbsentAge: number;
  /** Authoritative terminal point; never extrapolate a collision beyond it. */
  position: [number, number, number];
  velocity?: [number, number, number];
  reason: 'lifetime' | 'collision-or-native-kill';
}

interface UnityTrajectoryCache {
  schema: 'particle-trajectory-cache@4' | 'particle-trajectory-cache@5'
    | 'particle-trajectory-cache@6';
  sampleRate: number;
  space: 'world' | 'local';
  tracks: Array<{
    seed?: number;
    particleId?: string;
    samples: UnityTrajectorySample[];
    termination?: UnityTrajectoryTermination;
  }>;
}

export class UnityInitialStateBehavior implements Behavior {
  type = 'UnityInitialState';
  private cursor = 0;
  private states: UnityInitialParticleState[];
  private loopDuration?: number;
  private billboardAxis = new QuarksVector3(0, 0, 1);
  /** Thin: refuse flip/custom soft invent (corpus must stamp). */
  private requireStreamStamps: boolean;
  constructor(
    states: UnityInitialParticleState[],
    loopDuration?: number,
    options?: { requireStreamStamps?: boolean },
  ) {
    // Burst evaluation is chronological. Unity's GetParticles storage order is only mostly
    // chronological and may contain sub-frame inversions, so cursor-based initialization must
    // consume an explicitly stable time ordering.
    this.states = states
      .map((state, index) => ({ state, index }))
      .sort((a, b) => {
        const ta = a.state.scheduleTime ?? a.state.globalSpawnTime;
        const tb = b.state.scheduleTime ?? b.state.globalSpawnTime;
        if (typeof ta !== 'number' || typeof tb !== 'number') {
          throw new Error('UnityInitialState: scheduleTime|globalSpawnTime required for ordering (no invent)');
        }
        const ga = a.state.globalSpawnTime;
        const gb = b.state.globalSpawnTime;
        if (typeof ga !== 'number' || typeof gb !== 'number') {
          throw new Error('UnityInitialState: globalSpawnTime required for ordering (no invent)');
        }
        return (ta - tb) || (ga - gb) || a.index - b.index;
      })
      .map(({ state }) => state);
    this.loopDuration = loopDuration && loopDuration > CFXR_INITIAL_LOOP_DURATION_EPS
      ? loopDuration
      : undefined;
    this.requireStreamStamps = !!options?.requireStreamStamps;
  }
  initialize(particle: UnitySemanticParticle): void {
    if (!this.states.length) return;
    const state = this.states[this.cursor++ % this.states.length];
    const requireVec = (label: string, value: unknown, n: number): number[] => {
      if (!Array.isArray(value) || value.length !== n || value.some((v) => typeof v !== 'number')) {
        throw new Error(`UnityInitialState: ${label}[${n}] required (no invent)`);
      }
      return value as number[];
    };
    if (typeof state.life !== 'number') {
      throw new Error('UnityInitialState: life required (no invent)');
    }
    const position = requireVec('position', state.position, 3);
    const velocity = requireVec('velocity', state.velocity, 3);
    const size = requireVec('size', state.size, 3);
    const color = requireVec('color', state.color, 4);
    const startSize = state.baseSize != null ? requireVec('baseSize', state.baseSize, 3) : size;
    particle.position.fromArray(position);
    particle.velocity.fromArray(velocity);
    particle.startSize.fromArray(startSize);
    particle.size.fromArray(size);
    particle.startColor = new QuarksVector4(...color);
    particle.color.copy(particle.startColor);
    particle.life = state.life;
    // `spawnTime` is measured on Unity's root simulation clock. A Quarks sub-emitter has one
    // local emission clock per parent particle, so subtracting the two creates negative ages
    // and shifts every lifetime-driven shader/simulation curve. The exported age is the exact
    // sub-frame offset at birth and is valid for delayed, continuous, burst and sub emitters.
    let effectiveSpawnTime = state.globalSpawnTime;
    // The calibrated stream stores one Unity cycle. On a looping system Quarks reuses that
    // stream, so advance its root-clock timestamp to the current cycle as well; otherwise every
    // second-cycle particle is born with an age >= duration and vanishes immediately.
    // Unity exposes the final state of a cycle at t == duration and begins the next cycle on
    // the following simulation tick. Do not use a positive epsilon/`>=` here: deterministic
    // freeze captures at exactly duration would otherwise show a Web-only second burst.
    if (effectiveSpawnTime != null && this.loopDuration != null
        && getCfxrEffectTime() > effectiveSpawnTime + this.loopDuration + CFXR_LOOP_WRAP_DETECT_EPS) {
      const cycle = Math.floor(
        (getCfxrEffectTime() - effectiveSpawnTime + CFXR_LOOP_WRAP_INDEX_EPS) / this.loopDuration,
      );
      effectiveSpawnTime += Math.max(0, cycle) * this.loopDuration;
    }
    particle.unityGlobalSpawnTime = effectiveSpawnTime;
    if (typeof state.spawnAgeOffset !== 'number') {
      throw new Error('UnityInitialState: spawnAgeOffset required (no invent)');
    }
    if (typeof state.seed !== 'number') {
      throw new Error('UnityInitialState: seed required (no invent)');
    }
    if (state.particleId == null || state.particleId === '') {
      throw new Error('UnityInitialState: particleId required (no invent)');
    }
    particle.unitySpawnAgeOffset = Math.max(0, state.spawnAgeOffset);
    particle.age = effectiveSpawnTime != null
      ? Math.max(0, getCfxrEffectTime() - effectiveSpawnTime)
      : Math.max(0, state.spawnAgeOffset);
    particle.unitySeed = state.seed;
    particle.unityParticleId = String(state.particleId);
    particle.unitySizeCurveLerp = state.sizeCurveLerp;
    particle.unityRotationCurveLerp = state.rotationCurveLerp;
    particle.unityRotationEuler = state.rotationEulerRadians
      ? [...state.rotationEulerRadians] as [number, number, number]
      : undefined;
    particle.unityRotationBase = state.rotationBase
      ? new QuarksQuaternion(...state.rotationBase)
      : undefined;
    if (Array.isArray(state.rotation)) {
      particle.rotation = new QuarksQuaternion(...state.rotation);
    } else if (typeof state.rotation === 'number') {
      if (particle.rotation instanceof QuarksQuaternion)
        particle.rotation.setFromAxisAngle(this.billboardAxis, state.rotation);
      else particle.rotation = state.rotation;
    }
    if (state.frame != null && state.frame >= 0) particle.uvTile = state.frame;
    // Partial stamp: any of flip/custom1/custom2 authored → require all three (no invent).
    // Full soft invent remains only for frozen states with none of these fields.
    const hasFlipStamp = Array.isArray(state.rendererFlip) && state.rendererFlip.length === 2;
    const hasCustom1Stamp = Array.isArray(state.custom1) && state.custom1.length === 4;
    const hasCustom2Stamp = Array.isArray(state.custom2) && state.custom2.length === 4;
    const requireStream = this.requireStreamStamps
      || hasFlipStamp || hasCustom1Stamp || hasCustom2Stamp;
    // v3 corpus stamps rendererFlip; frozen/unstamped may still invent flip identity.
    if (hasFlipStamp) {
      particle.unityRendererFlip = [!!state.rendererFlip![0], !!state.rendererFlip![1]];
    } else if (requireStream) {
      throw new Error('UnityInitialState: rendererFlip[2] required (no invent)');
    } else {
      particle.unityRendererFlip = [...CFXR_STREAM_FLIP_IDENTITY];
    }
    // Prefer offline initial-state custom streams; Custom1/Custom2 behaviors overwrite.
    // v3 corpus stamps zeros; frozen/unstamped may still invent stream identity.
    if (hasCustom1Stamp) {
      particle.unityCustom1 = [
        state.custom1![0], state.custom1![1], state.custom1![2], state.custom1![3],
      ];
    } else if (requireStream) {
      throw new Error('UnityInitialState: custom1[4] required (no invent)');
    } else if (!Array.isArray(particle.unityCustom1) || particle.unityCustom1.length !== 4) {
      particle.unityCustom1 = [...CFXR_STREAM_CUSTOM_ZERO];
    }
    if (hasCustom2Stamp) {
      particle.unityCustom2 = [
        state.custom2![0], state.custom2![1], state.custom2![2], state.custom2![3],
      ];
    } else if (requireStream) {
      throw new Error('UnityInitialState: custom2[4] required (no invent)');
    } else if (!Array.isArray(particle.unityCustom2) || particle.unityCustom2.length !== 4) {
      particle.unityCustom2 = [...CFXR_STREAM_CUSTOM_ZERO];
    }
  }
  update(): void {}
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() {
    return new UnityInitialStateBehavior(this.states, this.loopDuration, {
      requireStreamStamps: this.requireStreamStamps,
    });
  }
  reset(): void { this.cursor = 0; }
}

/** Pins nested emitter lifetime semantics to Unity's root hierarchy clock. */
export class UnityGlobalAgeBehavior implements Behavior {
  type = 'UnityGlobalAge';
  initialize(): void {}
  update(particle: UnitySemanticParticle, delta: number): void {
    if (particle.unityGlobalSpawnTime == null) return;
    const beforeSpawn = getCfxrEffectTime() + CFXR_GLOBAL_SPAWN_TIME_EPS
      < particle.unityGlobalSpawnTime;
    if (!beforeSpawn && particle.unityBeforeGlobalSpawn) particle.color.copy(particle.startColor);
    particle.unityBeforeGlobalSpawn = beforeSpawn;
    // Quarks increments age after all behaviors. Present start-of-step age to lifetime
    // behaviors so the post-step age equals the exported root-clock age exactly.
    particle.age = Math.max(
      0,
      getCfxrEffectTime() - particle.unityGlobalSpawnTime - Math.max(0, delta),
    );
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityGlobalAgeBehavior(); }
  reset(): void {}
}

/** Runs after authored color behaviors and masks particles that Quarks emitted too early. */
export class UnitySpawnVisibilityBehavior implements Behavior {
  type = 'UnitySpawnVisibility';
  initialize(): void {}
  update(particle: UnitySemanticParticle): void {
    if (particle.unityBeforeGlobalSpawn || particle.unityTrajectoryEnded) particle.color.w = 0;
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnitySpawnVisibilityBehavior(); }
  reset(): void {}
}

/** Camera-independent fallback for Unity-native simulation modules without a published kernel. */
export class UnityTrajectoryCacheBehavior implements Behavior {
  type = 'UnityTrajectoryCache';
  private tracks = new Map<string, {
    samples: UnityTrajectorySample[];
    termination?: UnityTrajectoryTermination;
  }>();
  private target = new QuarksVector3();
  private billboardAxis = new QuarksVector3(0, 0, 1);
  private sampleEpsilon: number;
  constructor(cache: UnityTrajectoryCache) {
    if (!(typeof cache.sampleRate === 'number' && cache.sampleRate > 0)) {
      throw new Error('UnityTrajectoryCache: sampleRate required (no invent)');
    }
    if (cache.space !== 'world' && cache.space !== 'local') {
      throw new Error('UnityTrajectoryCache: space required (no invent)');
    }
    if (!Array.isArray(cache.tracks)) {
      throw new Error('UnityTrajectoryCache: tracks required (no invent)');
    }
    for (const track of cache.tracks) {
      if (track.particleId == null || track.particleId === '') {
        throw new Error('UnityTrajectoryCache: track.particleId required (no invent)');
      }
      if (!Array.isArray(track.samples) || !track.samples.length) {
        throw new Error('UnityTrajectoryCache: track.samples required (no invent)');
      }
      for (const sample of track.samples) {
        if (typeof sample.age !== 'number') {
          throw new Error('UnityTrajectoryCache: sample.age required (no invent)');
        }
        if (!Array.isArray(sample.position) || sample.position.length !== 3
          || sample.position.some((v) => typeof v !== 'number')) {
          throw new Error('UnityTrajectoryCache: sample.position[3] required (no invent)');
        }
        if (!Array.isArray(sample.velocity) || sample.velocity.length !== 3
          || sample.velocity.some((v) => typeof v !== 'number')) {
          throw new Error('UnityTrajectoryCache: sample.velocity[3] required (no invent)');
        }
      }
      if (track.termination) {
        const term = track.termination;
        if (typeof term.firstAbsentAge !== 'number' || typeof term.lastVisibleAge !== 'number') {
          throw new Error('UnityTrajectoryCache: termination ages required (no invent)');
        }
        if (!Array.isArray(term.position) || term.position.length !== 3
          || term.position.some((v) => typeof v !== 'number')) {
          throw new Error('UnityTrajectoryCache: termination.position[3] required (no invent)');
        }
        if (typeof term.reason !== 'string' || !term.reason) {
          throw new Error('UnityTrajectoryCache: termination.reason required (no invent)');
        }
      }
      this.tracks.set(String(track.particleId), {
        samples: track.samples,
        termination: track.termination,
      });
    }
    // Unity samples the hierarchy on a fixed clock. A track ending means GetParticles no longer
    // returned that particle on the following sample; clamping forever to the last state leaves
    // one-frame terminal ghosts. Keep only a small floating-point tolerance around that sample.
    this.sampleEpsilon = Math.min(
      CFXR_TRAJECTORY_SAMPLE_EPS_CAP,
      CFXR_TRAJECTORY_SAMPLE_EPS_NUMERATOR / cache.sampleRate,
    );
  }
  private applyRotation(
    particle: UnitySemanticParticle,
    a: UnityTrajectorySample,
    b: UnityTrajectorySample,
    t: number,
  ) {
    if (typeof a.rotation === 'number' && typeof b.rotation === 'number') {
      const delta = Math.atan2(Math.sin(b.rotation - a.rotation), Math.cos(b.rotation - a.rotation));
      const angle = a.rotation + delta * t;
      if (particle.rotation instanceof QuarksQuaternion)
        particle.rotation.setFromAxisAngle(this.billboardAxis, angle);
      else particle.rotation = angle;
    } else if (Array.isArray(a.rotation) && Array.isArray(b.rotation)) {
      const rotation = particle.rotation instanceof QuarksQuaternion
        ? particle.rotation
        : new QuarksQuaternion();
      rotation.fromArray(a.rotation).slerp(new QuarksQuaternion(...b.rotation), t).normalize();
      particle.rotation = rotation;
    }
  }
  private applyVisualState(
    particle: UnitySemanticParticle,
    a: UnityTrajectorySample,
    b: UnityTrajectorySample,
    t: number,
  ) {
    if (a.frame != null && b.frame != null) {
      // Atlas cells are discrete. Unity holds the earlier cell until the sampled transition.
      particle.uvTile = t < 1 ? a.frame : b.frame;
    }
    if (a.size && b.size) particle.size.set(
      a.size[0] + (b.size[0] - a.size[0]) * t,
      a.size[1] + (b.size[1] - a.size[1]) * t,
      a.size[2] + (b.size[2] - a.size[2]) * t,
    );
    if (a.color && b.color) particle.color.set(
      a.color[0] + (b.color[0] - a.color[0]) * t,
      a.color[1] + (b.color[1] - a.color[1]) * t,
      a.color[2] + (b.color[2] - a.color[2]) * t,
      a.color[3] + (b.color[3] - a.color[3]) * t,
    );
    if (a.custom1 && b.custom1) particle.unityCustom1 = [
      a.custom1[0] + (b.custom1[0] - a.custom1[0]) * t,
      a.custom1[1] + (b.custom1[1] - a.custom1[1]) * t,
      a.custom1[2] + (b.custom1[2] - a.custom1[2]) * t,
      a.custom1[3] + (b.custom1[3] - a.custom1[3]) * t,
    ];
    if (a.custom2 && b.custom2) particle.unityCustom2 = [
      a.custom2[0] + (b.custom2[0] - a.custom2[0]) * t,
      a.custom2[1] + (b.custom2[1] - a.custom2[1]) * t,
      a.custom2[2] + (b.custom2[2] - a.custom2[2]) * t,
      a.custom2[3] + (b.custom2[3] - a.custom2[3]) * t,
    ];
  }
  private applyRendererVelocity(
    particle: UnitySemanticParticle,
    samples: UnityTrajectorySample[],
    index: number,
  ) {
    const previous = samples[Math.max(0, index - 1)];
    const next = samples[Math.min(samples.length - 1, index + 1)];
    const dt = Math.max(CFXR_TRAJECTORY_AGE_EPS, next.age - previous.age);
    particle.velocity.set(
      (next.position[0] - previous.position[0]) / dt,
      (next.position[1] - previous.position[1]) / dt,
      (next.position[2] - previous.position[2]) / dt,
    );
  }
  private sample(particle: UnitySemanticParticle, age: number, out: QuarksVector3): boolean {
    if (particle.unityParticleId == null || particle.unityParticleId === '') {
      throw new Error('UnityTrajectoryCache: particle.unityParticleId required (no invent)');
    }
    const particleId = particle.unityParticleId;
    const track = this.tracks.get(particleId);
    const samples = track?.samples;
    if (!samples?.length) return false;
    if (age <= samples[0].age) {
      out.fromArray(samples[0].position);
      this.applyRotation(particle, samples[0], samples[0], 0);
      this.applyVisualState(particle, samples[0], samples[0], 0);
      this.applyRendererVelocity(particle, samples, 0);
      return true;
    }
    const last = samples[samples.length - 1];
    const termination = track?.termination;
    if (termination && age + this.sampleEpsilon >= termination.firstAbsentAge) {
      particle.unityTrajectoryEnded = true;
      particle.color.w = 0;
      out.fromArray(termination.position);
      return true;
    }
    // @6 separates the last visible sample from the disappearance edge. Hold/interpolate only
    // inside that measured interval; collision particles must never fly past the exported hit.
    if (termination && age > last.age) {
      particle.unityTrajectoryEnded = false;
      const span = Math.max(CFXR_TRAJECTORY_AGE_EPS, termination.firstAbsentAge - last.age);
      const t = Math.max(0, Math.min(1, (age - last.age) / span));
      out.set(
        last.position[0] + (termination.position[0] - last.position[0]) * t,
        last.position[1] + (termination.position[1] - last.position[1]) * t,
        last.position[2] + (termination.position[2] - last.position[2]) * t,
      );
      this.applyRotation(particle, last, last, 0);
      this.applyVisualState(particle, last, last, 0);
      this.applyRendererVelocity(particle, samples, samples.length - 1);
      return true;
    }
    if (!termination && age > last.age + this.sampleEpsilon) {
      // Legacy @4/@5 compatibility. New exports are forbidden to infer death this way.
      particle.unityTrajectoryEnded = true;
      particle.color.w = 0;
      out.fromArray(last.position);
      return true;
    }
    if (age >= last.age) {
      particle.unityTrajectoryEnded = false;
      out.fromArray(last.position);
      this.applyRotation(particle, last, last, 0);
      this.applyVisualState(particle, last, last, 0);
      this.applyRendererVelocity(particle, samples, samples.length - 1);
      return true;
    }
    let lo = 0, hi = samples.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid].age <= age) lo = mid;
      else hi = mid;
    }
    const a = samples[lo], b = samples[hi];
    particle.unityTrajectoryEnded = false;
    const t = Math.max(0, Math.min(1, (age - a.age) / Math.max(CFXR_TRAJECTORY_AGE_EPS, b.age - a.age)));
    out.set(
      a.position[0] + (b.position[0] - a.position[0]) * t,
      a.position[1] + (b.position[1] - a.position[1]) * t,
      a.position[2] + (b.position[2] - a.position[2]) * t,
    );
    this.applyRotation(particle, a, b, t);
    this.applyVisualState(particle, a, b, t);
    if (t <= CFXR_TRAJECTORY_VELOCITY_BLEND_EPS) this.applyRendererVelocity(particle, samples, lo);
    else if (t >= 1 - CFXR_TRAJECTORY_VELOCITY_BLEND_EPS) this.applyRendererVelocity(particle, samples, hi);
    else particle.velocity.set(
      (b.position[0] - a.position[0]) / Math.max(CFXR_TRAJECTORY_AGE_EPS, b.age - a.age),
      (b.position[1] - a.position[1]) / Math.max(CFXR_TRAJECTORY_AGE_EPS, b.age - a.age),
      (b.position[2] - a.position[2]) / Math.max(CFXR_TRAJECTORY_AGE_EPS, b.age - a.age),
    );
    return true;
  }
  initialize(particle: UnitySemanticParticle): void {
    particle.unityTrajectoryEnded = false;
    this.sample(particle, particle.age, particle.position);
  }
  update(particle: UnitySemanticParticle, delta: number): void {
    if (!this.sample(particle, particle.age + Math.max(0, delta), this.target)) return;
    // applyVisualState has already restored Unity's sampled instantaneous velocity. Never replace
    // it with a position finite-difference: the renderer observes velocity after all native
    // velocity/limit modules, while that difference is merely an interval average.
    particle.position.copy(this.target);
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() {
    const tracks = [...this.tracks].map(([particleId, track]) => ({ particleId, ...track }));
    return new UnityTrajectoryCacheBehavior({
      schema: 'particle-trajectory-cache@6', sampleRate: 60, space: 'world', tracks,
    });
  }
  reset(): void {}
}
