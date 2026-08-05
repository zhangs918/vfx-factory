import {
  Group,
  Object3D,
  AdditiveBlending,
  AddEquation,
  CustomBlending,
  DstColorFactor,
  OneFactor,
  OneMinusSrcAlphaFactor,
  NormalBlending,
  ZeroFactor,
  SrcColorFactor,
  DoubleSide,
  DepthTexture,
  WebGLRenderTarget,
  LinearFilter,
  RGBAFormat,
  Vector2,
  Vector3,
  Euler,
  Quaternion,
  UnsignedIntType,
  type Texture,
  type WebGLRenderer,
  type Scene,
  type Camera,
} from 'three';
import { BatchedRenderer, QuarksLoader, QuarksUtil } from 'three.quarks';
import { setPhysicsResolver } from 'quarks.core';
import adapterRegistry from '../../config/semantic-adapters.json';
import { assertVfxArtifact } from '@vfx-factory/artifact-schema';
import { registerUnityEmitterShapes } from './unityEmitterShapes';
import {
  expandCfxrRingGeometry,
  extractStartDelays,
  setDissolveCurvesFromJson,
  setCfxrPropsFromJson,
  patchCfxrBeforeBatch,
  patchCfxrAfterBatch,
  createStartDelayGate,
  armStartDelays,
  tickStartDelays,
  CfxrEffectLight,
  cfxrNeedsSceneColor,
  setCfxrSceneColorTexture,
  setCfxrEffectTime,
  updateCfxrCustomAttributes,
  type StartDelayGate,
  type CfxrMaterialProps,
} from './cfxrQuarksFidelity';

registerUnityEmitterShapes();

// Default host implementation for particle-scene-query@1 used by the reference stage. A game
// integration can replace this global Quarks resolver with its own collider/physics adapter.
setPhysicsResolver({
  resolve(position, normal) {
    if (position.y > 0) return false;
    position.y = 0;
    normal.set(0, 1, 0);
    return true;
  },
});

export interface QuarksManifestEntry {
  id: string;
  label: string;
  file: string;
  note?: string;
}

export interface QuarksManifest {
  effects: QuarksManifestEntry[];
}

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

export interface ParticleStateSnapshot {
  schema: 'web-particle-state@2';
  effectId: string;
  seed: number;
  simulationTime: number;
  simulationUpdates: number[];
  bakedFrame?: number;
  emitters: Array<{
    id: string;
    name: string;
    path: string;
    count: number;
    particles: Array<{
      position: [number, number, number];
      velocity: [number, number, number];
      size: [number, number, number];
      color: [number, number, number, number];
      age: number;
      life: number;
      frame: number;
      seed?: number;
      rotation?: number | [number, number, number, number] | null;
      rotationEuler?: number[];
      custom1?: [number, number, number, number];
    }>;
  }>;
}

/** Small deterministic PRNG used to make every Quarks Math.random call reproducible. */
class SeededRandom {
  private state = 1;

  reset(seed: number) {
    this.state = (Number.isFinite(seed) ? seed : 1) >>> 0;
    if (this.state === 0) this.state = 1;
  }

