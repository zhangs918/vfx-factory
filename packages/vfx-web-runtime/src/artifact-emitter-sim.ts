/**
 * Offline emitter simulation bag stamped onto Quarks systems before beforeBatch.
 * Prefer these fields over restored runtime-state maps when present (thin path).
 */

import { decodeUnityTrailGeometry } from './cfxr-sim-trail-geometry';

export type ArtifactFlipbookTiming = {
  mode: 'lifetime' | 'speed';
  speedRange: [number, number];
};

export type ArtifactEmitterSim = {
  behaviorMount?: { schema: string; mounts: string[] };
  rendererPivot?: [number, number, number, number];
  sizeOverLifetime?: any;
  sizeTwoCurves?: any;
  startSizeTwoCurves?: any;
  limitVelocity?: any;
  limitVelocity3D?: any;
  velocityOverLifetime?: any;
  rotation3D?: any;
  initialState?: any[];
  trajectoryCache?: any;
  shapeTransform?: any;
  custom1Curves?: [any, any, any, any];
  flipbookTiming?: ArtifactFlipbookTiming;
  /** Offline flipbook sheet meta (frame count / single-row packing). */
  flipbookSheet?: {
    frameCount: number;
    singleRow?: {
      columns: number;
      rows: number;
      rowIndex: number;
      randomRow: boolean;
    };
  };
  /** Offline UV flipbook tile counts from `ps.uTileCount` / `ps.vTileCount`. */
  tileCounts?: [number, number];
  /** Compile-stamped inject vertex patches for this emitter. */
  vertexPatches?: string[];
  /** Compile / mount defaults for Unity→Quarks stretch billboard factors. */
  stretchRemap?: { speedFactor: number; lengthFactor: number };
  trailSemantics?: any;
  trailGeometry?: any;
  subEmitterInheritance?: any[];
  childDuration?: boolean;
  /** Offline main-map color space (`true` → sRGB, `false` → linear/NoColorSpace). */
  mainMapSrgb?: boolean;
  /**
   * Emitter-level Unity renderer flip default (ps.unityRendererFlip).
   * Used for stream-spawned particles without per-particle initial-state stamps.
   */
  defaultRendererFlip?: [boolean, boolean];
  /**
   * Offline stream custom defaults for particles without Custom1/Custom2 /
   * per-particle initial-state stamps. Historical identity is [0,0,0,0];
   * thin mount must read these (no runtime invent).
   */
  defaultCustom1?: [number, number, number, number];
  defaultCustom2?: [number, number, number, number];
  /**
   * Production-only: pending CFXR material props stamped from maps for the
   * inject/blend pending tail. Thin never sets or reads this.
   */
  materialProps?: unknown;
};

export const ARTIFACT_EMITTER_SIM = '__artifactEmitterSim';

/**
 * Offline custom1 curves from compile-baked `artifactCustom1Curves` only.
 * Production JSON restore still derives from `cfxrCustomData` in
 * `setDissolveCurvesFromJson` when the stamp is absent.
 */
export function custom1CurvesFromPs(ps: any): [any, any, any, any] | null {
  if (Array.isArray(ps?.artifactCustom1Curves) && ps.artifactCustom1Curves.length === 4) {
    return ps.artifactCustom1Curves as [any, any, any, any];
  }
  return null;
}

/** Exporter-side custom1 pack used by the production map restore path. */
export function custom1CurvesFromCfxrCustomData(ps: any): [any, any, any, any] | null {
  const custom = ps?.cfxrCustomData;
  if (!custom || typeof custom !== 'object') return null;
  const { custom1x, custom1y, custom1z, custom1w } = custom;
  const present = [custom1x, custom1y, custom1z, custom1w].filter((c) => c != null).length;
  if (present === 0) return null;
  if (present < 4) {
    throw new Error('cfxrCustomData: custom1x/y/z/w must all be present (no zero invent)');
  }
  return [custom1x, custom1y, custom1z, custom1w];
}

