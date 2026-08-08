/**
 * Production before-batch simulation mounts for Unity→Quarks playback.
 * May restore CFXR runtime-state maps. Thin imports `cfxr-emitter-mount-core` instead.
 */
import {
  type Object3D,
} from 'three';
import type { ParticleEmitter } from 'three.quarks';
import {
  collectArtifactEmitterSim,
  readArtifactEmitterSim,
  stampArtifactEmitterSim,
  type ArtifactEmitterSim,
} from './artifact-emitter-sim';
import {
  behaviorMountByEmitter,
  childDurationSubEmitterIds,
  custom1CurvesByEmitter,
  flipbookTimingByEmitter,
  initialStateByEmitter,
  limitVelocity3DByEmitter,
  limitVelocityByEmitter,
  pendingCfxrByEmitter,
  rendererPivotByEmitter,
  rotation3DByEmitter,
  shapeTransformByEmitter,
  sizeOverLifetimeByEmitter,
  sizeTwoCurvesByEmitter,
  startSizeTwoCurvesByEmitter,
  subEmitterInheritanceByEmitter,
  trajectoryCacheByEmitter,
  trailGeometryByEmitter,
  trailSemanticsByEmitter,
  velocityOverLifetimeByEmitter,
  vertexPatchesByEmitter,
} from './cfxr-runtime-state';
import {
  forEachCfxrEmitterMountCore,
  type CfxrEmitterMountSession,
} from './cfxr-emitter-mount-core';

export type { CfxrEmitterMountSession };

function buildEmitterSimFromMaps(emitterId: string): ArtifactEmitterSim | null {
  const sim: ArtifactEmitterSim = {};
  const take = <K extends keyof ArtifactEmitterSim>(
    key: K,
    map: Map<string, NonNullable<ArtifactEmitterSim[K]>>,
  ) => {
    const value = map.get(emitterId);
    if (value !== undefined) (sim as Record<string, unknown>)[key] = value;
  };
  take('behaviorMount', behaviorMountByEmitter);
  take('rendererPivot', rendererPivotByEmitter);
  take('shapeTransform', shapeTransformByEmitter);
  take('initialState', initialStateByEmitter);
  take('subEmitterInheritance', subEmitterInheritanceByEmitter);
  take('custom1Curves', custom1CurvesByEmitter);
  take('sizeTwoCurves', sizeTwoCurvesByEmitter);
  take('sizeOverLifetime', sizeOverLifetimeByEmitter);
  take('startSizeTwoCurves', startSizeTwoCurvesByEmitter);
  take('limitVelocity3D', limitVelocity3DByEmitter);
  take('limitVelocity', limitVelocityByEmitter);
  take('velocityOverLifetime', velocityOverLifetimeByEmitter);
  take('rotation3D', rotation3DByEmitter);
  take('flipbookTiming', flipbookTimingByEmitter);
  take('trajectoryCache', trajectoryCacheByEmitter);
  take('trailSemantics', trailSemanticsByEmitter);
  take('trailGeometry', trailGeometryByEmitter);
  take('vertexPatches', vertexPatchesByEmitter);
  if (childDurationSubEmitterIds.has(emitterId)) sim.childDuration = true;
  const props = pendingCfxrByEmitter.get(emitterId);
  if (props !== undefined) sim.materialProps = props;
  if (typeof (props as { mainMapSrgb?: boolean } | undefined)?.mainMapSrgb === 'boolean') {
    sim.mainMapSrgb = (props as { mainMapSrgb: boolean }).mainMapSrgb;
  }
  return Object.keys(sim).length ? sim : null;
}

/**
 * Production bag-first: merge restored runtime-state maps with offline collect
 * from the Quarks-parsed system (same ps-shaped fields collectArtifactEmitterSim
 * reads). Collect wins on overlap so we do not re-invent tile/stretch/flipbook
 * from live mirrors. Skip emitters that already carry a bag (thin / offline stamp).
 */
export function stampCfxrEmitterSimsFromMaps(root: Object3D) {
  root.traverse((child) => {
    if (child.type !== 'ParticleEmitter') return;
    const emitter = child as ParticleEmitter;
    const system = emitter.system as object | undefined;
    if (!system) return;
    const fromMaps = buildEmitterSimFromMaps(emitter.uuid) ?? {};
    const existing = readArtifactEmitterSim(system);
    if (existing) {
      // Bags stamped from ps mounts omit inject-tail props; always refresh from pending maps.
      if (fromMaps.materialProps !== undefined) {
        existing.materialProps = fromMaps.materialProps;
      }
      if (typeof existing.mainMapSrgb !== 'boolean'
        && typeof fromMaps.mainMapSrgb === 'boolean') {
        existing.mainMapSrgb = fromMaps.mainMapSrgb;
      }
      // Capture/restore paths may stamp behaviorMount before vertexPatchesByEmitter
      // is complete — merge patches from maps/ps so slim-inject never sees a bag
      // that exists but lacks declaredVertexPatches.
      const fromPs = collectArtifactEmitterSim(system as any) ?? {};
      if (!existing.vertexPatches) {
        if (fromMaps.vertexPatches) existing.vertexPatches = fromMaps.vertexPatches;
        else if (fromPs.vertexPatches) existing.vertexPatches = fromPs.vertexPatches;
      }
      return;
    }
    // Quarks flattens emitter `ps` onto the system; collect reads those fields.
    const fromPs = collectArtifactEmitterSim(system as any) ?? {};
    const sim: ArtifactEmitterSim = { ...fromMaps, ...fromPs };
    // Pending inject props stay map-owned (thin forbids them).
    if (fromMaps.materialProps !== undefined) sim.materialProps = fromMaps.materialProps;
    if (typeof sim.mainMapSrgb !== 'boolean'
      && typeof (fromMaps.mainMapSrgb) === 'boolean') {
      sim.mainMapSrgb = fromMaps.mainMapSrgb;
    }
    stampArtifactEmitterSim(system, sim);
  });
}

/**
 * Shared Unity behavior mounts. `applyMaterialPending` owns the pendingCfxr tail
 * (full inject-profile path).
 * Maps are stamped onto bags before this runs; mount picks + props are bag-only.
 * Mount gating is always against declared bags (no ?behaviorSource mount path).
 */
export function forEachCfxrEmitterMount(
  root: Object3D,
  applyMaterialPending: (session: CfxrEmitterMountSession) => void,
  options: { preferArtifactBlend: boolean },
) {
  const preferArtifactBlend = options.preferArtifactBlend;
  forEachCfxrEmitterMountCore(root, applyMaterialPending, {
    requireSim: true,
    // Early bake only when blend authority is artifact. Bridge rollback must not
    // pre-install baked toneMapped/side — applySemanticBlendState does not reset them.
    // Soft invent remains for frozen/unstamped loads; stamped pipelines must carry blendState.
    applyEarlyBlend: () => preferArtifactBlend,
    resolveProps: ({ sim }) => sim?.materialProps,
  });
}