  next = () => {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function requireSemanticContract(raw: any): VfxSemanticContract {
  // Protocol boundary: every player load now enters through the neutral artifact
  // reader. The legacy unity-vfx-ir shape remains accepted only as an explicit
  // migration path; no renderer code should need to know which envelope it got.
  const artifactRead = assertVfxArtifact(raw);
  if (artifactRead.kind === 'artifact') {
    if (artifactRead.contract.disposition === 'rejected') {
      throw new Error(`Rejected VFX artifact '${artifactRead.contract.effect.id}' cannot be played.`);
    }
    const c = artifactRead.contract;
    raw.vfxIR = {
      schema: 'unity-vfx-ir@1',
      runtime: c.contract.runtime,
      policy: c.contract.policy,
      effectId: c.effect.id,
      seed: c.contract.seed,
      fixedDelta: c.contract.fixedDelta,
      referenceCamera: c.contract.referenceCamera,
      captureTimes: c.contract.captureTimes,
      lifecycle: c.contract.lifecycle,
      diagnostics: c.diagnostics,
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
  if (lifecycle?.schema !== 'effect-lifecycle@1'
      || lifecycle.rootLoopPolicy !== 'one-shot'
      || lifecycle.terminalAction !== 'stop-and-clear'
      || lifecycle.timeDomain !== 'unity-root-fixed-step@60hz'
      || !(Number(lifecycle.terminalTime) > 0)
      || Number(lifecycle.terminalTime) > Math.max(...ir.captureTimes, 0) + 1e-6) {
    throw new Error('Effect lacks a valid effect-lifecycle@1 one-shot contract.');
  }
  for (const required of ir.qualification?.simulationAdapters ?? []) {
    const adapter = adapterRegistry.adapters.find((candidate) => candidate.id === required.id
      && candidate.version === required.version && candidate.kind === required.kind);
    if (!adapter) {
      throw new Error(`Missing semantic adapter ${required.id}@${required.version} (${required.kind})`);
    }
  }
  const controllers = raw?.controllers ?? [];
  if (!Array.isArray(controllers)) throw new Error('Effect controllers must be an array.');
  if (controllers.length && !(ir.qualification?.simulationAdapters ?? []).some(
    (adapter) => adapter.id === 'unity-effect-controller' && adapter.version === 1,
  )) {
    throw new Error('Effect has controllers but lacks unity-effect-controller@1 in its contract.');
  }
  const nodeIds = new Set<string>();
  const collectNodes = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.uuid === 'string') nodeIds.add(node.uuid);
    if (Array.isArray(node.children)) node.children.forEach(collectNodes);
  };
  collectNodes(raw?.object);
  for (const controller of controllers) {
    if (controller?.schema !== 'effect-controller@1') {
      throw new Error(`Unsupported effect controller schema '${controller?.schema}'`);
    }
    if (controller.kind === 'projectile-host-motion') {
      if (controller.lowering !== 'runtime-input-contract@1'
          || controller.activation !== 'host-event:Fire'
          || !nodeIds.has(controller.targetNode)
          || !(Number(controller.speed) >= 0) || !(Number(controller.distance) >= 0)) {
        throw new Error('Invalid projectile-host-motion controller contract.');
      }
    } else if (controller.kind === 'capsule-grounded-emitter-gate') {
      if (controller.lowering !== 'reference-scene-schedule@1'
          || controller.activation !== 'grounded-rising-edge'
          || controller.sceneQuery !== 'reference-ground-plane@1'
          || !nodeIds.has(controller.sourceEmitter) || !nodeIds.has(controller.targetEmitter)
          || !(Number(controller.capsuleRadius) >= 0) || !(Number(controller.maxDistance) >= 0)) {
        throw new Error('Invalid capsule-grounded-emitter-gate controller contract.');
      }
    } else if (controller.kind === 'deterministic-light-fade') {
      if (controller.lowering !== 'deterministic-light-fade@1'
          || controller.activation !== 'effect-enable'
          || !nodeIds.has(controller.targetNode)
          || !Array.isArray(controller.position) || controller.position.length !== 3
          || !Array.isArray(controller.color) || controller.color.length !== 3
          || !(Number(controller.range) >= 0) || !(Number(controller.baseIntensity) >= 0)
          || !(Number(controller.finalIntensity) >= 0) || !(Number(controller.delay) >= 0)
          || !(Number(controller.duration) > 0)) {
        throw new Error('Invalid deterministic-light-fade controller contract.');
      }
    } else if (controller.kind === 'constant-euler-rotation') {
      if (controller.lowering !== 'constant-euler-rotation@1'
          || controller.activation !== 'effect-enable'
          || !nodeIds.has(controller.targetNode)
          || !Array.isArray(controller.degreesPerSecond) || controller.degreesPerSecond.length !== 3
          || !controller.degreesPerSecond.every((value: unknown) => Number.isFinite(Number(value)))
          || (controller.space !== 'self' && controller.space !== 'world')) {
        throw new Error('Invalid constant-euler-rotation controller contract.');
      }
    } else if (controller.kind === 'sampled-unity-perlin-light') {
      if (controller.lowering !== 'sampled-unity-perlin-light@1'
          || controller.activation !== 'effect-enable'
          || !nodeIds.has(controller.targetNode)
          || !Array.isArray(controller.position) || controller.position.length !== 3
          || !Array.isArray(controller.color) || controller.color.length !== 3
          || !(Number(controller.range) >= 0) || !(Number(controller.baseIntensity) >= 0)
          || !Number.isFinite(Number(controller.addIntensity))
          || !(Number(controller.smoothFactor) >= 0) || !(Number(controller.domainStep) > 0)
          || !Array.isArray(controller.samples) || controller.samples.length < 2) {
        throw new Error('Invalid sampled-unity-perlin-light controller contract.');
      }
    } else {
      throw new Error(`Unsupported effect controller kind '${controller.kind}'`);
    }
  }
  return ir;
}

/**
 * Normalize babylon/unity-quarks-exporter JSON so three.quarks ObjectLoader can parse it.
 * Exporter emits QuarksMaterial / QuarksGeometry which MaterialLoader doesn't know.
 */
export function normalizeUnityQuarksJson(json: any): any {
  expandCfxrRingGeometry(json);

  // Legacy/oversized exports can lose an editor-only mesh reference. Keep them loadable with
  // an explicit editable quad fallback; new exports still carry the authored mesh and basis.
  if (!Array.isArray(json.geometries)) json.geometries = [];
  const fallbackGeometryUuid = '__unity_mesh_fallback_quad@1';
  if (!json.geometries.some((g: any) => g?.uuid === fallbackGeometryUuid)) {
    json.geometries.push({
      uuid: fallbackGeometryUuid,
      type: 'QuarksGeometry',
      positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
      indices: [0, 2, 1, 0, 3, 2],
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    });
  }
  const patchMissingMeshBasis = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.ps?.renderMode === 2
        && (!o.ps.unityMeshRendererBasis || !o.ps.instancingGeometry)) {
      o.ps.instancingGeometry = fallbackGeometryUuid;
      o.ps.unityMeshRendererBasis = {
        schema: 'unity-mesh-renderer-basis@1', pivot: [0, 0, 0],
        scaleSource: 'particle-current-size', handedness: 'reflect-z-once',
        lowering: 'missing-source-quad-fallback@1',
      };
    }
    if (Array.isArray(o.children)) o.children.forEach(patchMissingMeshBasis);
  };
  patchMissingMeshBasis(json.object);

