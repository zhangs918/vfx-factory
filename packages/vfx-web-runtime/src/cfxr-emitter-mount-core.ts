/**
 * Map-free Unity→Quarks emitter mounts. Thin and production supply different `pick`s.
 */
import {
  DoubleSide,
  MeshBasicMaterial,
  NoColorSpace,
  SRGBColorSpace,
  type Object3D,
} from 'three';
import {
  ParticleSystem,
  RenderMode,
  Vector3 as QuarksVector3,
  Quaternion as QuarksQuaternion,
  type Behavior,
  type IParticleSystem,
  type Particle,
  type ParticleEmitter,
} from 'three.quarks';
import { applyBakedBlendState, CFXR_TONE_MAPPED_OFF, type VfxPipelineBlendState } from './cfxr-blend-apply';
import {
  allowBehaviorMount,
  assertSameStringSet,
  readArtifactEmitterSim,
  type ArtifactEmitterSim,
} from './artifact-emitter-sim';
/**
 * Quarks stock material defaults used only when artifactBlendState is absent
 * (frozen / bridge rollback). Thin always requires a bake stamp instead.
 */
export const CFXR_QUARKS_STOCK_EARLY_BLEND = {
  transparent: true,
  depthWrite: false,
  toneMapped: CFXR_TONE_MAPPED_OFF,
} as const;

function applyQuarksStockEarlyBlend(mat: { transparent: boolean; depthWrite: boolean; toneMapped: boolean; side: number }) {
  mat.transparent = CFXR_QUARKS_STOCK_EARLY_BLEND.transparent;
  mat.depthWrite = CFXR_QUARKS_STOCK_EARLY_BLEND.depthWrite;
  mat.toneMapped = CFXR_QUARKS_STOCK_EARLY_BLEND.toneMapped;
  mat.side = DoubleSide;
}
import {
  UnityColor32Behavior,
  UnityCustom1Behavior,
  UnityFrameOverLifeBehavior,
  UnityLimitVelocity3DBehavior,
  UnityLimitVelocityBehavior,
  UnityRotation3DBehavior,
  UnitySizeOverLifetimeBehavior,
  UnitySizeTwoCurvesBehavior,
  UnityTwoCurvesGenerator,
  UnityVelocityOverLifetimeBehavior,
} from './cfxr-simulation-behaviors';
import {
  UnityGlobalAgeBehavior,
  UnityInitialStateBehavior,
  UnitySpawnVisibilityBehavior,
  UnityTrajectoryCacheBehavior,
} from './cfxr-sim-initial';
import {
  patchCalibratedBirthSubEmitters,
  patchChildDurationSubEmitters,
} from './cfxr-sim-subemitters';
import { UnityTrailSemanticsBehavior } from './cfxr-sim-trail';

/** Unity ShapeModule local transform applied before emitter.matrixWorld. */
type UnityShapeTransform = {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
};

function patchUnityShapeTransform(system: ParticleSystem, spec: UnityShapeTransform) {
  const shape = system.emitterShape as unknown as {
    initialize: (particle: Particle, emissionState: unknown) => void;
    __unityShapeTransform?: boolean;
  };
  if (!shape || shape.__unityShapeTransform) return;
  const original = shape.initialize.bind(shape);
  const position = new QuarksVector3(...spec.position);
  const rotation = new QuarksQuaternion(...spec.rotation);
  const scale = new QuarksVector3(...spec.scale);
  shape.initialize = (particle, emissionState) => {
    original(particle, emissionState);
    // Unity order inside ShapeModule: scale point, rotate point/direction, then translate.
    // This hook runs before Quarks applies emitter.matrixWorld, so it is exact for both Local
    // and World simulation spaces.
    particle.position.multiply(scale).applyQuaternion(rotation).add(position);
    particle.velocity.applyQuaternion(rotation);
  };
  shape.__unityShapeTransform = true;
}

