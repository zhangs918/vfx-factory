/**
 * Offline-authored CFXR simulation tables restored at playback.
 * Leaf module: no material inject / ubershader dependency.
 */

export let custom1CurvesByEmitter = new Map<string, [any, any, any, any]>();
/** Stable emitter UUID → explicit material program profile (opaque props bag). */
export let pendingCfxrByEmitter = new Map<string, any>();
export let shapeTransformByEmitter = new Map<string, any>();
export let initialStateByEmitter = new Map<string, any[]>();
export let childDurationSubEmitterIds = new Set<string>();
export let subEmitterInheritanceByEmitter = new Map<string, any[]>();
export let flipbookTimingByEmitter = new Map<
  string,
  { mode: 'lifetime' | 'speed'; speedRange: [number, number] }
>();
export let rendererPivotByEmitter = new Map<string, [number, number, number, number]>();
export let sizeTwoCurvesByEmitter = new Map<string, any>();
export let sizeOverLifetimeByEmitter = new Map<string, any>();
export let startSizeTwoCurvesByEmitter = new Map<string, any>();
export let limitVelocity3DByEmitter = new Map<string, any>();
export let limitVelocityByEmitter = new Map<string, any>();
export let velocityOverLifetimeByEmitter = new Map<string, any>();
export let rotation3DByEmitter = new Map<string, any>();
export let trajectoryCacheByEmitter = new Map<string, any>();
export let trailGeometryByEmitter = new Map<string, any>();
export let trailSemanticsByEmitter = new Map<string, any>();
/** Offline-declared inject vertex patches per emitter (stamped into bags). */
export let vertexPatchesByEmitter = new Map<string, string[]>();
/** Offline-declared beforeBatch mount list per emitter (audit dual-path). */
export let behaviorMountByEmitter = new Map<string, { schema: string; mounts: string[] }>();

/** JSON-safe semantic state generated offline; playback restores these tables. */
export interface CfxrRuntimeState { [key: string]: unknown; }

const mapEntries = (map: Map<unknown, unknown>) => [...map.entries()];
const restoreMap = (state: CfxrRuntimeState, key: string) =>
  new Map((Array.isArray(state[key]) ? state[key] : []) as [string, unknown][]);

export function exportCfxrRuntimeState(): CfxrRuntimeState {
  return {
    custom1CurvesByEmitter: mapEntries(custom1CurvesByEmitter as Map<unknown, unknown>),
    pendingCfxrByEmitter: mapEntries(pendingCfxrByEmitter as Map<unknown, unknown>),
    shapeTransformByEmitter: mapEntries(shapeTransformByEmitter as Map<unknown, unknown>),
    initialStateByEmitter: mapEntries(initialStateByEmitter as Map<unknown, unknown>),
    childDurationSubEmitterIds: [...childDurationSubEmitterIds],
    subEmitterInheritanceByEmitter: mapEntries(subEmitterInheritanceByEmitter as Map<unknown, unknown>),
    flipbookTimingByEmitter: mapEntries(flipbookTimingByEmitter as Map<unknown, unknown>),
    rendererPivotByEmitter: mapEntries(rendererPivotByEmitter as Map<unknown, unknown>),
    sizeTwoCurvesByEmitter: mapEntries(sizeTwoCurvesByEmitter as Map<unknown, unknown>),
    sizeOverLifetimeByEmitter: mapEntries(sizeOverLifetimeByEmitter as Map<unknown, unknown>),
    startSizeTwoCurvesByEmitter: mapEntries(startSizeTwoCurvesByEmitter as Map<unknown, unknown>),
    limitVelocity3DByEmitter: mapEntries(limitVelocity3DByEmitter as Map<unknown, unknown>),
    limitVelocityByEmitter: mapEntries(limitVelocityByEmitter as Map<unknown, unknown>),
    velocityOverLifetimeByEmitter: mapEntries(velocityOverLifetimeByEmitter as Map<unknown, unknown>),
    rotation3DByEmitter: mapEntries(rotation3DByEmitter as Map<unknown, unknown>),
    trajectoryCacheByEmitter: mapEntries(trajectoryCacheByEmitter as Map<unknown, unknown>),
    trailGeometryByEmitter: mapEntries(trailGeometryByEmitter as Map<unknown, unknown>),
    trailSemanticsByEmitter: mapEntries(trailSemanticsByEmitter as Map<unknown, unknown>),
    vertexPatchesByEmitter: mapEntries(vertexPatchesByEmitter as Map<unknown, unknown>),
    behaviorMountByEmitter: mapEntries(behaviorMountByEmitter as Map<unknown, unknown>),
  };
}