  // Compile Unity's renderer pivot into the unit Mesh before Quarks creates its instancing
  // geometry. Pivot is measured in particle-size units and therefore must be applied before
  // the per-particle current-size and quaternion TRS. Shape/hierarchy scales are deliberately
  // absent from this operation: each coordinate-space transform has one owner.
  const geometries = new Map<string, any>();
  for (const geometry of json.geometries ?? []) geometries.set(geometry.uuid, geometry);
  const lowerMeshBasis = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.ps?.unitySubEmitterLifecycle) {
      const lifecycle = o.ps.unitySubEmitterLifecycle;
      if (lifecycle.schema !== 'unity-sub-emitter-lifecycle@1'
          || lifecycle.ownership !== 'parent-event'
          || lifecycle.looping !== true
          || lifecycle.termination !== 'child-duration'
          || o.ps.onlyUsedByOther !== true
          || o.ps.looping !== true
          || o.ps.unitySpawnSchedule
          || o.ps.unityInitialState
          || o.ps.unityTrajectoryCache) {
        throw new Error(`Emitter ${o.name ?? o.uuid} has an invalid live sub-emitter lifecycle contract`);
      }
    }
    if (o.type === 'ParticleEmitter' && Array.isArray(o.ps?.behaviors)) {
      for (const behavior of o.ps.behaviors) {
        if (behavior?.type !== 'EmitSubParticleSystem') continue;
        const inheritance = behavior.unityInheritance;
        if (inheritance?.schema !== 'unity-sub-emitter-inheritance@1'
            || typeof inheritance.size !== 'boolean'
            || typeof inheritance.color !== 'boolean'
            || typeof inheritance.rotation !== 'boolean'
            || typeof inheritance.lifetime !== 'boolean') {
          throw new Error(`Emitter ${o.name ?? o.uuid} has an unsupported sub-emitter inheritance contract`);
        }
      }
    }
    if (o.type === 'ParticleEmitter' && o.ps?.renderMode === 2) {
      const alignment = o.ps.unityRendererAlignment;
      if (alignment?.schema === 'unity-renderer-alignment@1'
          && alignment.lowering === 'local-billboard-instanced-quad') {
        if (alignment.sourceRenderMode !== 'Billboard' || alignment.alignment !== 'Local')
          throw new Error(`Emitter ${o.name ?? o.uuid} has an invalid local billboard lowering`);
      }
      const basis = o.ps.unityMeshRendererBasis;
      if (basis?.schema !== 'unity-mesh-renderer-basis@1') {
        throw new Error(`Mesh emitter ${o.name ?? o.uuid} lacks unity-mesh-renderer-basis@1`);
      }
      const geometry = geometries.get(o.ps.instancingGeometry);
      const pivot = basis.pivot;
      if (!geometry || !Array.isArray(geometry.positions) || !Array.isArray(pivot)) {
        throw new Error(`Mesh emitter ${o.name ?? o.uuid} has an invalid renderer basis`);
      }
      if (!geometry.__unityMeshBasisLowered) {
        for (let i = 0; i + 2 < geometry.positions.length; i += 3) {
          geometry.positions[i] -= Number(pivot[0]) || 0;
          geometry.positions[i + 1] -= Number(pivot[1]) || 0;
          geometry.positions[i + 2] -= Number(pivot[2]) || 0;
        }
        geometry.__unityMeshBasisLowered = true;
      }
    }
    if (Array.isArray(o.children)) o.children.forEach(lowerMeshBasis);
  };
  lowerMeshBasis(json.object);

  // Exporter attaches "(emitter source)" Mesh nodes for mesh_surface shape references.
  // They carry no material — ObjectLoader would render them as default white meshes.
  const hideSourceMeshes = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'Mesh' && typeof o.name === 'string' && o.name.endsWith('(emitter source)')) {
      o.visible = false;
    }
    if (Array.isArray(o.children)) o.children.forEach(hideSourceMeshes);
  };
  hideSourceMeshes(json.object);

  if (Array.isArray(json.materials)) {
    for (const m of json.materials) {
      if (m.type !== 'QuarksMaterial' && m.type !== 'MeshBasicMaterial') continue;
      const quarksBlend = m.blending ?? m.alphaMode ?? 2; // 1=add, 2=alpha
      const program = m.vfxProgram as { schema?: string; profile?: CfxrMaterialProps; blend?: string } | undefined;
      if (program?.schema !== 'particle-material-program@2') {
        throw new Error(`Material ${m.name ?? m.uuid} has no strict particle material program`);
      }
      const semanticProfile = program.profile;
      const additive = program.blend === 'additive' || quarksBlend === 1;
      const multiply = program.blend === 'multiply' || quarksBlend === 4;
      const legacyMultiply = !!semanticProfile?.legacyMultiply;
      const legacyPremultiply = program.blend === 'premultiplied-alpha' || !!semanticProfile?.legacyPremultiply;
      m.type = 'MeshBasicMaterial';
      m.map = m.map ?? m.texture;
      m.transparent = m.transparent !== false;
      m.depthWrite = false;
      m.depthTest = m.depthTest !== false;
      m.side = DoubleSide;
      m.toneMapped = false;
      if (legacyMultiply) {
        m.blending = CustomBlending;
        m.blendEquation = AddEquation;
        m.blendSrc = ZeroFactor;
        m.blendDst = SrcColorFactor;
        m.blendEquationAlpha = AddEquation;
        m.blendSrcAlpha = ZeroFactor;
        m.blendDstAlpha = OneFactor;
        m.premultipliedAlpha = false;
      } else if (legacyPremultiply) {
        m.blending = CustomBlending;
        m.blendEquation = AddEquation;
        m.blendSrc = OneFactor;
        m.blendDst = OneMinusSrcAlphaFactor;
        m.blendEquationAlpha = AddEquation;
        m.blendSrcAlpha = ZeroFactor;
        m.blendDstAlpha = OneFactor;
        m.premultipliedAlpha = false;
      } else if (multiply) {
        // Unity shader source declares Blend DstColor Zero. Three's MultiplyBlending preset
        // retains OneMinusSrcAlpha, making transparent texels draw visible rectangular quads.
        m.blending = CustomBlending;
        m.blendEquation = AddEquation;
        m.blendSrc = DstColorFactor;
        m.blendDst = ZeroFactor;
        m.blendEquationAlpha = AddEquation;
        m.blendSrcAlpha = ZeroFactor;
        m.blendDstAlpha = OneFactor;
        m.premultipliedAlpha = false;
      } else {
        m.blending = additive ? AdditiveBlending : NormalBlending;
        m.premultipliedAlpha = false;
      }
      if (typeof m.alphaTest === 'number' && m.alphaTest > 0) {
        m.alphaTest = m.alphaTest;
      }
      // ObjectLoader wants 0xRRGGBB. HDR punch lives in `cfxr.hdrMultiply` / fidelity shader;
      // here only keep displayable chroma for the MeshBasicMaterial stand-in.
      if (Array.isArray(m.color) && m.color.length >= 3) {
        let r = Number(m.color[0]) || 0;
        let g = Number(m.color[1]) || 0;
        let b = Number(m.color[2]) || 0;
        const peak = Math.max(r, g, b, 1e-4);
        if (peak > 1) {
          r /= peak;
          g /= peak;
          b /= peak;
        }
        const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
        m.color =
          (Math.round(clamp01(r) * 255) << 16) |
          (Math.round(clamp01(g) * 255) << 8) |
          Math.round(clamp01(b) * 255);
      }
      m.userData = {
        ...(m.userData || {}),
        vfxProgram: program,
        cfxrProps: semanticProfile ?? null,
        maps: m.maps ?? null,
        alphaClip: !!m.alphaClip,
      };
      delete m.texture;
      delete m.alphaMode;
      delete m.reflectionAtlas;
      delete m.reflectionLevel;
      delete m.maps;
      delete m.alphaClip;
      delete m.shader;
      delete m.vfxProgram;
      delete m.cfxr;
    }
  }

  if (Array.isArray(json.geometries)) {
    for (const g of json.geometries) {
      if (g.type !== 'QuarksGeometry') continue;
      const positions = g.positions ?? [];
      const indices = g.indices ?? [];
      const uvs = g.uvs ?? [];
      const uv1s = g.uv1s ?? [];
      const normals = g.normals ?? [];
      g.type = 'BufferGeometry';
      g.data = {
        attributes: {
          position: { itemSize: 3, type: 'Float32Array', array: positions },
          ...(uvs.length
            ? { uv: { itemSize: 2, type: 'Float32Array', array: uvs } }
            : {}),
          ...(uv1s.length
            ? { uv1: { itemSize: 2, type: 'Float32Array', array: uv1s } }
            : {}),
          ...(normals.length
            ? { normal: { itemSize: 3, type: 'Float32Array', array: normals } }
            : {}),
        },
        index: indices.length ? { type: 'Uint32Array', array: indices } : undefined,
      };
      delete g.positions;
      delete g.indices;
      delete g.uvs;
      delete g.uv1s;
      delete g.normals;
    }
  }

  return json;
}

