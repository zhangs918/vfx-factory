import adapterRegistry from './semantic-adapters';
import { assertVfxArtifact } from '@vfx-factory/artifact-schema';

export interface VfxSemanticContract {
  schema: 'unity-vfx-ir@1';
  runtime: 'three-quarks-semantic@1';
  policy: 'strict';
  representation?: 'live-particles@1' | 'camera-baked@1';
  effectId: string;
  seed: number;
  fixedDelta: number;
  referenceCamera: {
    projection: 'perspective';
    fov: number;
    near: number;
    far: number;
    position: [number, number, number];
    target: [number, number, number];
  };
  captureTimes: number[];
  lifecycle: {
    schema: 'effect-lifecycle@1';
    rootLoopPolicy: 'one-shot';
    terminalTime: number;
    terminalAction: 'stop-and-clear';
    timeDomain: 'unity-root-fixed-step@60hz';
  };
  qualification?: {
    status: 'candidate' | 'qualified';
    oracleRequired: boolean;
    simulationAdapters: Array<{
      id: string;
      version: number;
      kind: 'simulation' | 'scene-input' | 'geometry';
      fidelity: string;
      requiresOracle: boolean;
    }>;
  };
  editability?: {
    simulation: 'live' | 'hybrid-live';
    material: 'live-ir';
    spawnInitialization: 'calibrated-spawn-state@1' | 'deterministic-random-lanes@1';
    limitations: string[];
    plannedReplacement?: string;
  };
  diagnostics: Array<{
    severity: string;
    code: string;
    domain?: string;
    path: string;
    message: string;
    productionDisposition?: string;
    requiredAction?: string;
  }>;
}

