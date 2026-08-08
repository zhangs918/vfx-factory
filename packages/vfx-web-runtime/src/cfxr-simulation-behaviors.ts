/**
 * Unity→Quarks simulation behaviors mounted before batching.
 * No CFXR ubershader / scene-color inject dependency.
 *
 * Initial/trajectory/trail/sub-emitter/shape modules are imported directly by
 * mount cores — this file only owns particle behavior classes.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  Vector3 as QuarksVector3,
  Quaternion as QuarksQuaternion,
  Euler as QuarksEuler,
  type Behavior,
  type IParticleSystem,
  type Particle,
} from 'three.quarks';
import {
  samplePiecewiseOrLinear,
  sampleSemanticCurve,
  UnityTwoCurvesGenerator,
  type UnityTwoCurvesSpec,
} from './cfxr-sim-curves';
import { findAuthoredEffectRoot } from './stage-presentation';

export { UnityTwoCurvesGenerator } from './cfxr-sim-curves';
export type { UnityTwoCurvesSpec } from './cfxr-sim-curves';

/** Non-TwoCurves velocity axis: no random lane factor (historical 0 invent). */
export const CFXR_VELOCITY_FACTOR_NON_TWO_CURVES = 0;
/** Age/life normalize epsilon (avoid div-by-zero invent). */
export const CFXR_PARTICLE_LIFE_EPS = 1e-5;
/** Limit-velocity early-out when speed is effectively zero. */
export const CFXR_LIMIT_VELOCITY_ZERO_EPS = 1e-8;

/** Shared Unity semantic particle fields stamped by calibrated mounts. */
export type UnitySemanticParticle = Particle & {
  unityCustom1?: [number, number, number, number];
  unityCustom2?: [number, number, number, number];
  unitySeed?: number;
  unityParticleId?: string;
  unitySizeCurveLerp?: number;
  unityRotationCurveLerp?: [number, number, number];
  unityRotationEuler?: [number, number, number];
  unityRotationBase?: QuarksQuaternion;
  unityGlobalSpawnTime?: number;
  unitySpawnAgeOffset?: number;
  unityBeforeGlobalSpawn?: boolean;
  unityTrajectoryEnded?: boolean;
  unityRendererFlip?: [boolean, boolean];
};

export class UnityColor32Behavior implements Behavior {
  type = 'UnityColor32';
  private quantize(particle: Particle) {
    particle.color.x = Math.round(Math.max(0, Math.min(1, particle.color.x)) * 255) / 255;
    particle.color.y = Math.round(Math.max(0, Math.min(1, particle.color.y)) * 255) / 255;
    particle.color.z = Math.round(Math.max(0, Math.min(1, particle.color.z)) * 255) / 255;
    particle.color.w = Math.round(Math.max(0, Math.min(1, particle.color.w)) * 255) / 255;
  }
  initialize(particle: Particle): void { this.quantize(particle); }
  update(particle: Particle): void { this.quantize(particle); }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityColor32Behavior(); }
  reset(): void {}
}

type UnityCustom1Particle = UnitySemanticParticle;

export class UnitySizeTwoCurvesBehavior implements Behavior {
  type = 'UnitySizeTwoCurves';
  constructor(private spec: UnityTwoCurvesSpec) {
    if (spec?.type !== 'UnityTwoCurves@1' || spec.min == null || spec.max == null
      || typeof spec.randomLane !== 'string' || !spec.randomLane) {
      throw new Error('UnitySizeTwoCurves: UnityTwoCurves@1 min/max/randomLane required (no invent)');
    }
  }
  initialize(): void {}
  update(particle: Particle, delta: number): void {
    const p = particle as UnitySemanticParticle;
    const t = Math.max(0, Math.min(1, p.age / Math.max(CFXR_PARTICLE_LIFE_EPS, p.life)));
    p.size.copy(p.startSize).multiplyScalar(sampleSemanticCurve(this.spec, t, p));
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnitySizeTwoCurvesBehavior(this.spec); }
  reset(): void {}
}

