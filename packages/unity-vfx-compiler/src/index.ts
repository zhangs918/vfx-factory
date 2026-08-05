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

export interface CompilerDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  path: string;
  message: string;
}

export interface SourceCompileResult {
  artifact?: WebVfxRuntimeV2;
  diagnostics: CompilerDiagnostic[];
}

const numberValue = (value: any, fallback = 0) =>
  typeof value === 'number' ? value : Number(value?.value ?? fallback);

const COVERAGE_TINT_VERTEX = `
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
attribute vec3 instancePosition;
attribute vec3 instanceSize;
attribute vec4 instanceColor;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vUv = uv;
  vColor = color * instanceColor;
  vec3 p = position * instanceSize + instancePosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const COVERAGE_TINT_FRAGMENT = `
precision highp float;
uniform sampler2D uMainMap;
uniform sampler2D uMask;
uniform sampler2D uSceneColor;
uniform float uUseMask;
uniform float uUseSceneColor;
uniform vec4 uTint;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 texel = texture2D(uMainMap, vUv);
  float coverage = texel.r;
  if (uUseMask > 0.5) coverage *= texture2D(uMask, vUv).r;
  vec3 rgb = uTint.rgb * vColor.rgb;
  if (uUseSceneColor > 0.5) rgb += texture2D(uSceneColor, vUv).rgb;
  float alpha = coverage * uTint.a * vColor.a;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(rgb, alpha);
}`;

function walkNodes(node: any, visit: (node: any) => void): void {
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node.children)) node.children.forEach((child: any) => walkNodes(child, visit));
}

function renderModeOf(value: number): 'billboard' | 'stretched-billboard' | 'mesh' | 'trail' {
  if (value === 2) return 'mesh';
  if (value === 1) return 'stretched-billboard';
  if (value === 3) return 'trail';
  return 'billboard';
}

/** Lower the subset already represented by the exporter material IR. */
export function compileLegacyQuarksSource(source: any, compilerVersion = 'unity-vfx-compiler@0.2'): SourceCompileResult {
  const diagnostics: CompilerDiagnostic[] = [];
  const materials = new Map<string, any>();
  for (const material of source?.materials ?? []) materials.set(material.uuid, material);
  const resources: WebVfxRuntimeV2['resources'] = [];
  for (const texture of source?.textures ?? []) {
    const image = (source.images ?? []).find((entry: any) => entry.uuid === texture.image);
    if (!image?.url) {
      diagnostics.push({ severity: 'error', code: 'TEXTURE_IMAGE_MISSING', path: `$.textures.${texture.uuid}`, message: `Texture '${texture.uuid}' has no image URL.` });
      continue;
    }
    resources.push({ id: texture.uuid, kind: 'texture', uri: image.url, colorSpace: image.sRGB ? 'srgb' : 'linear' });
  }
  const runtimeMaterials: WebVfxRuntimeV2['materials'] = [];
  for (const material of materials.values()) {
    const program = material.vfxProgram;
    if (!program || program.schema !== 'particle-material-program@2') {
      diagnostics.push({ severity: 'error', code: 'MATERIAL_PROGRAM_MISSING', path: `$.materials.${material.uuid}`, message: `Material '${material.name ?? material.uuid}' has no explicit material program.` });
      continue;
    }
    if (program.lowering !== 'verified-supported-subset' && program.lowering !== 'slash-screen@2') {
      diagnostics.push({ severity: 'error', code: 'MATERIAL_LOWERING_UNSUPPORTED', path: `$.materials.${material.uuid}.vfxProgram.lowering`, message: `Unsupported material lowering '${program.lowering}'.` });
      continue;
    }
    const supportedOperations = new Set([
      'sample-main', 'coverage', 'vertex-color', 'tint', 'dissolve',
      'soft-particle-depth', 'dynamic-alpha-clip', 'hdr-multiply', 'blend',
      'manual-graph-lowering', 'mask',
    ]);
    for (const operation of program.operations ?? []) {
      if (!supportedOperations.has(operation.op)) {
        diagnostics.push({ severity: 'error', code: 'MATERIAL_OPERATION_UNSUPPORTED', path: `$.materials.${material.uuid}.vfxProgram.operations`, message: `Operation '${operation.op}' is not implemented by the runtime@2 shader compiler.` });
      }
      if (operation.op === 'manual-graph-lowering' && operation.id !== 'slash-screen@2') {
        diagnostics.push({ severity: 'error', code: 'MANUAL_LOWERING_UNSUPPORTED', path: `$.materials.${material.uuid}.vfxProgram.operations`, message: `Manual lowering '${operation.id}' is not implemented by the runtime@2 shader compiler.` });
      }
    }
    const shaderId = `shader-${material.uuid}`;
    runtimeMaterials.push({
      id: material.uuid,
      vertexShader: COVERAGE_TINT_VERTEX,
      fragmentShader: COVERAGE_TINT_FRAGMENT,
      textures: Object.fromEntries(Object.entries(material.maps ?? {}).map(([slot, id]) => [slot, String(id)])),
      uniforms: {
        color: material.color ?? [1, 1, 1, 1],
        operations: program.operations ?? [],
        uUseMask: (program.operations ?? []).some((operation: any) => operation.op === 'mask') ? 1 : 0,
        uUseSceneColor: (program.operations ?? []).some((operation: any) => operation.op === 'manual-graph-lowering' && operation.id === 'slash-screen@2') ? 1 : 0,
      },
      renderState: {
        blend: program.blend === 'additive' ? 'additive' : program.blend === 'premultiplied-alpha' ? 'premultiplied' : program.blend === 'multiply' ? 'multiply' : program.blend === 'opaque' ? 'opaque' : 'alpha',
        depthTest: material.depthTest !== false,
        depthWrite: material.depthWrite === true,
        cull: 'none',
        alphaTest: Number(material.alphaTest ?? 0),
        toneMapped: false,
      },
    });
  }
  const programs: WebVfxRuntimeV2['programs'] = [];
  const systems: WebVfxRuntimeV2['systems'] = [];
  walkNodes(source?.object, (node) => {
    if (node.type !== 'ParticleEmitter' || !node.ps || !node.uuid) return;
    const ps = node.ps;
    const behaviorIds: string[] = [];
    for (const behavior of ps.behaviors ?? []) {
      const supported = new Set(['ColorOverLife', 'SizeOverLife', 'FrameOverLife', 'LimitSpeedOverLife', 'RotationOverLife']);
      if (!supported.has(behavior.type)) {
        diagnostics.push({ severity: 'error', code: 'BEHAVIOR_UNSUPPORTED', path: `$.object.${node.uuid}.ps.behaviors`, message: `Behavior '${behavior.type}' is not yet compiled by runtime@2.` });
        continue;
      }
      const id = `${node.uuid}:${behavior.type}`;
      behaviorIds.push(id);
      programs.push({ id, op: behavior.type, params: behavior });
    }
    const startDelay = numberValue(ps.startDelay);
    systems.push({
      id: node.uuid,
      nodeId: node.uuid,
      material: String(ps.material),
      capacity: Math.max(1, Number(ps.maxParticles ?? 256)),
      duration: Math.max(0, Number(ps.duration ?? 0)),
      particleLife: Math.max(0.0001, numberValue(ps.startLife, Number(ps.duration ?? 1))),
      looping: !!ps.looping,
      startDelay,
      emission: {
        bursts: (ps.emissionBursts ?? []).map((burst: any) => ({ time: Number(burst.time ?? 0), count: Math.max(0, Math.floor(numberValue(burst.count))) })),
        rateOverTime: numberValue(ps.emissionOverTime),
      },
      renderMode: renderModeOf(Number(ps.renderMode ?? 0)),
      programs: behaviorIds,
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    });
  });
  if (diagnostics.some((entry) => entry.severity === 'error')) return { diagnostics };
  const contract = source.vfxIR ?? {};
  return {
    diagnostics,
    artifact: writeRuntimeV2({
      schema: 'web-vfx-runtime@2',
      effectId: String(contract.effectId ?? source.object?.name ?? 'effect'),
      compilerVersion,
      seed: Number(contract.seed ?? 1),
      fixedDelta: Number(contract.fixedDelta ?? 1 / 60),
      duration: Number(contract.lifecycle?.terminalTime ?? 0),
      looping: false,
      resources,
      materials: runtimeMaterials,
      programs,
      systems,
    }),
  };
}

/**
 * Classify a Unity/Quarks source document before lowering. This deliberately
 * does not emit a fake runtime artifact: unsupported source semantics become
 * diagnostics and must be implemented by a compiler pass before promotion.
 */
export function compileSourceJson(source: unknown): SourceCompileResult {
  const diagnostics: CompilerDiagnostic[] = [];
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { diagnostics: [{ severity: 'error', code: 'SOURCE_NOT_OBJECT', path: '$', message: 'Source document must be an object.' }] };
  }
  const value = source as Record<string, unknown>;
  const contract = value.vfxIR;
  if (!contract || typeof contract !== 'object') {
    diagnostics.push({ severity: 'error', code: 'MISSING_SOURCE_CONTRACT', path: '$.vfxIR', message: 'Unity source is missing the semantic contract.' });
  }
  if (!value.object || typeof value.object !== 'object') {
    diagnostics.push({ severity: 'error', code: 'MISSING_OBJECT', path: '$.object', message: 'Unity source is missing its Object3D hierarchy.' });
  }
  if (!Array.isArray(value.materials)) {
    diagnostics.push({ severity: 'error', code: 'MISSING_MATERIALS', path: '$.materials', message: 'Unity source is missing serialized materials.' });
  }
  if (!Array.isArray(value.textures)) {
    diagnostics.push({ severity: 'error', code: 'MISSING_TEXTURES', path: '$.textures', message: 'Unity source is missing serialized textures.' });
  }
  diagnostics.push({
    severity: 'info',
    code: 'LOWERING_REQUIRED',
    path: '$',
    message: 'Source is valid legacy IR but has not yet been lowered to web-vfx-runtime@2.',
  });
  return { diagnostics };
}
