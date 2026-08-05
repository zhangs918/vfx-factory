import {
  WEB_RUNTIME_ARTIFACT_SCHEMA,
  type WebRuntimeArtifact,
} from '@vfx-factory/artifact-schema';
import {
  WEB_VFX_RUNTIME_V2_SCHEMA,
  assertWebVfxRuntimeV2,
  type WebVfxRuntimeV2,
} from '@vfx-factory/artifact-schema';

/** Input produced by the Unity/Quarks lowering stage. This boundary is
 * deliberately data-only: no Three.js or browser objects may cross it. */
export interface RuntimeArtifactInput {
  effectId: string;
  payload: Record<string, unknown>;
  sourceSchema?: string;
  resources?: Record<string, unknown>;
  materialVariants?: Record<string, unknown>;
  /** Always present, even when empty: proves semantic lowering ran offline. */
  cfxrState: Record<string, unknown>;
  runtimeConfig?: WebRuntimeArtifact['runtimeConfig'];
}

function assertJson(value: unknown, path: string): void {
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new Error(`Runtime artifact field '${path}' is not JSON serializable: ${String(error)}`);
  }
}

/** Package an already lowered Unity effect for the minimal online player. */
export function compileRuntimeArtifact(input: RuntimeArtifactInput): WebRuntimeArtifact {
  if (!input || typeof input.effectId !== 'string' || !input.effectId) {
    throw new Error('Runtime artifact requires a non-empty effectId.');
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new Error(`Runtime artifact '${input.effectId}' requires an object payload.`);
  }
  assertJson(input.payload, 'payload');
  if (input.resources != null) assertJson(input.resources, 'resources');
  if (input.materialVariants != null) assertJson(input.materialVariants, 'materialVariants');
  assertJson(input.cfxrState, 'cfxrState');
  return {
    schema: WEB_RUNTIME_ARTIFACT_SCHEMA,
    effectId: input.effectId,
    sourceSchema: input.sourceSchema,
    payload: input.payload,
    resources: input.resources,
    materialVariants: input.materialVariants,
    // An empty table is still explicit: it tells playback that semantic
    // lowering was completed and must not be re-run online.
    cfxrState: input.cfxrState,
    runtimeConfig: input.runtimeConfig,
  };
}

/** Wrap the runtime bundle in the envelope consumed by the player. */
export function compileArtifactEnvelope(input: RuntimeArtifactInput): Record<string, unknown> {
  const runtime = compileRuntimeArtifact(input);
  return {
    vfxIR: {
      schema: 'unity-vfx-ir@1',
      runtime: 'three-quarks-semantic@1',
      policy: 'strict',
      effectId: input.effectId,
      seed: 0,
      fixedDelta: 1 / 60,
      captureTimes: [0],
    },
    webRuntime: runtime,
  };
}

/**
 * Boundary for the new compiler. The input is already lowered into runtime
 * programs; this function only validates and packages it. Unity/Shader Graph
 * interpretation must happen before this boundary.
 */
export function writeRuntimeV2(artifact: WebVfxRuntimeV2): WebVfxRuntimeV2 {
  assertWebVfxRuntimeV2(artifact);
  if (artifact.schema !== WEB_VFX_RUNTIME_V2_SCHEMA) {
    throw new Error(`Unsupported runtime schema '${String(artifact.schema)}'.`);
  }
  const ids = new Set(artifact.materials.map((material) => material.id));
  for (const system of artifact.systems) {
    if (!ids.has(system.material)) throw new Error(`System '${system.id}' references missing material '${system.material}'.`);
  }
  return JSON.parse(JSON.stringify(artifact)) as WebVfxRuntimeV2;
}