export type CfxrEmitterMountSession = {
  emitter: ParticleEmitter;
  system: ParticleSystem;
  mat: MeshBasicMaterial & { userData: Record<string, unknown> };
  take: (mountId: string, apply: () => void) => void;
  tileCount: number;
  initialStates: any[] | undefined;
  /** Production inject pending props; thin leaves undefined. */
  props?: any;
  declaredMounts: string[] | undefined;
  finishMountAudit: () => void;
};

export type EmitterMountPick = (key: keyof ArtifactEmitterSim) => any;

/**
 * Unity Stretched Billboard (Shuriken):
 *   width  = size
 *   length = size × lengthScale + speed × velocityScale
 * Quarks non-SKEW shader receives `velocity * speedFactor` from SpriteBatch:
 *   length = (speed × speedFactor + lengthFactor) × avgSize
 */
export function remapUnityStretchToQuarks(
  system: ParticleSystem,
  remap: { speedFactor: number; lengthFactor: number },
) {
  const s = system.rendererEmitterSettings as { speedFactor?: number; lengthFactor?: number };
  // Hard-write offline bag values — do not preserve live Quarks invent/`??` defaults.
  s.speedFactor = remap.speedFactor;
  s.lengthFactor = remap.lengthFactor;
}

export function forEachCfxrEmitterMountCore(
  root: Object3D,
  applyMaterialPending: (session: CfxrEmitterMountSession) => void,
  options: {
    /** Every emitter must carry a stamped sim bag. */
    requireSim: boolean;
    /** Apply baked blend early (thin always; production when blendSource=artifact). */
    applyEarlyBlend: () => boolean;
    /**
     * When early blend is requested but `artifactBlendState` is missing, throw
     * instead of inventing Quarks stock defaults. Thin always requires.
     * Production relies on stamped-pipeline detection inside the mount core
     * (frozen/unstamped loads may still soft-invent).
     */
    requireEarlyBlend?: () => boolean;
    /**
     * Thin: every unityInitialState particle must carry offline rendererFlip +
     * custom1/custom2 (corpus stamps). Soft invent remains only for frozen
     * particles without unityDefault* (batch-stepper historical fallback).
     * Stream defaults install whenever the bag already carries them (prod+thin).
     */
    requireInitialStreamStamps?: boolean;
    /** Defaults to bag-only `sim?.[key]` (production stamps maps into bags first). */
    pick?: (args: {
      emitter: ParticleEmitter;
      sim: ArtifactEmitterSim | undefined;
    }) => EmitterMountPick;
    /** Production inject tail; thin omits (materials are offline-owned). */
    resolveProps?: (args: {
      emitter: ParticleEmitter;
      sim: ArtifactEmitterSim | undefined;
    }) => any;
    /** Defaults to bag `sim?.rendererPivot` (no invented fallback). */
    resolveRendererPivot?: (args: {
      emitter: ParticleEmitter;
      sim: ArtifactEmitterSim | undefined;
    }) => [number, number, number, number] | undefined;
  },
) {
  root.traverse((child) => {
    if (child.type !== 'ParticleEmitter') return;
    const emitter = child as ParticleEmitter;
    const system = emitter.system as ParticleSystem | undefined;
    if (!system) return;

    const mat = system.material as MeshBasicMaterial & {
      userData: Record<string, unknown> & { particleMat?: { alphaClip?: boolean } };
    };
    if (!mat?.isMaterial) return;

    const sim = readArtifactEmitterSim(system);
    if (options.requireSim && sim === undefined) {
      throw new Error(
        `forEachCfxrEmitterMountCore(requireSim) missing __artifactEmitterSim on '${emitter.uuid}'`,
      );
    }
    const declaredMount = sim?.behaviorMount;
    const declaredMounts = declaredMount?.mounts;
    const allow = (mountId: string) => allowBehaviorMount(mountId, declaredMounts);
    const attemptedMounts: string[] = ['material-basics@1'];
    const actualMounts: string[] = ['material-basics@1'];
    const take = (mountId: string, apply: () => void) => {
      if (!attemptedMounts.includes(mountId)) attemptedMounts.push(mountId);
      if (!allow(mountId)) return;
      apply();
      if (!actualMounts.includes(mountId)) actualMounts.push(mountId);
    };
    const pick = options.pick?.({ emitter, sim })
      ?? ((key: keyof ArtifactEmitterSim) => sim?.[key]);

    const earlyBlend = (mat.userData as { artifactBlendState?: VfxPipelineBlendState })
      .artifactBlendState;
    if (options.applyEarlyBlend() && earlyBlend) {
      applyBakedBlendState(mat, earlyBlend);
    } else if (options.applyEarlyBlend() && options.requireEarlyBlend?.()) {
      throw new Error(
        `missing offline artifactBlendState for emitter '${emitter.uuid}'`,
      );
    } else if (options.applyEarlyBlend()) {
      // Artifact blend policy but no stamp yet (frozen / pre-stamp loads).
      // When the material already carries an artifact pipeline binding, refuse invent.
      const stamped = !!(mat.userData as { artifactPipeline?: unknown }).artifactPipeline
        || typeof (mat.userData as { artifactShaderId?: unknown }).artifactShaderId === 'string';
      if (stamped) {
        throw new Error(
          `missing offline artifactBlendState for emitter '${emitter.uuid}' (pipeline stamped, no invent)`,
        );
      }
      // v3 bags stamp stream defaults; those loads must also carry blend (no Quarks stock).
      if (sim?.defaultCustom1 != null || sim?.defaultRendererFlip != null) {
        throw new Error(
          `missing offline artifactBlendState for emitter '${emitter.uuid}' (stream-stamped bag, no invent)`,
        );
      }
      applyQuarksStockEarlyBlend(mat);
    } else {
      // Bridge rollback: Quarks stock defaults until semantic-blend/inject.
      applyQuarksStockEarlyBlend(mat);
    }
    if (mat.map) {
      take('map-colorspace@1', () => {
        const srgb = pick('mainMapSrgb');
        if (typeof srgb !== 'boolean') {
          throw new Error(
            `map-colorspace@1 missing offline mainMapSrgb for emitter '${emitter.uuid}'`,
          );
        }
        mat.map!.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
        mat.map!.needsUpdate = true;
      });
    }

    if (system.renderMode === RenderMode.StretchedBillBoard) {
      take('stretch-remap@1', () => {
        const remap = pick('stretchRemap');
        if (!remap) {
          throw new Error(
            `stretch-remap@1 missing offline stretchRemap for emitter '${emitter.uuid}'`,
          );
        }
        remapUnityStretchToQuarks(system, remap);
      });
    }

    const shapeTransform = pick('shapeTransform');
    if (shapeTransform) {
      take('shape-transform@1', () => { patchUnityShapeTransform(system, shapeTransform); });
    }
    let requireStreamStamps = !!options.requireInitialStreamStamps;
    {
      const defaultFlip = pick('defaultRendererFlip') as [boolean, boolean] | undefined;
      const defaultCustom1 = pick('defaultCustom1') as
        | [number, number, number, number]
        | undefined;
      const defaultCustom2 = pick('defaultCustom2') as
        | [number, number, number, number]
        | undefined;
      const hasStreamDefaults = Array.isArray(defaultFlip) && defaultFlip.length === 2
        && Array.isArray(defaultCustom1) && defaultCustom1.length === 4
        && defaultCustom1.every((v) => typeof v === 'number')
        && Array.isArray(defaultCustom2) && defaultCustom2.length === 4
        && defaultCustom2.every((v) => typeof v === 'number');
      // Thin always requires; production requires once the bag already carries any
      // stream default (v3 stamps). Frozen bags without defaults keep soft invent.
      const bagHasAnyStreamDefault = defaultFlip != null
        || defaultCustom1 != null
        || defaultCustom2 != null;
      requireStreamStamps = requireStreamStamps || bagHasAnyStreamDefault;
      if (requireStreamStamps && !hasStreamDefaults) {
        if (!Array.isArray(defaultFlip) || defaultFlip.length !== 2) {
          throw new Error(
            `emitter '${emitter.uuid}' missing offline defaultRendererFlip[2] (no invent)`,
          );
        }
        if (!Array.isArray(defaultCustom1) || defaultCustom1.length !== 4
          || defaultCustom1.some((v) => typeof v !== 'number')) {
          throw new Error(
            `emitter '${emitter.uuid}' missing offline defaultCustom1[4] (no invent)`,
          );
        }
        throw new Error(
          `emitter '${emitter.uuid}' missing offline defaultCustom2[4] (no invent)`,
        );
      }
      if (hasStreamDefaults) {
        const streamDefaults = system as unknown as {
          unityDefaultRendererFlip?: [boolean, boolean];
          unityDefaultCustom1?: [number, number, number, number];
          unityDefaultCustom2?: [number, number, number, number];
        };
        streamDefaults.unityDefaultRendererFlip = [!!defaultFlip![0], !!defaultFlip![1]];
        streamDefaults.unityDefaultCustom1 = [
          defaultCustom1![0], defaultCustom1![1], defaultCustom1![2], defaultCustom1![3],
        ];
        streamDefaults.unityDefaultCustom2 = [
          defaultCustom2![0], defaultCustom2![1], defaultCustom2![2], defaultCustom2![3],
        ];
      }
    }
    const initialStates = pick('initialState');
    if (initialStates) {
      if (requireStreamStamps) {
        for (let i = 0; i < initialStates.length; i++) {
          const state = initialStates[i] as {
            rendererFlip?: unknown;
            custom1?: unknown;
            custom2?: unknown;
          };
          if (!Array.isArray(state.rendererFlip) || state.rendererFlip.length !== 2) {
            throw new Error(
              `initial-state@1 emitter '${emitter.uuid}' state[${i}] missing rendererFlip[2] (no invent)`,
            );
          }
          if (!Array.isArray(state.custom1) || state.custom1.length !== 4) {
            throw new Error(
              `initial-state@1 emitter '${emitter.uuid}' state[${i}] missing custom1[4] (no invent)`,
            );
          }
          if (!Array.isArray(state.custom2) || state.custom2.length !== 4) {
            throw new Error(
              `initial-state@1 emitter '${emitter.uuid}' state[${i}] missing custom2[4] (no invent)`,
            );
          }
        }
      }
      take('initial-state@1', () => {
        if (!system.behaviors.some((b) => b.type === 'UnityInitialState')) {
          system.behaviors.unshift(new UnityInitialStateBehavior(
            initialStates,
            system.looping ? system.duration : undefined,
            { requireStreamStamps },
          ));
        }
      });
      take('global-age@1', () => {
        if (!system.behaviors.some((b) => b.type === 'UnityGlobalAge')) {
          const initialIndex = system.behaviors.findIndex((b) => b.type === 'UnityInitialState');
          system.behaviors.splice(initialIndex >= 0 ? initialIndex + 1 : 0, 0, new UnityGlobalAgeBehavior());
        }
      });
      if (allow('initial-state@1')) patchCalibratedBirthSubEmitters(system);
    }
    patchChildDurationSubEmitters(system, pick('subEmitterInheritance'));
    const custom1Curves = pick('custom1Curves');
    if (custom1Curves) {
      take('custom1@1', () => {
        if (!system.behaviors.some((b) => b.type === 'UnityCustom1')) {
          system.behaviors.push(new UnityCustom1Behavior(custom1Curves));
        }
      });
    }
    const sizeTwoCurves = pick('sizeTwoCurves');
    if (sizeTwoCurves) {
      take('size-two-curves@1', () => {
        const index = system.behaviors.findIndex((b) => b.type === 'SizeOverLife');
        if (index >= 0) system.behaviors.splice(index, 1, new UnitySizeTwoCurvesBehavior(sizeTwoCurves));
        else system.behaviors.push(new UnitySizeTwoCurvesBehavior(sizeTwoCurves));
      });
    }
    const strictSize = pick('sizeOverLifetime');
    if (strictSize) {
      take('size-over-lifetime@1', () => {
        const index = system.behaviors.findIndex((b) => b.type === 'SizeOverLife');
        if (index >= 0)
          system.behaviors.splice(index, 1, new UnitySizeOverLifetimeBehavior(strictSize));
        else system.behaviors.push(new UnitySizeOverLifetimeBehavior(strictSize));
      });
    }
    const startSizeTwoCurves = pick('startSizeTwoCurves');
    if (startSizeTwoCurves) {
      take('start-size-two-curves@1', () => {
        system.startSize = new UnityTwoCurvesGenerator(startSizeTwoCurves);
      });
    }
    const limitVelocity3D = pick('limitVelocity3D');
    if (limitVelocity3D) {
      take('limit-velocity-3d@1', () => {
        system.behaviors.push(new UnityLimitVelocity3DBehavior(limitVelocity3D));
      });
    }
    const limitVelocity = pick('limitVelocity');
    if (limitVelocity) {
      take('limit-velocity@1', () => {
        const stockIndex = system.behaviors.findIndex((behavior) => behavior.type === 'LimitSpeedOverLife');
        if (stockIndex >= 0) system.behaviors.splice(stockIndex, 1);
        system.behaviors.push(new UnityLimitVelocityBehavior(limitVelocity));
      });
    }
    const velocityOverLifetime = pick('velocityOverLifetime');
    if (velocityOverLifetime) {
      take('velocity-over-lifetime@1', () => {
        system.behaviors.push(new UnityVelocityOverLifetimeBehavior(velocityOverLifetime));
      });
    }
    const rotation3D = pick('rotation3D');
    if (rotation3D) {
      take('rotation-3d@1', () => {
        const index = system.behaviors.findIndex((b) => b.type === 'RotationOverLife');
        if (index >= 0) system.behaviors.splice(index, 1);
        system.behaviors.push(new UnityRotation3DBehavior(rotation3D));
      });
    }
    const tiles = pick('tileCounts') as [number, number] | undefined;
    if (!tiles) {
      throw new Error(
        `emitter '${emitter.uuid}' missing offline tileCounts bag`,
      );
    }
    const tileCount = tiles[0] * tiles[1];
    const sheet = pick('flipbookSheet');
    if (tileCount > 1) {
      const frameIndex = system.behaviors.findIndex((b) => b.type === 'FrameOverLife');
      if (frameIndex >= 0) {
        const stock = system.behaviors[frameIndex] as Behavior & {
          frame?: ConstructorParameters<typeof UnityFrameOverLifeBehavior>[0];
        };
        const timing = pick('flipbookTiming');
        if (!timing) {
          throw new Error(
            `emitter '${emitter.uuid}' tileCount>1 missing offline flipbookTiming (no stock invent)`,
          );
        }
        {
          if (!sheet) {
            throw new Error(
              `flipbookTiming requires offline flipbookSheet for emitter '${emitter.uuid}'`,
            );
          }
          const fixedSpeedFrames = timing.mode === 'speed'
            && !!initialStates?.length
            && initialStates.every((state: any) => state.frame != null && state.frame >= 0);
          if (fixedSpeedFrames) {
            system.behaviors.splice(frameIndex, 1);
          } else if (stock.frame) {
            system.behaviors.splice(
              frameIndex,
              1,
              new UnityFrameOverLifeBehavior(
                stock.frame,
                sheet.frameCount,
                timing.mode,
                timing.speedRange,
                sheet.singleRow,
                {
                  requireSpawnAgeOffset: requireStreamStamps
                    && !!initialStates?.length,
                },
              ),
            );
          } else {
            throw new Error(
              `emitter '${emitter.uuid}' flipbookTiming present but stock FrameOverLife.frame missing`,
            );
          }
        }
      }
    }
    const trajectoryCache = pick('trajectoryCache');
    take('renderer-pivot@1', () => {
      const pivot = options.resolveRendererPivot?.({ emitter, sim }) ?? sim?.rendererPivot;
      if (!pivot) {
        throw new Error(
          `renderer-pivot@1 missing offline pivot for emitter '${emitter.uuid}'`,
        );
      }
      (system as unknown as { unityRendererPivot?: [number, number, number, number] }).unityRendererPivot =
        pivot;
    });
    if (trajectoryCache) {
      take('trajectory-cache@1', () => {
        if (!system.behaviors.some((b) => b.type === 'UnityTrajectoryCache')) {
          system.behaviors.push(new UnityTrajectoryCacheBehavior(trajectoryCache));
        }
      });
    }
    const trailSemantics = pick('trailSemantics');
    if (trailSemantics) {
      take('trail-semantics@1', () => {
        if (!system.behaviors.some((b) => b.type === 'UnityTrailSemantics')) {
          const trailBehavior = new UnityTrailSemanticsBehavior(
            trailSemantics,
            pick('trailGeometry'),
          );
          (trailBehavior as unknown as { system?: IParticleSystem }).system =
            system as unknown as IParticleSystem;
          system.behaviors.push(trailBehavior);
        }
      });
    }
    if (initialStates) {
      take('spawn-visibility@1', () => {
        if (!system.behaviors.some((b) => b.type === 'UnitySpawnVisibility')) {
          system.behaviors.push(new UnitySpawnVisibilityBehavior());
        }
      });
    }

    const props = options.resolveProps?.({ emitter, sim });
    const finishMountAudit = () => {
      if (!declaredMounts) return;
      assertSameStringSet(`behaviorMount.attempted[${emitter.uuid}]`, declaredMounts, attemptedMounts);
      assertSameStringSet(`behaviorMount[${emitter.uuid}]`, declaredMounts, actualMounts);
    };
    applyMaterialPending({
      emitter,
      system,
      mat,
      take,
      tileCount,
      initialStates,
      props,
      declaredMounts,
      finishMountAudit,
    });
  });
}