interface UnitySizeOverLifetimeSpec {
  schema: 'unity-size-over-lifetime@1';
  mode: 'scalar';
  curve: any;
}

export class UnitySizeOverLifetimeBehavior implements Behavior {
  type = 'UnitySizeOverLifetime';
  constructor(private readonly spec: UnitySizeOverLifetimeSpec) {
    if (spec?.mode !== 'scalar' || spec.curve == null) {
      throw new Error('UnitySizeOverLifetime: mode=scalar and curve required (no invent)');
    }
  }
  initialize(): void {}
  update(particle: Particle): void {
    const t = Math.max(0, Math.min(1, particle.age / Math.max(CFXR_PARTICLE_LIFE_EPS, particle.life)));
    particle.size.copy(particle.startSize).multiplyScalar(
      sampleSemanticCurve(this.spec.curve, t, particle as UnitySemanticParticle),
    );
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnitySizeOverLifetimeBehavior(this.spec); }
  reset(): void {}
}

interface UnityLimitVelocity3DSpec {
  schema: 'unity-limit-velocity-3d@1';
  x: any; y: any; z: any;
  dampen: number;
  space: 'local';
}

interface UnityLimitVelocitySpec {
  schema: 'unity-limit-velocity@1';
  speed: any;
  dampen: number;
}

export class UnityLimitVelocityBehavior implements Behavior {
  type = 'UnityLimitVelocity';
  constructor(private readonly spec: UnityLimitVelocitySpec) {
    if (spec.speed == null || typeof spec.dampen !== 'number') {
      throw new Error('UnityLimitVelocity: speed and dampen required (no invent)');
    }
  }
  initialize(): void {}
  update(particle: Particle, delta: number): void {
    const velocity = particle.velocity;
    const current = velocity.length();
    const t = Math.max(0, Math.min(1, particle.age / Math.max(CFXR_PARTICLE_LIFE_EPS, particle.life)));
    const limit = Math.max(0, sampleSemanticCurve(this.spec.speed, t, particle as UnitySemanticParticle));
    if (current <= limit || current <= CFXR_LIMIT_VELOCITY_ZERO_EPS) return;
    // Unity normalizes this legacy module's damping response to a 30 Hz simulation clock.
    // Keep the authored response invariant when the Web player advances with another fixed dt.
    const authoredDampen = Math.max(0, Math.min(1, this.spec.dampen));
    const dampen = 1 - Math.pow(1 - authoredDampen, Math.max(0, delta) * 30);
    const targetScale = limit / current;
    velocity.multiplyScalar(1 + (targetScale - 1) * dampen);
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityLimitVelocityBehavior(this.spec); }
  reset(): void {}
}

export class UnityLimitVelocity3DBehavior implements Behavior {
  type = 'UnityLimitVelocity3D';
  constructor(private readonly spec: UnityLimitVelocity3DSpec) {
    if (spec.x == null || spec.y == null || spec.z == null
      || typeof spec.dampen !== 'number' || spec.space !== 'local') {
      throw new Error('UnityLimitVelocity3D: x/y/z, dampen, space=local required (no invent)');
    }
  }
  initialize(): void {}
  update(particle: Particle): void {
    const t = Math.max(0, Math.min(1, particle.age / Math.max(CFXR_PARTICLE_LIFE_EPS, particle.life)));
    const p = particle as UnitySemanticParticle;
    const limits = [this.spec.x, this.spec.y, this.spec.z].map((curve) =>
      Math.max(0, sampleSemanticCurve(curve, t, p)));
    const velocity = particle.velocity;
    const values = [velocity.x, velocity.y, velocity.z];
    const dampen = Math.max(0, Math.min(1, this.spec.dampen));
    for (let axis = 0; axis < 3; axis++) {
      const current = values[axis];
      const limit = limits[axis];
      if (Math.abs(current) > limit)
        values[axis] = current + (Math.sign(current) * limit - current) * dampen;
    }
    velocity.set(values[0], values[1], values[2]);
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityLimitVelocity3DBehavior(this.spec); }
  reset(): void {}
}