/** Build the offline sim bag from a hydrated quarksConfig emitter `ps` block. */
export function collectArtifactEmitterSim(
  ps: any,
): ArtifactEmitterSim | null {
  if (!ps || typeof ps !== 'object') return null;
  const sim: ArtifactEmitterSim = {};
  let any = false;

  const mount = ps.artifactBehaviorMount;
  if (mount?.schema === 'cfxr-behavior-mount@1' && Array.isArray(mount.mounts)) {
    sim.behaviorMount = {
      schema: 'cfxr-behavior-mount@1',
      mounts: mount.mounts.map(String),
    };
    any = true;
  }

  const pivot = ps.artifactRendererPivot;
  if (Array.isArray(pivot)) {
    if (pivot.length < 4) {
      throw new Error('artifactRendererPivot requires 4 components (no w invent)');
    }
    sim.rendererPivot = [
      Number(pivot[0]),
      Number(pivot[1]),
      Number(pivot[2]),
      Number(pivot[3]),
    ];
    any = true;
  }

  if (Array.isArray(ps.unityRendererFlip)) {
    if (ps.unityRendererFlip.length !== 2) {
      throw new Error('unityRendererFlip requires [boolean, boolean] (no invent)');
    }
    // Emitter flip lives in material CFXR_FLIP_*; stream default is identity
    // (match thick UnityInitialState invent / avoid double-flip with defines).
    sim.defaultRendererFlip = [false, false];
    // Stream custom identity travels with flip defaults in the offline bag.
    // Corpus must stamp artifactDefaultCustom*; no historical zero invent here.
    const stampCustom = (
      raw: unknown,
      label: string,
    ): [number, number, number, number] => {
      if (Array.isArray(raw) && raw.length === 4 && raw.every((v) => typeof v === 'number')) {
        return [raw[0], raw[1], raw[2], raw[3]];
      }
      throw new Error(`${label} requires [number,number,number,number] (no invent)`);
    };
    sim.defaultCustom1 = stampCustom(ps.artifactDefaultCustom1, 'artifactDefaultCustom1');
    sim.defaultCustom2 = stampCustom(ps.artifactDefaultCustom2, 'artifactDefaultCustom2');
    any = true;
  }

  if (ps.unitySizeOverLifetime?.type === 'UnityTwoCurves@1') {
    sim.sizeTwoCurves = ps.unitySizeOverLifetime;
    any = true;
  } else if (ps.unitySizeOverLifetime?.schema === 'unity-size-over-lifetime@1') {
    sim.sizeOverLifetime = ps.unitySizeOverLifetime;
    any = true;
  }

  if (ps.unityStartSize?.type === 'UnityTwoCurves@1') {
    sim.startSizeTwoCurves = ps.unityStartSize;
    any = true;
  }
  if (ps.unityLimitVelocity3D?.schema === 'unity-limit-velocity-3d@1') {
    sim.limitVelocity3D = ps.unityLimitVelocity3D;
    any = true;
  }
  if (ps.unityLimitVelocity?.schema === 'unity-limit-velocity@1') {
    sim.limitVelocity = ps.unityLimitVelocity;
    any = true;
  }
  if (ps.unityVelocityOverLifetime?.schema === 'unity-velocity-over-lifetime@1') {
    sim.velocityOverLifetime = ps.unityVelocityOverLifetime;
    any = true;
  }
  if (ps.unityRotationOverLifetime3D) {
    sim.rotation3D = ps.unityRotationOverLifetime3D;
    any = true;
  }
  if (Array.isArray(ps.unityInitialState) && ps.unityInitialState.length) {
    sim.initialState = ps.unityInitialState;
    any = true;
  }
  if (ps.unityTrajectoryCache?.schema === 'particle-trajectory-cache@4'
    || ps.unityTrajectoryCache?.schema === 'particle-trajectory-cache@5'
    || ps.unityTrajectoryCache?.schema === 'particle-trajectory-cache@6') {
    sim.trajectoryCache = ps.unityTrajectoryCache;
    any = true;
  }
  if (ps.unityShapeTransform) {
    sim.shapeTransform = ps.unityShapeTransform;
    any = true;
  }
  if (ps.unityTrailSemantics?.schema === 'unity-trail-semantics@1'
    || ps.unityTrailSemantics?.schema === 'unity-trail-semantics@2') {
    sim.trailSemantics = ps.unityTrailSemantics;
    any = true;
  }
  if (ps.unityTrailGeometry?.schema === 'unity-trail-geometry@1'
    || ps.unityTrailGeometry?.schema === 'unity-trail-geometry@2') {
    sim.trailGeometry = decodeUnityTrailGeometry(ps.unityTrailGeometry);
    any = true;
  }

  const mode = ps.unityFlipbookTimeMode;
  const range = ps.unityFlipbookSpeedRange;
  if ((mode === 'lifetime' || mode === 'speed') && Array.isArray(range) && range.length >= 2) {
    sim.flipbookTiming = {
      mode,
      speedRange: [Number(range[0]), Number(range[1])],
    };
    any = true;
  }

  // Sheet packing + tile counts share authored u/v — require both or neither
  // (do not invent the missing axis as 1).
  const hasU = ps.uTileCount != null && ps.uTileCount !== '';
  const hasV = ps.vTileCount != null && ps.vTileCount !== '';
  if (hasU !== hasV) {
    throw new Error(
      `offline tileCounts incomplete: uTileCount=${String(ps.uTileCount)} `
      + `vTileCount=${String(ps.vTileCount)}`,
    );
  }
  if (hasU && hasV) {
    const u = Number(ps.uTileCount);
    const v = Number(ps.vTileCount);
    if (!(u >= 1) || !(v >= 1) || !Number.isFinite(u) || !Number.isFinite(v)) {
      throw new Error(
        `offline tileCounts must be finite >= 1 (no Math.max invent), got u=${String(ps.uTileCount)} v=${String(ps.vTileCount)}`,
      );
    }
    sim.tileCounts = [u, v];
    any = true;
    const tileProduct = u * v;
    if (tileProduct > 1 || ps.unityFlipbookFrameCount != null || ps.unityFlipbookSingleRow) {
      let frameCount: number;
      if (ps.unityFlipbookFrameCount != null) {
        frameCount = Number(ps.unityFlipbookFrameCount);
        if (!(frameCount >= 1) || !Number.isFinite(frameCount)) {
          throw new Error(
            `unityFlipbookFrameCount must be finite >= 1 (no Math.max invent), got ${String(ps.unityFlipbookFrameCount)}`,
          );
        }
      } else if (tileProduct > 1) {
        frameCount = tileProduct;
      } else {
        throw new Error(
          'unityFlipbookSingleRow requires unityFlipbookFrameCount when tileCounts are 1×1',
        );
      }
      let singleRow: {
        columns: number;
        rows: number;
        rowIndex: number;
        randomRow: boolean;
      } | undefined;
      if (ps.unityFlipbookSingleRow) {
        if (ps.unityFlipbookRowIndex == null || ps.unityFlipbookRowIndex === '') {
          throw new Error('unityFlipbookSingleRow requires unityFlipbookRowIndex (no 0 invent)');
        }
        singleRow = {
          columns: u,
          rows: v,
          rowIndex: Number(ps.unityFlipbookRowIndex),
          randomRow: !!ps.unityFlipbookRandomRow,
        };
      }
      sim.flipbookSheet = {
        frameCount,
        ...(singleRow ? { singleRow } : {}),
      };
      any = true;
    }
  }

  if (ps.unitySubEmitterLifecycle?.schema === 'unity-sub-emitter-lifecycle@1'
    && ps.unitySubEmitterLifecycle.termination === 'child-duration') {
    sim.childDuration = true;
    any = true;
  }

  if (Array.isArray(ps.artifactVertexPatches)) {
    sim.vertexPatches = ps.artifactVertexPatches.map(String);
    any = true;
  }

  // Unity stretched billboard → Quarks speedFactor/lengthFactor from offline config.
  // Do not invent lengthFactor=1 when rendererEmitterSettings omit the fields.
  if (Number(ps.renderMode) === 1) {
    const res = ps.rendererEmitterSettings ?? {};
    if (res.speedFactor == null || res.lengthFactor == null) {
      throw new Error(
        'stretch-remap@1: stretched billboard missing offline speedFactor/lengthFactor',
      );
    }
    sim.stretchRemap = {
      speedFactor: Number(res.speedFactor),
      lengthFactor: Number(res.lengthFactor),
    };
    any = true;
  }

  if (typeof ps.artifactMainMapSrgb === 'boolean') {
    sim.mainMapSrgb = ps.artifactMainMapSrgb;
    any = true;
  }

  // Offline stamp only — EmitSubParticleSystem annotations are compile input,
  // not a live dual authority for thin bags.
  const inheritanceFromArtifact = Array.isArray(ps.artifactSubEmitterInheritance)
    ? ps.artifactSubEmitterInheritance.filter(
      (spec: any) => spec?.schema === 'unity-sub-emitter-inheritance@1',
    )
    : [];
  if (inheritanceFromArtifact.length) {
    sim.subEmitterInheritance = inheritanceFromArtifact;
    any = true;
  }

  const custom1 = custom1CurvesFromPs(ps);
  if (custom1) {
    sim.custom1Curves = custom1;
    any = true;
  }

  return any ? sim : null;
}

