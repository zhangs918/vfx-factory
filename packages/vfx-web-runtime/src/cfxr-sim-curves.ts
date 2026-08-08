/**
 * Shared Unity MinMaxCurve / AnimationCurve sampling for Quarks behaviors.
 * Leaf module: no mount / inject / runtime-state dependency.
 */
import type {
  FunctionValueGenerator,
  GeneratorMemory,
  Particle,
} from 'three.quarks';

/** Unity AnimationCurve unweighted tangent → cubic Bezier control (standard 1/3). */
export const CFXR_ANIM_CURVE_UNWEIGHTED_BEZIER_WEIGHT = 1 / 3;
/** Key time / segment domain denominators. */
export const CFXR_ANIM_CURVE_TIME_EPS = 1e-7;
export const CFXR_ANIM_CURVE_KEYFRAME_T_EPS = 1e-5;
export const CFXR_ANIM_CURVE_SEGMENT_EPS = 1e-6;

export type UnityCurveParticle = Particle & {
  unitySeed?: number;
  unitySizeCurveLerp?: number;
  unityRotationCurveLerp?: [number, number, number];
};

export interface UnityTwoCurvesSpec {
  type: 'UnityTwoCurves@1';
  min: any;
  max: any;
  randomLane: string;
}

export function samplePiecewiseOrLinear(curve: any, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  if (!curve) {
    throw new Error('samplePiecewiseOrLinear: curve required (no invent)');
  }
  if (curve.type === 'ConstantValue') {
    if (typeof curve.value !== 'number') {
      throw new Error('samplePiecewiseOrLinear: ConstantValue.value required (no invent)');
    }
    return curve.value;
  }
  if (curve.type === 'IntervalValue') {
    if (typeof curve.a !== 'number' || typeof curve.b !== 'number') {
      throw new Error('samplePiecewiseOrLinear: IntervalValue.a/b required (no invent)');
    }
    return curve.a + (curve.b - curve.a) * u;
  }
  if (curve.type === 'UnityAnimationCurve@1' && Array.isArray(curve.keys)) {
    const keys = curve.keys as Array<{
      time: number; value: number; inTangent: number; outTangent: number;
      inWeight: number; outWeight: number; weightedMode: number;
    }>;
    if (!keys.length) {
      throw new Error('samplePiecewiseOrLinear: UnityAnimationCurve@1.keys must be non-empty (no invent)');
    }
    for (const key of keys) {
      for (const field of ['time', 'value', 'inTangent', 'outTangent', 'inWeight', 'outWeight', 'weightedMode'] as const) {
        if (typeof key[field] !== 'number') {
          throw new Error(`samplePiecewiseOrLinear: UnityAnimationCurve@1.key.${field} required (no invent)`);
        }
      }
    }
    if (u <= keys[0].time) return keys[0].value;
    if (u >= keys[keys.length - 1].time) return keys[keys.length - 1].value;
    let right = 1;
    while (right < keys.length && u > keys[right].time) right++;
    const a = keys[right - 1], b = keys[right];
    const dt = Math.max(CFXR_ANIM_CURVE_TIME_EPS, b.time - a.time);
    const outWeighted = (a.weightedMode & 2) !== 0;
    const inWeighted = (b.weightedMode & 1) !== 0;
    const x0 = a.time, x3 = b.time;
    const x1 = x0 + dt * (outWeighted ? a.outWeight : CFXR_ANIM_CURVE_UNWEIGHTED_BEZIER_WEIGHT);
    const x2 = x3 - dt * (inWeighted ? b.inWeight : CFXR_ANIM_CURVE_UNWEIGHTED_BEZIER_WEIGHT);
    const y0 = a.value, y3 = b.value;
    const y1 = y0 + a.outTangent * (x1 - x0);
    const y2 = y3 - b.inTangent * (x3 - x2);
    const bezier = (p0: number, p1: number, p2: number, p3: number, s: number) => {
      const o = 1 - s;
      return o * o * o * p0 + 3 * o * o * s * p1 + 3 * o * s * s * p2 + s * s * s * p3;
    };
    let lo = 0, hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) * 0.5;
      if (bezier(x0, x1, x2, x3, mid) < u) lo = mid; else hi = mid;
    }
    return bezier(y0, y1, y2, y3, (lo + hi) * 0.5);
  }
  // Keyframe list from inject: [{t,v},...]
  if (Array.isArray(curve.keys) && curve.keys.length) {
    const keys = curve.keys as { t: number; v: number }[];
    for (const key of keys) {
      if (typeof key.t !== 'number' || typeof key.v !== 'number') {
        throw new Error('samplePiecewiseOrLinear: keyframe t/v required (no invent)');
      }
    }
    if (u <= keys[0].t) return keys[0].v;
    for (let i = 1; i < keys.length; i++) {
      if (u <= keys[i].t) {
        const a = keys[i - 1];
        const b = keys[i];
        const s = (u - a.t) / Math.max(CFXR_ANIM_CURVE_KEYFRAME_T_EPS, b.t - a.t);
        return a.v + (b.v - a.v) * s;
      }
    }
    return keys[keys.length - 1].v;
  }
  if (curve.type === 'PiecewiseBezier' && Array.isArray(curve.functions)) {
    if (!curve.functions.length) {
      throw new Error('samplePiecewiseOrLinear: PiecewiseBezier.functions must be non-empty (no invent)');
    }
    for (const fn of curve.functions) {
      if (typeof fn?.start !== 'number') {
        throw new Error('samplePiecewiseOrLinear: PiecewiseBezier segment.start required (no invent)');
      }
    }
    let entry = curve.functions[0];
    for (let i = 1; i < curve.functions.length; i++) {
      if (curve.functions[i].start > u) break;
      entry = curve.functions[i];
    }
    const seg = entry?.function;
    if (!seg
      || typeof seg.p0 !== 'number' || typeof seg.p1 !== 'number'
      || typeof seg.p2 !== 'number' || typeof seg.p3 !== 'number') {
      throw new Error('samplePiecewiseOrLinear: PiecewiseBezier segment.function p0-p3 required (no invent)');
    }
    const { p0, p1, p2, p3 } = seg;
    const start = entry.start;
    const index = curve.functions.indexOf(entry);
    // PiecewiseBezier domain is [0,1]; last segment ends at 1 (Unity contract, not a soft invent).
    const end = index + 1 < curve.functions.length
      ? curve.functions[index + 1].start
      : 1;
    if (typeof end !== 'number' || !Number.isFinite(end)) {
      throw new Error('samplePiecewiseOrLinear: PiecewiseBezier segment end required (no invent)');
    }
    const local = Math.max(0, Math.min(1, (u - start) / Math.max(CFXR_ANIM_CURVE_SEGMENT_EPS, end - start)));
    const omt = 1 - local;
    return omt * omt * omt * p0 + 3 * omt * omt * local * p1
      + 3 * omt * local * local * p2 + local * local * local * p3;
  }
  if (curve.type) {
    throw new Error(`samplePiecewiseOrLinear: unsupported curve type '${curve.type}' (no invent)`);
  }
  throw new Error('samplePiecewiseOrLinear: unrecognized curve shape (no invent)');
}