interface UnityVelocityOverLifetimeSpec {
  schema: 'unity-velocity-over-lifetime@1';
  linearX: any; linearY: any; linearZ: any;
  space: 'local' | 'world';
}

export class UnityVelocityOverLifetimeBehavior implements Behavior {
  type = 'UnityVelocityOverLifetime';
  private states = new WeakMap<object, { factors: number[]; offset: QuarksVector3 }>();
  private ps?: IParticleSystem;
  private rotation = new QuarksQuaternion();
  private scale = new QuarksVector3(1, 1, 1);
  private scratch = new QuarksVector3();
  private readonly relativeMatrix = new Matrix4();
  private readonly invAuthoredWorld = new Matrix4();
  private readonly decomposePosition = new Vector3();
  private readonly decomposeRotation = new Quaternion();
  private readonly decomposeScale = new Vector3();
  constructor(private readonly spec: UnityVelocityOverLifetimeSpec) {
    if (spec.space !== 'local' && spec.space !== 'world') {
      throw new Error('UnityVelocityOverLifetime: space required (no invent)');
    }
    if (spec.linearX == null || spec.linearY == null || spec.linearZ == null) {
      throw new Error('UnityVelocityOverLifetime: linearX/Y/Z required (no invent)');
    }
  }
  initialize(particle: Particle, system: IParticleSystem): void {
    this.ps = system;
    const curves = [this.spec.linearX, this.spec.linearY, this.spec.linearZ];
    this.states.set(particle as object, {
      factors: curves.map((curve) => (
        curve?.type === 'UnityTwoCurves@1' ? Math.random() : CFXR_VELOCITY_FACTOR_NON_TWO_CURVES
      )),
      offset: new QuarksVector3(),
    });
  }
  private sample(curve: any, t: number, factor: number): number {
    if (curve?.type !== 'UnityTwoCurves@1') return samplePiecewiseOrLinear(curve, t);
    const min = samplePiecewiseOrLinear(curve.min, t);
    const max = samplePiecewiseOrLinear(curve.max, t);
    return min + (max - min) * factor;
  }
  private captureEmitterBasis(emitter: { matrixWorld: Matrix4 }, authoredRelative: boolean) {
    if (authoredRelative) {
      const authoredRoot = findAuthoredEffectRoot(emitter as any);
      this.invAuthoredWorld.copy(authoredRoot.matrixWorld).invert();
      this.relativeMatrix.multiplyMatrices(this.invAuthoredWorld, emitter.matrixWorld);
      this.relativeMatrix.decompose(
        this.decomposePosition,
        this.decomposeRotation,
        this.decomposeScale,
      );
    } else {
      emitter.matrixWorld.decompose(
        this.decomposePosition,
        this.decomposeRotation,
        this.decomposeScale,
      );
    }
    this.rotation.set(
      this.decomposeRotation.x,
      this.decomposeRotation.y,
      this.decomposeRotation.z,
      this.decomposeRotation.w,
    );
    this.scale.set(this.decomposeScale.x, this.decomposeScale.y, this.decomposeScale.z);
  }
  frameUpdate(): void {
    const emitter = (this.ps as any)?.emitter;
    if (!emitter) return;
    const systemWorld = !!this.ps?.worldSpace;
    // Local VOL on a world-space system must land in scene/world (includes host
    // stage tilt). World VOL on a local system must stay in effect-authored
    // world — never let player.root -90° redefine Unity +Y.
    this.captureEmitterBasis(emitter, this.spec.space === 'world' && !systemWorld);
  }
  update(particle: Particle): void {
    const state = this.states.get(particle as object);
    if (!state) return;
    const t = Math.max(0, Math.min(1, particle.age / Math.max(CFXR_PARTICLE_LIFE_EPS, particle.life)));
    const next = this.scratch.set(
      this.sample(this.spec.linearX, t, state.factors[0]),
      this.sample(this.spec.linearY, t, state.factors[1]),
      // Unity LH -> Web RH vector reflection.
      -this.sample(this.spec.linearZ, t, state.factors[2]),
    );
    const systemWorld = !!this.ps?.worldSpace;
    if (this.spec.space === 'local' && systemWorld) next.multiply(this.scale).applyQuaternion(this.rotation);
    else if (this.spec.space === 'world' && !systemWorld) {
      next.applyQuaternion(this.rotation.clone().invert());
      next.set(next.x / this.scale.x, next.y / this.scale.y, next.z / this.scale.z);
    }
    particle.velocity.sub(state.offset).add(next);
    state.offset.copy(next);
  }
  toJSON() { return { type: this.type }; }
  clone() { return new UnityVelocityOverLifetimeBehavior(this.spec); }
  // System loop resets emission generators while particles from the previous cycle remain
  // alive. Their velocity offset state must survive; initialize() overwrites it when a pooled
  // particle is genuinely reused.
  reset(): void {}
}