/** Thin / offline-material path: baked blend + Color32 from declared mounts. */
export function mountCfxrSimulationFromBags(root: Object3D) {
  forEachCfxrEmitterMountCore(root, ({
    emitter,
    system,
    declaredMounts,
    take,
    mat,
    finishMountAudit,
  }) => {
    if (declaredMounts?.includes('semantic-blend@1')) {
      take('semantic-blend@1', () => {
        const declaredBlend = (mat.userData as { artifactBlendState?: VfxPipelineBlendState })
          .artifactBlendState;
        if (!declaredBlend) {
          throw new Error(
            `patchCfxrSimulationBeforeBatch missing artifactBlendState on '${emitter.uuid}'`,
          );
        }
        applyBakedBlendState(mat, declaredBlend);
      });
    }
    if (declaredMounts?.includes('color32-stream@1')) {
      take('color32-stream@1', () => {
        if (!system.behaviors.some((behavior) => behavior.type === 'UnityColor32')) {
          system.behaviors.push(new UnityColor32Behavior());
        }
      });
    }
    mat.needsUpdate = true;
    finishMountAudit();
  }, {
    requireSim: true,
    applyEarlyBlend: () => true,
    requireEarlyBlend: () => true,
    requireInitialStreamStamps: true,
  });
}

/** Thin-player entry: simulation mounts only; materials stay offline-owned. */
export function patchCfxrSimulationBeforeBatch(root: Object3D) {
  mountCfxrSimulationFromBags(root);
}