/**
 * Loads Unity→Quarks JSON and plays it via three.quarks (WebGL BatchedRenderer).
 */
export class QuarksEffectPlayer {
  readonly root = new Group();
  readonly batchRenderer = new BatchedRenderer();
  readonly effectLight = new CfxrEffectLight();
  private effectRoot: Object3D | null = null;
  private playing = false;
  private label = '';
  private delayGate: StartDelayGate = createStartDelayGate(new Map());
  private sceneColorRT: WebGLRenderTarget | null = null;
  private contract: VfxSemanticContract | null = null;
  private readonly random = new SeededRandom();
  private effectElapsed = 0;
  private simulationUpdates: number[] = [];
  private autoRotations: Array<{
    target: Object3D;
    baseQuaternion: Quaternion;
    radiansPerSecond: [number, number, number];
    space: 'self' | 'world';
  }> = [];

  constructor() {
    this.root.name = 'QuarksEffectPlayer';
    this.root.add(this.batchRenderer);
    this.effectLight.attach(this.root);
  }

  get isPlaying() {
    return this.playing;
  }

  get currentLabel() {
    return this.label;
  }

  /** URL-debug-safe state: lets regression tooling prove lifecycle progress without pixels. */
  get debugLifecycleState() {
    return {
      playing: this.playing,
      elapsed: this.effectElapsed,
      lifecycle: this.contract?.lifecycle ?? null,
    };
  }