interface UnityRotation3DSpec { x: any; y: any; z: any }

/** Integrates Unity separate-axis angular velocity on mesh-particle quaternions. */
export class UnityRotation3DBehavior implements Behavior {
  type = 'UnityRotationOverLifetime3D';
  constructor(private spec: UnityRotation3DSpec) {
    if (spec.x == null || spec.y == null || spec.z == null) {
      throw new Error('UnityRotationOverLifetime3D: x/y/z required (no invent)');
    }
  }
  initialize(): void {}
  update(particle: Particle, delta: number): void {
    const rotation = particle.rotation;
    if (delta === 0 || typeof rotation === 'number' || !rotation) return;
    const p = particle as UnitySemanticParticle;
    const t = Math.max(0, Math.min(1, p.age / Math.max(CFXR_PARTICLE_LIFE_EPS, p.life)));
    // Unity left-handed angular vector -> right-handed quaternion coordinates.
    const x = -sampleSemanticCurve(this.spec.x, t, p) * delta;
    const y = -sampleSemanticCurve(this.spec.y, t, p) * delta;
    const z = sampleSemanticCurve(this.spec.z, t, p) * delta;
    // Per-particle Euler accumulator — initialize once, do not invent authored state.
    if (!p.unityRotationEuler) p.unityRotationEuler = [0, 0, 0];
    const euler = p.unityRotationEuler;
    euler[0] += x;
    euler[1] += y;
    euler[2] += z;
    // Unity stores independent Euler channels and reconstructs with intrinsic ZXY. The
    // equivalent quarks/three order is YXZ after the LH→RH axis reflection.
    const local = new QuarksQuaternion()
      .setFromEuler(new QuarksEuler(euler[0], euler[1], euler[2], 'YXZ'))
      .normalize();
    if (p.unityRotationBase) rotation.copy(p.unityRotationBase).multiply(local).normalize();
    else rotation.copy(local);
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityRotation3DBehavior(this.spec); }
  reset(): void {}
}

/** Exact Unity Custom1 vertex stream: four independent lifetime curves per particle. */
export class UnityCustom1Behavior implements Behavior {
  type = 'UnityCustom1';
  constructor(private curves: [any, any, any, any]) {
    if (!Array.isArray(curves) || curves.length !== 4 || curves.some((curve) => curve == null)) {
      throw new Error('UnityCustom1: four curves required (no invent)');
    }
  }
  private apply(particle: UnityCustom1Particle) {
    const t = Math.max(0, Math.min(1, particle.age / Math.max(CFXR_PARTICLE_LIFE_EPS, particle.life)));
    particle.unityCustom1 = this.curves.map((curve) =>
      sampleSemanticCurve(curve, t, particle as UnitySemanticParticle)) as [number, number, number, number];
  }
  initialize(particle: Particle): void { this.apply(particle); }
  update(particle: Particle, delta: number): void {
    // Preserve Unity's vertex-stream phase on the terminal zero-delta pass. Regression oracles
    // confirm that the authored custom-data stream aligns with Quarks' pre-increment age here.
    if (delta !== 0) this.apply(particle);
  }
  frameUpdate(): void {}
  toJSON() { return { type: this.type }; }
  clone() { return new UnityCustom1Behavior(this.curves); }
  reset(): void {}
}