/** Validate the artifact contract before any renderer or Quarks object is created. */
export function requireSemanticContract(raw: any): VfxSemanticContract {
  const artifactRead = assertVfxArtifact(raw);
  if (artifactRead.kind === 'artifact') {
    if (artifactRead.contract.disposition === 'rejected') {
      throw new Error(`Rejected VFX artifact '${artifactRead.contract.effect.id}' cannot be played.`);
    }
    const c = artifactRead.contract;
    raw.vfxIR = {
      schema: 'unity-vfx-ir@1', runtime: c.contract.runtime, policy: c.contract.policy,
      effectId: c.effect.id, seed: c.contract.seed, fixedDelta: c.contract.fixedDelta,
      referenceCamera: c.contract.referenceCamera, captureTimes: c.contract.captureTimes,
      lifecycle: c.contract.lifecycle, diagnostics: c.diagnostics,
    };
  }
  const ir = raw?.vfxIR as VfxSemanticContract | undefined;
  if (ir?.schema !== 'unity-vfx-ir@1' || ir.runtime !== 'three-quarks-semantic@1' || ir.policy !== 'strict') {
    throw new Error('Effect is not a strict unity-vfx-ir@1 export. Re-export it with the semantic exporter.');
  }
  const errors = (ir.diagnostics ?? []).filter((d) => d.severity === 'error');
  if (errors.length) {
    throw new Error(`Strict export contains unsupported semantics: ${errors.map((d) => `${d.code} at ${d.path}`).join(', ')}`);
  }
  const lifecycle = ir.lifecycle;
  if (lifecycle?.schema !== 'effect-lifecycle@1' || lifecycle.rootLoopPolicy !== 'one-shot'
      || lifecycle.terminalAction !== 'stop-and-clear' || lifecycle.timeDomain !== 'unity-root-fixed-step@60hz'
      || !(Number(lifecycle.terminalTime) > 0)
      || Number(lifecycle.terminalTime) > Math.max(...ir.captureTimes, 0) + 1e-6) {
    throw new Error('Effect lacks a valid effect-lifecycle@1 one-shot contract.');
  }
  for (const required of ir.qualification?.simulationAdapters ?? []) {
    const adapter = adapterRegistry.adapters.find((candidate) => candidate.id === required.id
      && candidate.version === required.version && candidate.kind === required.kind);
    if (!adapter) throw new Error(`Missing semantic adapter ${required.id}@${required.version} (${required.kind})`);
  }
  const controllers = raw?.controllers ?? [];
  if (!Array.isArray(controllers)) throw new Error('Effect controllers must be an array.');
  if (controllers.length && !(ir.qualification?.simulationAdapters ?? []).some(
    (adapter) => adapter.id === 'unity-effect-controller' && adapter.version === 1,
  )) throw new Error('Effect has controllers but lacks unity-effect-controller@1 in its contract.');
  const nodeIds = new Set<string>();
  const collectNodes = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.uuid === 'string') nodeIds.add(node.uuid);
    if (Array.isArray(node.children)) node.children.forEach(collectNodes);
  };
  collectNodes(raw?.object);
  for (const controller of controllers) {
    if (controller?.schema !== 'effect-controller@1') throw new Error(`Unsupported effect controller schema '${controller?.schema}'`);
    if (controller.kind === 'projectile-host-motion') {
      if (controller.lowering !== 'runtime-input-contract@1' || controller.activation !== 'host-event:Fire'
          || !nodeIds.has(controller.targetNode) || !(Number(controller.speed) >= 0) || !(Number(controller.distance) >= 0))
        throw new Error('Invalid projectile-host-motion controller contract.');
    } else if (controller.kind === 'capsule-grounded-emitter-gate') {
      if (controller.lowering !== 'reference-scene-schedule@1' || controller.activation !== 'grounded-rising-edge'
          || controller.sceneQuery !== 'reference-ground-plane@1' || !nodeIds.has(controller.sourceEmitter)
          || !nodeIds.has(controller.targetEmitter) || !(Number(controller.capsuleRadius) >= 0)
          || !(Number(controller.maxDistance) >= 0)) throw new Error('Invalid capsule-grounded-emitter-gate controller contract.');
    } else if (controller.kind === 'deterministic-light-fade') {
      if (controller.lowering !== 'deterministic-light-fade@1' || controller.activation !== 'effect-enable'
          || !nodeIds.has(controller.targetNode) || !Array.isArray(controller.position) || controller.position.length !== 3
          || !Array.isArray(controller.color) || controller.color.length !== 3 || !(Number(controller.range) >= 0)
          || !(Number(controller.baseIntensity) >= 0) || !(Number(controller.finalIntensity) >= 0)
          || !(Number(controller.delay) >= 0) || !(Number(controller.duration) > 0))
        throw new Error('Invalid deterministic-light-fade controller contract.');
    } else if (controller.kind === 'constant-euler-rotation') {
      if (controller.lowering !== 'constant-euler-rotation@1' || controller.activation !== 'effect-enable'
          || !nodeIds.has(controller.targetNode) || !Array.isArray(controller.degreesPerSecond)
          || controller.degreesPerSecond.length !== 3 || !controller.degreesPerSecond.every((value: unknown) => Number.isFinite(Number(value)))
          || (controller.space !== 'self' && controller.space !== 'world'))
        throw new Error('Invalid constant-euler-rotation controller contract.');
    } else if (controller.kind === 'sampled-unity-perlin-light') {
      if (controller.lowering !== 'sampled-unity-perlin-light@1' || controller.activation !== 'effect-enable'
          || !nodeIds.has(controller.targetNode) || !Array.isArray(controller.position) || controller.position.length !== 3
          || !Array.isArray(controller.color) || controller.color.length !== 3 || !(Number(controller.range) >= 0)
          || !(Number(controller.baseIntensity) >= 0) || !Number.isFinite(Number(controller.addIntensity))
          || !(Number(controller.smoothFactor) >= 0) || !(Number(controller.domainStep) > 0)
          || !Array.isArray(controller.samples) || controller.samples.length < 2)
        throw new Error('Invalid sampled-unity-perlin-light controller contract.');
    } else throw new Error(`Unsupported effect controller kind '${controller.kind}'`);
  }
  return ir;
}