  async loadAndPlay(url: string, label: string): Promise<void> {
    this.clear();
    this.label = label;

    const res = await fetch(url);
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || !ct.includes('json')) {
      throw new Error(
        `缺少导出文件: ${url}\n请按 tools/unity-quarks-exporter/EXPORT_GUIDE.zh-CN.md 从 Unity 导出。\n` +
          `保存为 public/assets/quarks/ 下的 JSON 后刷新本页。`,
      );
    }
    const raw = await res.json();
    this.contract = requireSemanticContract(raw);
    this.effectElapsed = 0;
    setCfxrEffectTime(0);
    this.random.reset(this.contract.seed);
    if (this.contract.representation === 'camera-baked@1') {
      throw new Error('camera-baked@1 is an offline regression oracle and cannot be played in production.');
    }
    this.delayGate = createStartDelayGate(extractStartDelays(raw));
    setDissolveCurvesFromJson(raw);
    setCfxrPropsFromJson(raw);
    const lightController = Array.isArray(raw.controllers)
      ? raw.controllers.find((controller: any) => controller?.kind === 'deterministic-light-fade'
          || controller?.kind === 'sampled-unity-perlin-light')
      : undefined;
    this.hasEffectLight = !!raw.cfxrEffect || !!lightController;
    if (lightController?.kind === 'deterministic-light-fade') {
      this.effectLight.configure({
        mode: 'linear-fade',
        intensityStart: Number(lightController.baseIntensity),
        intensityEnd: Number(lightController.finalIntensity),
        delay: Number(lightController.delay),
        duration: Number(lightController.duration),
        color: lightController.color,
        range: Number(lightController.range),
        position: lightController.position,
        // Reference-stage calibration between Unity built-in Light.intensity and
        // the non-physical three.js stage lighting units. Kept explicit here.
        intensityScale: 2.8,
      });
    } else if (lightController?.kind === 'sampled-unity-perlin-light') {
      this.effectLight.configure({
        mode: 'sampled-flicker',
        intensityStart: Number(lightController.baseIntensity),
        flickerAdd: Number(lightController.addIntensity),
        flickerSmooth: Number(lightController.smoothFactor),
        flickerPhase: Number(lightController.referencePhase ?? 0),
        flickerDomainStep: Number(lightController.domainStep),
        flickerSamples: lightController.samples.map(Number),
        color: lightController.color,
        range: Number(lightController.range),
        position: lightController.position,
        intensityScale: 2.8,
      });
    } else if (this.hasEffectLight) this.effectLight.configure(raw.cfxrEffect);
    else this.effectLight.stop();
    const json = normalizeUnityQuarksJson(raw);
    const loader = new QuarksLoader();
    const obj = await new Promise<Object3D>((resolve, reject) => {
      try {
        this.withSeededRandom(() => loader.parse(json, (ready) => resolve(ready)));
      } catch (e) {
        reject(e);
      }
    });

    this.withSeededRandom(() => {
      patchCfxrBeforeBatch(obj);
      QuarksUtil.addToBatchRenderer(obj, this.batchRenderer);
    });
    await patchCfxrAfterBatch(this.batchRenderer);