/**
 * Mounts that require emitter-local bag fields (thin cannot fall back to maps).
 * Material-side / always-default mounts map to `() => true` so coverage is
 * explicit (unknown mount ids still pass for forward compatibility).
 */
const MOUNT_BAG_REQUIREMENTS: Record<string, (sim: ArtifactEmitterSim) => boolean> = {
  'material-basics@1': () => true,
  'map-colorspace@1': (sim) => typeof sim.mainMapSrgb === 'boolean',
  'stretch-remap@1': (sim) => !!sim.stretchRemap,
  'renderer-pivot@1': (sim) => !!sim.rendererPivot,
  'semantic-blend@1': () => true,
  'color32-stream@1': () => true,
  'initial-state@1': (sim) => Array.isArray(sim.initialState) && sim.initialState.length > 0,
  'global-age@1': (sim) => Array.isArray(sim.initialState) && sim.initialState.length > 0,
  'spawn-visibility@1': (sim) => Array.isArray(sim.initialState) && sim.initialState.length > 0,
  'size-over-lifetime@1': (sim) => !!sim.sizeOverLifetime || !!sim.sizeTwoCurves,
  'size-two-curves@1': (sim) => !!sim.sizeTwoCurves,
  'start-size-two-curves@1': (sim) => !!sim.startSizeTwoCurves,
  'rotation-3d@1': (sim) => !!sim.rotation3D,
  'velocity-over-lifetime@1': (sim) => !!sim.velocityOverLifetime,
  'limit-velocity@1': (sim) => !!sim.limitVelocity,
  'limit-velocity-3d@1': (sim) => !!sim.limitVelocity3D,
  'custom1@1': (sim) => !!sim.custom1Curves,
  'shape-transform@1': (sim) => !!sim.shapeTransform,
  'trajectory-cache@1': (sim) => !!sim.trajectoryCache,
  'trail-semantics@1': (sim) => !!sim.trailSemantics,
};