/** Random sheet tile when FrameOverLife used IntervalValue (quarks only applies PiecewiseBezier). */
class CfxrRandomTileBehavior implements Behavior {
  type = 'CfxrRandomTile';
  constructor(private maxTile: number) {
    if (!(typeof maxTile === 'number' && maxTile > 0)) {
      throw new Error('CfxrRandomTile: maxTile > 0 required (no invent)');
    }
  }
  initialize(particle: Particle): void {
    particle.uvTile = Math.floor(Math.random() * this.maxTile);
  }
  update(): void {}
  frameUpdate(): void {}
  toJSON() {
    return { type: this.type };
  }
  clone() {
    return new CfxrRandomTileBehavior(this.maxTile);
  }
  reset(): void {}
}

/**
 * Unity Texture Sheet Animation:
 * finalFrame = startFrame + frameOverTime(age) * cycleCount, wrapped by sheet size.
 * Quarks' stock FrameOverLife overwrites startFrame and ignores non-Bezier generators,
 * so random start frames and constant frame offsets select the wrong atlas cell.
 */
export class UnityFrameOverLifeBehavior implements Behavior {
  type = 'UnityFrameOverLife';
  private startTiles = new WeakMap<object, number>();
  private startOffsets = new WeakMap<object, number>();
  /** Thin / stamped initial-state: refuse age fallback for lifetime mode. */
  private requireSpawnAgeOffset: boolean;

  constructor(
    private frame: {
      startGen: (memory: unknown) => void;
      genValue: (memory: unknown, t?: number) => number;
      clone?: () => UnityFrameOverLifeBehavior['frame'];
    },
    private tileCount: number,
    private timeMode: 'lifetime' | 'speed',
    private speedRange: [number, number],
    /** Unity SingleRow: frame advances inside X while the selected Y row stays fixed. */
    private singleRow?: { columns: number; rows: number; rowIndex: number; randomRow: boolean },
    options?: { requireSpawnAgeOffset?: boolean },
  ) {
    if (!frame?.startGen || !frame?.genValue) {
      throw new Error('UnityFrameOverLife: frame generator required (no invent)');
    }
    if (!(typeof tileCount === 'number' && tileCount > 0)) {
      throw new Error('UnityFrameOverLife: tileCount > 0 required (no invent)');
    }
    if (timeMode !== 'lifetime' && timeMode !== 'speed') {
      throw new Error('UnityFrameOverLife: timeMode required (no invent)');
    }
    if (!Array.isArray(speedRange) || speedRange.length !== 2
      || typeof speedRange[0] !== 'number' || typeof speedRange[1] !== 'number') {
      throw new Error('UnityFrameOverLife: speedRange[2] required (no invent)');
    }
    if (singleRow) {
      if (!(typeof singleRow.columns === 'number' && singleRow.columns > 0)
        || !(typeof singleRow.rows === 'number' && singleRow.rows > 0)
        || typeof singleRow.rowIndex !== 'number'
        || typeof singleRow.randomRow !== 'boolean') {
        throw new Error('UnityFrameOverLife: singleRow columns/rows/rowIndex/randomRow required (no invent)');
      }
    }
    this.requireSpawnAgeOffset = !!options?.requireSpawnAgeOffset;
  }