    this.root.add(obj);
    this.effectRoot = obj;
    this.autoRotations = [];
    for (const controller of raw.controllers ?? []) {
      if (controller?.kind !== 'constant-euler-rotation') continue;
      const target = obj.getObjectByProperty('uuid', controller.targetNode);
      if (!target) throw new Error(`Auto-rotate target '${controller.targetNode}' was not loaded`);
      const d = controller.degreesPerSecond.map(Number) as [number, number, number];
      this.autoRotations.push({
        target,
        baseQuaternion: target.quaternion.clone(),
        // Unity LH Euler vector -> Web RH Euler vector.
        radiansPerSecond: [-d[0] * Math.PI / 180, -d[1] * Math.PI / 180, d[2] * Math.PI / 180],
        space: controller.space,
      });
    }
    // A freshly parsed Quarks system and a replayed system otherwise start from subtly
    // different emission state (the first deterministic freeze was one fixed frame ahead).
    // Normalize first play through the exact same seeded restart path used by regression/replay.
    this.restart();
  }

  /**
   * Interactive stage transform only. Exported particle state stays in authored coordinates;
   * the player root rotates the finished live renderer and places its visual centre above the
   * preview floor. This deliberately does not mutate authored particle coordinates or IR.
   */
  setVerticalGroundPresentation(enabled: boolean, lift = 1.15) {
    this.root.rotation.set(enabled ? -Math.PI / 2 : 0, 0, 0);
    this.root.position.set(0, enabled ? Math.max(0, lift) : 0, 0);
    this.root.updateMatrixWorld(true);
  }

  /** Debug: only the emitter whose name contains `soloName` keeps emitting. */
  soloName: string | null = null;

  /** Select a regression/debug render layer. The next restart/step applies it deterministically. */
  setSolo(name: string | null) {
    this.soloName = name;
  }

  listEmitters(): string[] {
    const names: string[] = [];
    this.effectRoot?.traverse((c) => {
      if (c.type === 'ParticleEmitter') names.push(c.name);
    });
    return names;
  }

  private applySolo() {
    if (!this.effectRoot) return;
    const solo = this.soloName?.toLowerCase() ?? null;
    const emitters: Array<Object3D & { system?: {
      behaviors?: Array<{ type?: string; subParticleSystem?: Object3D }>;
      stop?: () => void; pause?: () => void;
    } }> = [];
    this.effectRoot.traverse((c) => {
      if (c.type === 'ParticleEmitter') emitters.push(c as typeof emitters[number]);
    });
    const layerIndex = solo?.startsWith('@layer:') ? Number(solo.slice('@layer:'.length)) : null;
    const selected = new Set(emitters.filter((e, index) => !solo
      || (layerIndex != null && Number.isInteger(layerIndex) && index === layerIndex)
      || (layerIndex == null && e.name.toLowerCase() === solo)));
    // A sub-emitter layer cannot exist without simulating its event-producing parent. Keep the
    // dependency chain alive but hidden so a diagnostic buffer isolates rendering, not physics.
    const drivers = new Set<typeof emitters[number]>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const emitter of emitters) {
        for (const behavior of emitter.system?.behaviors ?? []) {
          if (behavior.type !== 'EmitSubParticleSystem' || !behavior.subParticleSystem) continue;
          const target = behavior.subParticleSystem as typeof emitters[number];
          const targetRequired = [...selected, ...drivers].some(
            (required) => required === target || required.uuid === target.uuid,
          );
          if (targetRequired && !drivers.has(emitter)) {
            drivers.add(emitter);
            changed = true;
          }
        }
      }
    }
    for (const emitter of emitters) {
      const show = selected.has(emitter);
      const simulate = show || drivers.has(emitter);
      emitter.visible = show;
      if (!simulate) {
        emitter.system?.stop?.();
        emitter.system?.pause?.();
      }
    }
  }

  update(dt: number) {
    if (!this.playing) return;
    const lifecycle = this.contract?.lifecycle;
    // `terminalTime` is the last Unity-oracle-visible fixed frame. Let that frame render, then
    // clear on the following tick; clamping at terminalTime itself would erase valid t=2 data.
    const stopAt = lifecycle ? lifecycle.terminalTime + (this.contract?.fixedDelta ?? 1 / 60) : Infinity;
    const remaining = lifecycle
      ? Math.max(0, stopAt - this.effectElapsed)
      : dt;
    const appliedDt = Math.min(Math.max(0, dt), remaining);
    if (remaining <= 1e-7) {
      this.finishOneShot();
      return;
    }
    this.simulationUpdates.push(appliedDt);
    this.effectElapsed += appliedDt;
    setCfxrEffectTime(this.effectElapsed);
    this.withSeededRandom(() => {
      for (const controller of this.autoRotations) {
        const [x, y, z] = controller.radiansPerSecond;
        const deltaRotation = new Quaternion().setFromEuler(
          new Euler(x * appliedDt, y * appliedDt, z * appliedDt, 'YXZ'),
        );
        if (controller.space === 'self') controller.target.quaternion.multiply(deltaRotation);
        else controller.target.quaternion.premultiply(deltaRotation);
      }
      const emitterDeltas = this.effectRoot
        ? tickStartDelays(this.effectRoot, this.delayGate, appliedDt)
        : new Map();
      this.updateBatchesExactlyOnce(appliedDt, emitterDeltas);
      this.effectLight.update(appliedDt);
    });
    if (lifecycle && this.effectElapsed + 1e-7 >= stopAt) this.finishOneShot();
  }

  private finishOneShot() {
    if (this.effectRoot) QuarksUtil.stop(this.effectRoot);
    // Quarks' stop() clears particleNum, but the instanced batch still contains the previous
    // frame until it is rebuilt. Flush a zero-time batch update so a stopped one-shot cannot
    // leave a frozen column of billboard/trail instances on screen.
    this.updateBatchesExactlyOnce(0);
    this.effectLight.stop();
    this.playing = false;
  }

  /**
   * three.quarks updates `systemToBatchIndex` with Map.forEach(). On a system's first frame,
   * `neededToUpdateRender` can delete and re-add that same Map entry; JavaScript then visits it
   * again and simulates the first frame twice. Snapshot the systems before simulation so batch
   * maintenance cannot change the current fixed step's work set.
   */
  private updateBatchesExactlyOnce(dt: number, emitterDeltas = new Map<object, number>()) {
    const systems = [...this.batchRenderer.systemToBatchIndex.keys()] as unknown as Array<{
      update: (delta: number) => void;
      particleNum?: number;
      particles?: Array<{ age?: number; life?: number; previous?: unknown[] }>;
    }>;
    for (const system of systems) {
      system.update(emitterDeltas.get(system) ?? dt);
      // Quarks normally removes particles through `particle.died`, but Unity's
      // global-clock adapter can leave an age of (life - floating point epsilon)
      // at an exact capture boundary.  Unity has already culled that particle;
      // keeping it makes the state oracle and the rendered frame diverge.  Apply
      // the same boundary once, after all authored behaviours and sub-emitter
      // events have run. Trail particles are intentionally left to Quarks so
      // their recorded history can drain naturally.
      this.cullUnityExpiredParticles(system);
    }
    for (const batch of this.batchRenderer.batches) batch.update();
    updateCfxrCustomAttributes(this.batchRenderer);
  }

  private cullUnityExpiredParticles(system: {
    particleNum?: number;
    particles?: Array<{ age?: number; life?: number; previous?: unknown[] }>;
  }) {
    if (!system.particles || typeof system.particleNum !== 'number') return;
    // Keep this below the snapshot quantization (1e-6). A wider tolerance can
    // incorrectly remove a particle that Unity still reports on the boundary.
    const epsilon = 1e-9;
    let count = system.particleNum;
    for (let i = count - 1; i >= 0; i--) {
      const particle = system.particles[i];
      if (particle?.previous && particle.previous.length > 0) continue;
      if (!Number.isFinite(particle?.age) || !Number.isFinite(particle?.life)) continue;
      if ((particle.age as number) + epsilon < (particle.life as number)) continue;
      const last: number = count - 1;
      system.particles[i] = system.particles[last];
      system.particles[last] = particle;
      count = last;
      system.particleNum = count;
    }
  }

  get semanticContract() {
    return this.contract;
  }

  snapshotState(): ParticleStateSnapshot {
    if (!this.contract || !this.effectRoot) throw new Error('No semantic effect is loaded');
    const emitters: ParticleStateSnapshot['emitters'] = [];
    this.effectRoot.traverse((object) => {
      if (object.type !== 'ParticleEmitter') return;
      const emitter = object as Object3D & {
        system?: {
          particleNum: number;
          particles: Array<{
            position: { x: number; y: number; z: number };
            velocity: { x: number; y: number; z: number };
            size: { x: number; y: number; z: number };
            color: { x: number; y: number; z: number; w: number };
            age: number;
            life: number;
            uvTile: number;
            rotation?: number | { x: number; y: number; z: number; w: number };
            unitySeed?: number;
          }>;
        };
      };
      const system = emitter.system;
      if (!system) return;
      const round = (v: number) => Math.round(v * 1e6) / 1e6;
      emitters.push({
        id: emitter.uuid,
        name: emitter.name,
        path: (() => {
          const names: string[] = [];
          for (let p: Object3D | null = emitter; p && p !== this.effectRoot?.parent; p = p.parent) {
            names.push(p.name);
            if (p === this.effectRoot) break;
          }
          return names.reverse().join('/');
        })(),
        count: system.particleNum,
        particles: system.particles.slice(0, system.particleNum).map((p) => ({
          position: [round(p.position.x), round(p.position.y), round(p.position.z)],
          velocity: [round(p.velocity.x), round(p.velocity.y), round(p.velocity.z)],
          size: [round(p.size.x), round(p.size.y), round(p.size.z)],
          color: [round(p.color.x), round(p.color.y), round(p.color.z), round(p.color.w)],
          age: round(p.age),
          life: round(p.life),
          frame: round(p.uvTile),
          seed: p.unitySeed,
          rotation: typeof p.rotation === 'number'
            ? round(p.rotation)
            : p.rotation
              ? [round(p.rotation.x), round(p.rotation.y), round(p.rotation.z), round(p.rotation.w)]
              : null,
          rotationEuler: (p as unknown as { unityRotationEuler?: [number, number, number] })
            .unityRotationEuler?.map(round),
          custom1: (p as unknown as { unityCustom1?: [number, number, number, number] })
            .unityCustom1?.map(round) as [number, number, number, number] | undefined,
        })),
      });
    });
    emitters.sort((a, b) => a.id.localeCompare(b.id));
    return {
      schema: 'web-particle-state@2',
      effectId: this.contract.effectId,
      seed: this.contract.seed,
      simulationTime: Math.round(this.effectElapsed * 1e6) / 1e6,
      simulationUpdates: [...this.simulationUpdates],
      emitters,
    };
  }

  /** Restart from seed and advance by an integer number of exported fixed steps. */
  async stepTo(seconds: number) {
    const step = this.contract?.fixedDelta ?? 1 / 60;
    const frames = Math.max(0, Math.round(seconds / step));
    this.restart();
    for (let frame = 0; frame < frames; frame++) this.update(step);
    // Quarks evaluates over-lifetime behaviours before incrementing particle.age. Unity's
    // captured/rendered state reflects curves at the completed frame time. A zero-delta pass
    // re-evaluates those pure behaviours at the final age without moving or aging particles.
    this.update(0);
  }

  private withSeededRandom<T>(fn: () => T): T {
    const original = Math.random;
    Math.random = this.random.next;
    try {
      return fn();
    } finally {
      Math.random = original;
    }
  }

  /**
   * Pre-pass: render the stage without particle batches into a RT so Shader Graph
   * Scene Color / distortion can sample the background (mechanism, not per-effect).
   */
  private _sizeBuf = new Vector2();

  captureSceneColor(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
    if (!cfxrNeedsSceneColor()) return;
    const size = renderer.getSize(this._sizeBuf);
    const w = Math.max(1, Math.floor(size.x * renderer.getPixelRatio()));
    const h = Math.max(1, Math.floor(size.y * renderer.getPixelRatio()));
    if (!this.sceneColorRT || this.sceneColorRT.width !== w || this.sceneColorRT.height !== h) {
      this.sceneColorRT?.dispose();
      this.sceneColorRT = new WebGLRenderTarget(w, h, {
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        format: RGBAFormat,
      });
      this.sceneColorRT.depthTexture = new DepthTexture(w, h, UnsignedIntType);
    }
    const prev = this.batchRenderer.visible;
    this.batchRenderer.visible = false;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.sceneColorRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    this.batchRenderer.visible = prev;
    const perspective = camera as Camera & { near?: number; far?: number };
    setCfxrSceneColorTexture(
      this.sceneColorRT.texture,
      this.sceneColorRT.depthTexture,
      w,
      h,
      perspective.near ?? 0.1,
      perspective.far ?? 1000,
    );
  }

  private hasEffectLight = false;

  restart() {
    if (!this.effectRoot) return;
    this.random.reset(this.contract?.seed ?? 1);
    this.effectElapsed = 0;
    this.simulationUpdates = [];
    for (const controller of this.autoRotations)
      controller.target.quaternion.copy(controller.baseQuaternion);
    setCfxrEffectTime(0);
    this.withSeededRandom(() => QuarksUtil.restart(this.effectRoot!));
    armStartDelays(this.effectRoot, this.delayGate);
    this.applySolo();
    if (this.hasEffectLight) this.effectLight.restart();
    this.playing = true;
  }

  pause() {
    if (!this.effectRoot) return;
    QuarksUtil.pause(this.effectRoot);
    this.effectLight.stop();
  }

  resume() {
    if (!this.effectRoot) return;
    QuarksUtil.play(this.effectRoot);
  }

  clear() {
    if (this.effectRoot) {
      QuarksUtil.stop(this.effectRoot);
      this.root.remove(this.effectRoot);
      this.effectRoot = null;
    }
    // Drop old batches so materials/profiles don't leak across loads
    while (this.batchRenderer.batches.length) {
      const b = this.batchRenderer.batches.pop();
      if (b) {
        this.batchRenderer.remove(b);
        b.geometry?.dispose();
        (b.material as { dispose?: () => void })?.dispose?.();
      }
    }
    this.batchRenderer.systemToBatchIndex.clear();
    this.sceneColorRT?.dispose();
    this.sceneColorRT = null;
    setCfxrSceneColorTexture(null, null);
    this.effectElapsed = 0;
    this.autoRotations = [];
    setCfxrEffectTime(0);
    this.effectLight.stop();
    this.playing = false;
    this.contract = null;
  }
}

export async function loadQuarksManifest(candidate = false): Promise<QuarksManifest> {
  const res = await fetch(`/assets/quarks/${candidate ? 'manifest.candidates.json' : 'manifest.json'}`);
  if (!res.ok) return { effects: [] };
  return res.json();
}