function semanticRandom01(seed: number, lane: string): number {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < lane.length; i++) h = Math.imul(h ^ lane.charCodeAt(i), 0x85ebca6b);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return (h >>> 0) / 0x100000000;
}

export function sampleSemanticCurve(spec: any, t: number, particle: UnityCurveParticle): number {
  if (spec?.type !== 'UnityTwoCurves@1') return samplePiecewiseOrLinear(spec, t);
  if (spec.min == null || spec.max == null) {
    throw new Error('sampleSemanticCurve: TwoCurves min/max required (no invent)');
  }
  if (typeof spec.randomLane !== 'string' || !spec.randomLane) {
    throw new Error('sampleSemanticCurve: TwoCurves randomLane required (no invent)');
  }
  const factor = spec.randomLane === 'sizeOverLifetime.scalar'
    && particle.unitySizeCurveLerp != null
    ? particle.unitySizeCurveLerp
    : String(spec.randomLane).startsWith('rotationOverLifetime.')
      && particle.unityRotationCurveLerp
      ? particle.unityRotationCurveLerp[spec.randomLane.endsWith('.x') ? 0 : spec.randomLane.endsWith('.y') ? 1 : 2]
      : (() => {
        if (typeof particle.unitySeed !== 'number') {
          throw new Error('sampleSemanticCurve: unitySeed required for TwoCurves randomLane (no invent)');
        }
        return semanticRandom01(particle.unitySeed, spec.randomLane);
      })();
  const min = samplePiecewiseOrLinear(spec.min, t);
  const max = samplePiecewiseOrLinear(spec.max, t);
  return min + (max - min) * factor;
}

/** Unity MinMaxCurve.TwoCurves: one random interpolation factor is retained for the particle. */
export class UnityTwoCurvesGenerator implements FunctionValueGenerator {
  readonly type = 'function' as const;
  private indexCount = -1;
  constructor(private readonly spec: UnityTwoCurvesSpec) {
    if (spec?.type !== 'UnityTwoCurves@1' || spec.min == null || spec.max == null
      || typeof spec.randomLane !== 'string' || !spec.randomLane) {
      throw new Error('UnityTwoCurvesGenerator: UnityTwoCurves@1 min/max/randomLane required (no invent)');
    }
  }
  startGen(memory: GeneratorMemory) {
    this.indexCount = memory.length;
    memory.push(Math.random());
  }
  genValue(memory: GeneratorMemory, t: number): number {
    if (this.indexCount < 0) this.startGen(memory);
    const factor = memory[this.indexCount];
    if (typeof factor !== 'number') {
      throw new Error('UnityTwoCurvesGenerator: random factor missing from generator memory (no invent)');
    }
    const min = samplePiecewiseOrLinear(this.spec.min, t);
    const max = samplePiecewiseOrLinear(this.spec.max, t);
    return min + (max - min) * factor;
  }
  toJSON() { return this.spec as any; }
  clone() { return new UnityTwoCurvesGenerator(this.spec); }
}