/** Fail loud when a declared mount cannot be satisfied from the offline bag alone. */
export function assertArtifactEmitterSimCoversMounts(
  effectId: string,
  emitterId: string,
  sim: ArtifactEmitterSim,
  ps?: Record<string, unknown> | null,
) {
  // After V3ArtifactPlayer.hydrateCompiledTables, binding ids must be gone —
  // bags and mounts only see inlined tables.
  for (const key of ['unityInitialStateResourceId', 'unityTrajectoryCacheResourceId'] as const) {
    if (ps?.[key]) {
      throw new Error(
        `thinPlayer: artifact '${effectId}' emitter '${emitterId}' still has `
        + `${key} after hydrate (expected inlined table only)`,
      );
    }
  }
  const mounts = sim.behaviorMount?.mounts;
  if (!mounts?.length) return;
  const missing = mounts.filter((mountId) => {
    const ok = MOUNT_BAG_REQUIREMENTS[mountId];
    return ok ? !ok(sim) : false;
  });
  if (missing.length) {
    throw new Error(
      `thinPlayer: artifact '${effectId}' emitter '${emitterId}' declares mounts `
      + `[${missing.join(', ')}] but offline __artifactEmitterSim bag is incomplete`,
    );
  }
}

/** Mount audit: declared vs attempted/actual string sets (no URL / location reads). */
export function assertSameStringSet(label: string, declared: string[], actual: string[]) {
  const leftValues = [...new Set(declared)].sort();
  const rightValues = [...new Set(actual)].sort();
  const left = leftValues.join('|');
  const right = rightValues.join('|');
  if (left !== right) {
    throw new Error(`${label} mismatch: declared=[${leftValues.join(', ')}] actual=[${rightValues.join(', ')}]`);
  }
}

/**
 * Gate optional mounts against the offline declared list.
 * No declaration → allow (empty placeholder bags / pre-manifest emitters).
 */
export function allowBehaviorMount(
  mountId: string,
  declared: string[] | undefined,
): boolean {
  if (!declared) return true;
  return declared.includes(mountId);
}

export function stampArtifactEmitterSim(
  system: object,
  sim: ArtifactEmitterSim,
  options?: { forbidMaterialProps?: boolean },
) {
  if (options?.forbidMaterialProps && sim.materialProps !== undefined) {
    throw new Error(
      'stampArtifactEmitterSim: materialProps is production inject-tail only; '
      + 'thin/offline bags must omit it',
    );
  }
  (system as { [ARTIFACT_EMITTER_SIM]?: ArtifactEmitterSim })[ARTIFACT_EMITTER_SIM] = sim;
}

export function readArtifactEmitterSim(system: object): ArtifactEmitterSim | undefined {
  return (system as { [ARTIFACT_EMITTER_SIM]?: ArtifactEmitterSim })[ARTIFACT_EMITTER_SIM];
}