/** Clear all tables. Must run inside this module so live bindings update. */
export function resetCfxrRuntimeTables(): void {
  custom1CurvesByEmitter = new Map();
  pendingCfxrByEmitter = new Map();
  shapeTransformByEmitter = new Map();
  initialStateByEmitter = new Map();
  childDurationSubEmitterIds = new Set();
  subEmitterInheritanceByEmitter = new Map();
  flipbookTimingByEmitter = new Map();
  rendererPivotByEmitter = new Map();
  sizeTwoCurvesByEmitter = new Map();
  sizeOverLifetimeByEmitter = new Map();
  startSizeTwoCurvesByEmitter = new Map();
  limitVelocity3DByEmitter = new Map();
  limitVelocityByEmitter = new Map();
  velocityOverLifetimeByEmitter = new Map();
  rotation3DByEmitter = new Map();
  trajectoryCacheByEmitter = new Map();
  trailGeometryByEmitter = new Map();
  trailSemanticsByEmitter = new Map();
  vertexPatchesByEmitter = new Map();
  behaviorMountByEmitter = new Map();
}

export function resetCustom1CurvesTable(): void {
  custom1CurvesByEmitter = new Map();
}

export function importCfxrRuntimeState(state: CfxrRuntimeState): void {
  custom1CurvesByEmitter = restoreMap(state, 'custom1CurvesByEmitter') as typeof custom1CurvesByEmitter;
  pendingCfxrByEmitter = restoreMap(state, 'pendingCfxrByEmitter') as typeof pendingCfxrByEmitter;
  shapeTransformByEmitter = restoreMap(state, 'shapeTransformByEmitter') as typeof shapeTransformByEmitter;
  initialStateByEmitter = restoreMap(state, 'initialStateByEmitter') as typeof initialStateByEmitter;
  childDurationSubEmitterIds = new Set(
    Array.isArray(state.childDurationSubEmitterIds) ? state.childDurationSubEmitterIds as string[] : [],
  );
  subEmitterInheritanceByEmitter = restoreMap(state, 'subEmitterInheritanceByEmitter') as typeof subEmitterInheritanceByEmitter;
  flipbookTimingByEmitter = restoreMap(state, 'flipbookTimingByEmitter') as typeof flipbookTimingByEmitter;
  rendererPivotByEmitter = restoreMap(state, 'rendererPivotByEmitter') as typeof rendererPivotByEmitter;
  sizeTwoCurvesByEmitter = restoreMap(state, 'sizeTwoCurvesByEmitter') as typeof sizeTwoCurvesByEmitter;
  sizeOverLifetimeByEmitter = restoreMap(state, 'sizeOverLifetimeByEmitter') as typeof sizeOverLifetimeByEmitter;
  startSizeTwoCurvesByEmitter = restoreMap(state, 'startSizeTwoCurvesByEmitter') as typeof startSizeTwoCurvesByEmitter;
  limitVelocity3DByEmitter = restoreMap(state, 'limitVelocity3DByEmitter') as typeof limitVelocity3DByEmitter;
  limitVelocityByEmitter = restoreMap(state, 'limitVelocityByEmitter') as typeof limitVelocityByEmitter;
  velocityOverLifetimeByEmitter = restoreMap(state, 'velocityOverLifetimeByEmitter') as typeof velocityOverLifetimeByEmitter;
  rotation3DByEmitter = restoreMap(state, 'rotation3DByEmitter') as typeof rotation3DByEmitter;
  trajectoryCacheByEmitter = restoreMap(state, 'trajectoryCacheByEmitter') as typeof trajectoryCacheByEmitter;
  trailGeometryByEmitter = restoreMap(state, 'trailGeometryByEmitter') as typeof trailGeometryByEmitter;
  trailSemanticsByEmitter = restoreMap(state, 'trailSemanticsByEmitter') as typeof trailSemanticsByEmitter;
  vertexPatchesByEmitter = restoreMap(state, 'vertexPatchesByEmitter') as typeof vertexPatchesByEmitter;
  behaviorMountByEmitter = restoreMap(state, 'behaviorMountByEmitter') as typeof behaviorMountByEmitter;
}
