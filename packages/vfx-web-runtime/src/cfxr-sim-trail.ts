/**
 * Unity Trail module semantics / geometry-backed ribbon lowering.
 */
import {
  ColorGeneratorFromJSON,
  ValueGeneratorFromJSON,
  Vector3 as QuarksVector3,
  Vector4 as CoreVector4,
  type Behavior,
  type IParticleSystem,
  type Particle,
} from 'three.quarks';
import type {
  UnityTrailGeometry,
  UnityTrailSemantics,
} from './cfxr-sim-trail-geometry';

export type {
  UnityTrailGeometry,
  UnityTrailSemantics,
} from './cfxr-sim-trail-geometry';
export { decodeUnityTrailGeometry } from './cfxr-sim-trail-geometry';

/** Trail lifetime sample domain epsilon when system.duration is 0. */
export const CFXR_TRAIL_SYSTEM_DURATION_EPS = 1e-6;
/** When sizeAffectsLifetime is false, trail lifetime scale identity. */
export const CFXR_TRAIL_SIZE_LIFETIME_MUL_IDENTITY = 1;
/** Width scale identity when sizeAffectsWidth is false. */
export const CFXR_TRAIL_SIZE_WIDTH_MUL_IDENTITY = 1;
/** History / time compare slack for trail ribbon updates. */
export const CFXR_TRAIL_TIME_COMPARE_EPS = 1e-7;
/** Age normalize epsilon when particle.life is tiny. */
export const CFXR_TRAIL_PARTICLE_LIFE_EPS = 1e-6;

export class UnityTrailSemanticsBehavior implements Behavior {
  type = 'UnityTrailSemantics';
  private width: any;
  private lifetimeColor: any;
  private trailColor: any;
  private trailLifetime: any | null;
  private bases = new WeakMap<object, {
    size: number; color: [number, number, number, number];
  }>();
  private lifetimeSeconds = new WeakMap<object, number>();
  private patchedUpdates = new WeakSet<object>();
  private system?: IParticleSystem;
  private sampledLifetime = new CoreVector4(1, 1, 1, 1);
  private sampledTrail = new CoreVector4(1, 1, 1, 1);