  private apply(particle: Particle, t: number) {
    const start = this.startTiles.get(particle as object);
    if (typeof start !== 'number') {
      throw new Error('UnityFrameOverLife: start tile missing (no invent)');
    }
    const startOffset = this.startOffsets.get(particle as object);
    if (typeof startOffset !== 'number') {
      throw new Error('UnityFrameOverLife: start offset missing (no invent)');
    }
    // Frame curves can yield sub-ULP gen vs startOffset at birth (t≈0). A tiny
    // negative offset then wraps via `% columns` to ~columns (e.g. 6.999→7 on a
    // 7-wide single-row sheet) and picks the wrong atlas cell vs thick/Unity.
    let offset = this.frame.genValue(particle.memory, t) - startOffset;
    if (Math.abs(offset) < 1e-6) offset = 0;
    const total = this.tileCount;
    if (this.singleRow) {
      const columns = this.singleRow.columns;
      const rowBase = Math.floor(start / columns) * columns;
      let column = start % columns + offset;
      column -= columns * Math.floor(column / columns);
      if (column < 0) column += columns;
      if (column >= columns - 1e-6) column = 0;
      particle.uvTile = rowBase + column;
      return;
    }
    let tile = start + offset;
    tile -= total * Math.floor(tile / total);
    if (tile < 0) tile += total;
    if (tile >= total - 1e-6) tile = 0;
    particle.uvTile = tile;
  }

  initialize(particle: Particle): void {
    let start = particle.uvTile;
    if (this.singleRow) {
      const columns = this.singleRow.columns;
      const rows = this.singleRow.rows;
      const semantic = particle as UnitySemanticParticle;
      // Calibrated initial-state already encodes Unity's random-row choice in uvTile
      // (e.g. frame 0 → row 0, frame 7 → row 1 on a 7×2 sheet). Re-rolling via
      // Math.random() desyncs thick vs thin when their seeded RNG streams diverge.
      const calibratedBirth = typeof semantic.unityParticleId === 'string'
        && semantic.unityParticleId !== '';
      const row = this.singleRow.randomRow
        ? (calibratedBirth
          ? Math.max(0, Math.min(rows - 1, Math.floor(start / columns)))
          : Math.floor(Math.random() * rows))
        : Math.max(0, Math.min(rows - 1, this.singleRow.rowIndex));
      // Start frame is normalized within the selected row, never over all atlas cells.
      start = row * columns + ((start % columns) + columns) % columns;
    }
    this.startTiles.set(particle as object, start);
    this.frame.startGen(particle.memory);
    const initialT = this.timeMode === 'speed'
      ? (particle.velocity.length() - this.speedRange[0])
        / Math.max(CFXR_PARTICLE_LIFE_EPS, this.speedRange[1] - this.speedRange[0])
      : (() => {
        const spawnAge = (particle as UnitySemanticParticle).unitySpawnAgeOffset;
        if (typeof spawnAge === 'number') return spawnAge;
        if (this.requireSpawnAgeOffset) {
          throw new Error('UnityFrameOverLife: unitySpawnAgeOffset required (no age invent)');
        }
        return particle.age;
      })()
        / Math.max(CFXR_PARTICLE_LIFE_EPS, particle.life);
    this.startOffsets.set(
      particle as object,
      this.frame.genValue(particle.memory, Math.max(0, Math.min(1, initialT))),
    );
    this.apply(particle, Math.max(0, Math.min(1, initialT)));
  }

  update(particle: Particle): void {
    const t = this.timeMode === 'speed'
      ? (particle.velocity.length() - this.speedRange[0])
        / Math.max(CFXR_PARTICLE_LIFE_EPS, this.speedRange[1] - this.speedRange[0])
      : particle.age / Math.max(CFXR_PARTICLE_LIFE_EPS, particle.life);
    this.apply(particle, Math.max(0, Math.min(1, t)));
  }

  frameUpdate(): void {}
  toJSON() {
    return { type: this.type };
  }
  clone() {
    return new UnityFrameOverLifeBehavior(
      this.frame.clone?.() ?? this.frame,
      this.tileCount,
      this.timeMode,
      [...this.speedRange],
      this.singleRow && { ...this.singleRow },
      { requireSpawnAgeOffset: this.requireSpawnAgeOffset },
    );
  }
  // Preserve start-frame identity for particles draining across a system loop boundary.
  reset(): void {}
}
