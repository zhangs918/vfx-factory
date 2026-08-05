import {
  WEB_RUNTIME_ARTIFACT_SCHEMA,
  type WebRuntimeArtifact,
} from '@vfx-factory/artifact-schema';

/** Input produced by the Unity/Quarks lowering stage. This boundary is
 * deliberately data-only: no Three.js or browser objects may cross it. */
export interface RuntimeArtifactInput {
  effectId: string;
  payload: Record<string, unknown>;
  sourceSchema?: string;
  resources?: Record<string, unknown>;
  materialVariants?: Record<string, unknown>;
  cfxrState?: Record<string, unknown>;
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
  if (input.cfxrState != null) assertJson(input.cfxrState, 'cfxrState');
  return {
    schema: WEB_RUNTIME_ARTIFACT_SCHEMA,
    effectId: input.effectId,
    sourceSchema: input.sourceSchema,
    payload: input.payload,
    resources: input.resources,
    materialVariants: input.materialVariants,
    cfxrState: input.cfxrState,
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