  constructor(
    private semantics: UnityTrailSemantics,
    private geometry?: UnityTrailGeometry,
  ) {
    if (typeof semantics.sizeAffectsWidth !== 'boolean') {
      throw new Error('unity-trail-semantics: sizeAffectsWidth required (no invent)');
    }
    if (typeof semantics.sizeAffectsLifetime !== 'boolean') {
      throw new Error('unity-trail-semantics: sizeAffectsLifetime required (no invent)');
    }
    if (typeof semantics.inheritParticleColor !== 'boolean') {
      throw new Error('unity-trail-semantics: inheritParticleColor required (no invent)');
    }
    if (typeof semantics.dieWithParticles !== 'boolean') {
      throw new Error('unity-trail-semantics: dieWithParticles required (no invent)');
    }
    if (semantics.widthOverTrail == null) {
      throw new Error('unity-trail-semantics: widthOverTrail required (no invent)');
    }
    if (semantics.colorOverLifetime == null) {
      throw new Error('unity-trail-semantics: colorOverLifetime required (no invent)');
    }
    if (semantics.colorOverTrail == null) {
      throw new Error('unity-trail-semantics: colorOverTrail required (no invent)');
    }
    this.width = ValueGeneratorFromJSON(semantics.widthOverTrail);
    this.lifetimeColor = ColorGeneratorFromJSON(semantics.colorOverLifetime);
    this.trailColor = ColorGeneratorFromJSON(semantics.colorOverTrail);
    this.trailLifetime = semantics.lifetime ? ValueGeneratorFromJSON(semantics.lifetime) : null;
    if (!this.trailLifetime) {
      throw new Error('unity-trail-semantics: lifetime required (no invent)');
    }
  }
  initialize(particle: Particle, system?: IParticleSystem) {
    if (system) this.system = system;
    this.width.startGen(particle.memory);
    this.lifetimeColor.startGen(particle.memory);
    this.trailColor.startGen(particle.memory);
    if (this.trailLifetime) {
      this.trailLifetime.startGen(particle.memory);
      const systemT = system
        ? system.emissionState.time / Math.max(system.duration, CFXR_TRAIL_SYSTEM_DURATION_EPS)
        : 0;
      const value = this.trailLifetime.genValue(particle.memory, systemT);
      const sizeMul = this.semantics.sizeAffectsLifetime
        ? Math.max(0, particle.startSize.x)
        : CFXR_TRAIL_SIZE_LIFETIME_MUL_IDENTITY;
      this.lifetimeSeconds.set(particle, Math.max(0, value * sizeMul));
    }
    if (this.geometry) {
      const trail = particle as Particle & { update?: () => void };
      trail.update = () => {};
      this.patchedUpdates.add(particle);
    } else if (this.semantics.schema === 'unity-trail-semantics@2') {
      this.installExactHistoryUpdate(particle);
    }
  }
  private installExactHistoryUpdate(particle: Particle) {
    const trail = particle as Particle & {
      previous?: {
        length: number;
        clear(): void;
        front(): any;
        back(): any;
        dequeue(): any;
        pop(): any;
        push(value: any): void;
      };
      update?: () => void;
    };
    if (!trail.previous || this.patchedUpdates.has(particle)) return;
    this.patchedUpdates.add(particle);
    const semantics = this.semantics;
    const lifetimeOf = () => {
      const lifetime = this.lifetimeSeconds.get(particle);
      if (typeof lifetime !== 'number') {
        throw new Error('unity-trail-semantics: per-particle lifetime missing (no invent)');
      }
      return lifetime;
    };
    trail.update = () => {
      const history = trail.previous!;
      const now = particle.age;
      const lifetime = lifetimeOf();
      if (particle.age <= particle.life) {
        const priorHead = history.back();
        if (priorHead?.unityLiveHead) history.pop();
        const committed = history.back();
        const point = {
          position: particle.position.clone(),
          size: particle.size.x,
          color: particle.color.clone(),
          unityRecordedAt: now,
          unityLiveHead: false,
        };
        const minDistance = (() => {
          if (typeof semantics.minVertexDistance !== 'number') {
            throw new Error('unity-trail-semantics: minVertexDistance required (no invent)');
          }
          return Math.max(0, semantics.minVertexDistance);
        })();
        if (committed && committed.position.distanceTo(point.position) < minDistance) {
          // Keep an uncommitted live head without moving the last accepted anchor.
          // This gives Unity's moving endpoint while minVertexDistance controls topology.
          point.unityLiveHead = true;
        }
        history.push(point);
      } else if (semantics.dieWithParticles) {
        history.clear();
      }
      while (history.length > 0) {
        const oldest = history.front();
        if (typeof oldest?.unityRecordedAt !== 'number') {
          throw new Error('unity-trail-semantics: history unityRecordedAt required (no invent)');
        }
        const recordedAt = oldest.unityRecordedAt;
        if (now - recordedAt <= lifetime + CFXR_TRAIL_TIME_COMPARE_EPS) break;
        history.dequeue();
      }
    };
  }
  update(particle: Particle) {
    // three.quarks may bundle a distinct quarks.core class identity in optimized builds;
    // the IR contract is structural, so do not gate semantics on instanceof.
    const trail = particle as Particle & { previous?: { length: number; clear(): void; values(): Iterator<any> }; length?: number };
    if (!trail.previous || typeof trail.length !== 'number') return;
    if (this.geometry) return;
    if (this.semantics.dieWithParticles && particle.age >= particle.life) {
      trail.previous.clear();
      return;
    }
    const values = trail.previous.values();
    for (let i = 0; i < trail.previous.length; i++) {
      const state = values.next().value as any;
      if (!state) continue;
      let base = this.bases.get(state);
      if (!base) {
        base = {
          size: state.size,
          color: [state.color.x, state.color.y, state.color.z, state.color.w],
        };
        this.bases.set(state, base);
      }
      // Quarks orders history oldest→newest. Unity width/color curves use 1 at the
      // oldest tail and 0 at the live head, matching WidthOverLength's convention.
      const t = Math.min(1, Math.max(0,
        (trail.previous.length - 1 - i) / Math.max(1, trail.previous.length - 1),
      ));
      const width = this.width.genValue(particle.memory, t);
      state.size = (
        this.semantics.sizeAffectsWidth ? base.size : CFXR_TRAIL_SIZE_WIDTH_MUL_IDENTITY
      ) * width;
      // Unity TrailModule.colorOverLifetime is evaluated once from the owning
      // particle's normalized lifetime and multiplies every point in that ribbon.
      // colorOverTrail is the separate head→tail spatial gradient below.
      const ageT = Math.min(
        1,
        Math.max(0, particle.age / Math.max(particle.life, CFXR_TRAIL_PARTICLE_LIFE_EPS)),
      );
      this.lifetimeColor.genColor(particle.memory, this.sampledLifetime, ageT);
      this.trailColor.genColor(particle.memory, this.sampledTrail, t);
      const cr = this.sampledLifetime.x * this.sampledTrail.x;
      const cg = this.sampledLifetime.y * this.sampledTrail.y;
      const cb = this.sampledLifetime.z * this.sampledTrail.z;
      const ca = this.sampledLifetime.w * this.sampledTrail.w;
      if (this.semantics.inheritParticleColor) {
        state.color.set(
          base.color[0] * cr, base.color[1] * cg,
          base.color[2] * cb, base.color[3] * ca,
        );
      } else {
        state.color.set(cr, cg, cb, ca);
      }
    }
  }
  frameUpdate() {
    if (!this.geometry || !this.system || !this.geometry.frames.length) return;
    const time = this.system.emissionState.time;
    let frame = this.geometry.frames[0];
    for (const candidate of this.geometry.frames) {
      frame = candidate;
      if (candidate.time >= time - CFXR_TRAIL_TIME_COMPARE_EPS) break;
    }
    const particles = this.system.particles as Array<Particle & {
      previous?: { clear(): void; push(value: any): void };
    }>;
    const assigned = new Set<number>();
    for (let trailIndex = 0; trailIndex < frame.trails.length; trailIndex++) {
      const points = frame.trails[trailIndex] ?? [];
      if (points.length < 2) continue;
      let targetIndex = -1;
      let nearest = Infinity;
      const boundSeed = frame.trailSeeds?.[trailIndex];
      if (boundSeed != null && boundSeed !== 0xffffffff) {
        for (let i = 0; i < this.system.particleNum; i++) {
          if (assigned.has(i) || !particles[i]?.previous) continue;
          if ((particles[i] as Particle & { unitySeed?: number }).unitySeed === boundSeed) {
            targetIndex = i;
            nearest = 0;
            break;
          }
        }
      }
      // BakeTrailsMesh emits connected ribbons in topology order, while Quarks stores
      // TrailParticles in pool order. Match by the live-head position instead of assuming the
      // two orderings are identical; particle identities can change whenever a trail dies.
      const head = points[points.length - 1];
      const hp = Array.isArray(head)
        ? head
        : [head.position[0], head.position[1], head.position[2]];
      for (let i = 0; targetIndex < 0 && i < this.system.particleNum; i++) {
        if (assigned.has(i) || !particles[i]?.previous) continue;
        const p = particles[i].position;
        const dx = p.x - hp[0], dy = p.y - hp[1], dz = p.z - hp[2];
        const distance = dx * dx + dy * dy + dz * dz;
        if (distance < nearest) { nearest = distance; targetIndex = i; }
      }
      // A trail component without a live owning particle is already dead in Unity. Do not
      // attach it to an arbitrary pool slot: that creates long phantom ribbons at unrelated
      // positions when particle order changes across a loop boundary.
      if (targetIndex < 0 || nearest > 0.25 * 0.25) continue;
      assigned.add(targetIndex);
      const history = particles[targetIndex].previous!;
      history.clear();
      for (const point of points) {
        const position = Array.isArray(point)
          ? [point[0], point[1], point[2]] as [number, number, number]
          : point.position;
        const localPosition = this.geometry?.space === 'world' && this.system && !this.system.worldSpace
          ? (this.system.emitter as any).worldToLocal(
            new QuarksVector3(position[0], position[1], position[2]),
          )
          : new QuarksVector3(position[0], position[1], position[2]);
        const width = Array.isArray(point) ? (point[3] ?? particles[targetIndex].size.x) : point.width;
        const color = Array.isArray(point)
          ? point.length >= 8
            ? [point[4]!, point[5]!, point[6]!, point[7]!] as [number, number, number, number]
            : point.length >= 5
              ? [particles[targetIndex].color.x, particles[targetIndex].color.y,
                particles[targetIndex].color.z, point[4]!]
            : [particles[targetIndex].color.x, particles[targetIndex].color.y,
              particles[targetIndex].color.z, particles[targetIndex].color.w]
          : point.color;
        history.push({
          position: localPosition,
          // Unity's baked strip and Quarks' analytic screen-space extrusion have different
          // edge-coverage conventions. This backend conversion is qualified once for the
          // renderer pair (not per effect) and remains explicit in the geometry adapter.
          size: width * 0.75,
          color: new CoreVector4(
            color[0], color[1], color[2], color[3],
          ),
        });
      }
    }
  }
  // A system loop is not a particle reset. Weak per-particle/per-point state is overwritten by
  // initialize() or collected naturally, while surviving trails must retain their histories.
  reset() {}
  clone() { return new UnityTrailSemanticsBehavior(this.semantics, this.geometry); }
  toJSON() { return { type: this.type, ...this.semantics }; }
}
