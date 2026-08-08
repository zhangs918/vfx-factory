import {
  GLSL3,
  Group,
  Object3D,
  Vector2,
  Vector3,
  Vector4,
  Color,
  type Material,
  type MeshBasicMaterial,
  type WebGLRenderer,
  type Scene,
  type Camera,
  type ShaderMaterial,
} from 'three';
import { BatchedRenderer, QuarksUtil } from 'three.quarks';
import { setPhysicsResolver } from 'quarks.core';
import { Vector3 as QuarksVector3 } from 'quarks.core';
import { isWebRuntimeArtifact } from '@vfx-factory/artifact-schema';
import { registerUnityEmitterShapes } from './unityEmitterShapes';
import { DeterministicClock, SeededRandom } from './deterministic';
import {
  requireSemanticContract as validateArtifactContract,
  type VfxSemanticContract as RuntimeSemanticContract,
} from './artifact-contract';
import { setCfxrPropsFromJson } from './cfxr-props-from-json';
import { setCfxrEffectTime } from './cfxr-host-effect-time';
import { importCfxrRuntimeState } from './cfxr-runtime-state';
import {
  resolveMountPolicy,
  type FragmentSource,
  type UniformSource,
} from './cfxr-mount-policy';
import {
  dumpLiveMaterialCapture,
  type LiveMaterialCapture,
} from './live-material-stamp';
import {
  armStartDelays,
  createStartDelayGate,
  ensureStartDelayCoverage,
  tickStartDelays,
  type StartDelayGate,
} from './start-delay-gate';
import { extractStartDelays } from './extract-start-delays';
import { setDissolveCurvesFromJson } from './cfxr-custom1-from-json';
import { CfxrEffectLight, UNITY_TO_THREE_LIGHT_INTENSITY_SCALE } from './effect-light';
import { SceneColorCapture } from './scene-color';
import {
  applySolo,
  buildAutoRotations,
  listEmitters,
  resetAutoRotations,
  updateAutoRotations,
  type AutoRotation,
} from './player-controls';
import { snapshotParticleState, type ParticleStateSnapshot } from './particle-snapshot';
import { updateBatchesExactlyOnce } from './batch-stepper';
import { loadQuarksObject } from './quarks-loader';
import {
  assertSameConstantUniforms,
} from './cfxr-constant-uniforms';
import { applyConstantUniforms } from './cfxr-constant-uniforms-apply';
import { applyBakedBlendState } from './cfxr-blend-apply';
import {
  CFXR_COLOR_MUL_SOFT_IDENTITY,
  CFXR_OPACITY_SOFT_IDENTITY,
} from './cfxr-material-profile';

registerUnityEmitterShapes();

export interface PhysicsResolver {
  resolve(position: QuarksVector3, normal: QuarksVector3): boolean;
}

export interface QuarksEffectPlayerOptions {
  /** Host-owned physics adapter. Omit when the artifact does not require scene queries. */
  physicsResolver?: PhysicsResolver;
}

export type VfxArtifactSource = string | URL | Record<string, unknown>;
export type PlayerState = 'empty' | 'loading' | 'playing' | 'paused' | 'finished' | 'error' | 'disposed';

export interface CompiledShaderModule {
  vertex: string;
  fragment: string;
  uniforms: Record<string, string>;
  execution?: 'quarks-fragment-v1' | 'validated-only';
  vertexExecution?: 'quarks-vertex-v1';
  defines?: Record<string, string | number | boolean>;
  provenance?: {
    kind?: string;
    capturedAt?: string;
    injectMode?: string;
    captureSource?: string;
  };
}

export type ArtifactUniformValues = {
  materialColor?: [number, number, number];
  opacityGain?: number;
  legacyAlphaTintFactor?: number;
  hdrMultiply?: number;
  vertColorGain?: number;
  vertColorRgbOn?: number;
  vertColorAlphaOn?: number;
  texPower?: number;
  colorPower?: number;
};

/** Interactive preview-only knobs. Not persisted; lost on reload / effect switch. */
export type LiveTweaks = {
  /** sRGB 0–1 channel multipliers applied on top of baked materialColor. */
  tint?: [number, number, number];
  /** Multiplier on baked hdrMultiply (identity = 1). */
  hdrGain?: number;
  /** Multiplier on baked opacityGain (identity = 1). */
  opacityGain?: number;
  /** Uniform scale on the loaded effect root (identity = 1). */
  scale?: number;
  /** Multiplier on simulation dt (identity = 1). */
  speed?: number;
};

type ResolvedLiveTweaks = {
  tint: [number, number, number];
  hdrGain: number;
  opacityGain: number;
  scale: number;
  speed: number;
};

type TweakBaseline = {
  materialColor: [number, number, number];
  opacityGain: number;
  hdrMultiply?: number;
  meshColor?: [number, number, number];
  meshOpacity?: number;
  meshTransparent?: boolean;
};

const DEFAULT_LIVE_TWEAKS: ResolvedLiveTweaks = {
  tint: [...CFXR_COLOR_MUL_SOFT_IDENTITY],
  hdrGain: 1,
  opacityGain: CFXR_OPACITY_SOFT_IDENTITY,
  scale: 1,
  speed: 1,
};

export type ArtifactBlendState = {
  path: 'legacy-multiply' | 'legacy-premultiply' | 'legacy-multiply-colored' | 'semantic';
  blending: 'no' | 'additive' | 'normal';
  premultipliedAlpha: boolean;
  depthWrite: boolean;
  transparent: boolean;
  alphaTest: number;
  side: 'front' | 'double';
  toneMapped: false;
};

const UNIFORM_COMPARE_EPS = 1e-6;
/** One-shot lifecycle remaining-time / stop compare slack. */
const CFXR_ONESHOT_LIFECYCLE_EPS = 1e-7;

function readUniformNumber(material: ShaderMaterial, name: string): number | undefined {
  const value = (material.uniforms as any)?.[name]?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readUniformVec3(material: ShaderMaterial, name: string): [number, number, number] | undefined {
  const value = (material.uniforms as any)?.[name]?.value;
  if (!value) return undefined;
  if (Array.isArray(value) && value.length >= 3) {
    return [Number(value[0]), Number(value[1]), Number(value[2])];
  }
  if (typeof value.x === 'number' && typeof value.y === 'number' && typeof value.z === 'number') {
    return [value.x, value.y, value.z];
  }
  return undefined;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= UNIFORM_COMPARE_EPS;
}

function requireControllerNumber(label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} required (no invent)`);
  }
  return value;
}

function requireControllerVec3(label: string, value: unknown): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3
    || value.some((channel) => typeof channel !== 'number' || !Number.isFinite(channel))) {
    throw new Error(`${label} required as [number, number, number] (no invent)`);
  }
  return value as [number, number, number];
}


/**
 * Normalize babylon/unity-quarks-exporter JSON so three.quarks ObjectLoader can parse it.
 * Exporter emits QuarksMaterial / QuarksGeometry which MaterialLoader doesn't know.
 */
export class QuarksEffectPlayer {
  readonly root = new Group();
  readonly batchRenderer = new BatchedRenderer();
  readonly effectLight = new CfxrEffectLight();
  private effectRoot: Object3D | null = null;
  private playing = false;
  private state: PlayerState = 'empty';
  private label = '';
  private delayGate: StartDelayGate = createStartDelayGate(new Map());
  private readonly sceneColor = new SceneColorCapture();
  private contract: RuntimeSemanticContract | null = null;
  private readonly random = new SeededRandom();
  private readonly clock = new DeterministicClock();
  private autoRotations: AutoRotation[] = [];
  /** Offline-declared closure IDs versus the actual three.quarks batches. */
  private batchClosureAudit: Array<{ batch: number; closureIds: string[] }> = [];
  /** Closures whose offline pixel evidence authorizes artifact-shader binding. */
  private qualifiedBatchClosures = new Set<string>();
  /** Which source currently owns the three constant fragment uniforms. */
  private uniformSource: UniformSource = 'artifact';
  private fragmentSource: FragmentSource = 'artifact';
  /** Last artifact shader modules — rebound after every restart/stepTo. */
  private boundShaders: Record<string, CompiledShaderModule> = {};
  private expectedArtifactShaderIds = new Set<string>();
  /** Per-batch audit of executor / closure / baked-vs-live constant uniforms. */
  private batchUniformAudit: Array<{
    batch: number;
    executor?: string;
    closureId?: string;
    familyId?: string;
    opacityGain?: number;
    materialColor?: [number, number, number];
    legacyAlphaTintFactor?: number;
    hdrMultiply?: number;
    blending?: number;
    transparent?: boolean;
    depthWrite?: boolean;
    baked?: ArtifactUniformValues;
  }> = [];
  /** Preview-only live tweaks; re-stamped after restart rebuilds batch materials. */
  private liveTweaks: ResolvedLiveTweaks = { ...DEFAULT_LIVE_TWEAKS, tint: [...DEFAULT_LIVE_TWEAKS.tint] };
  private tweakBaselines = new WeakMap<Material, TweakBaseline>();

  constructor(options: QuarksEffectPlayerOptions = {}) {
    this.root.name = 'QuarksEffectPlayer';
    this.root.add(this.batchRenderer);
    this.effectLight.attach(this.root);
    if (options.physicsResolver) setPhysicsResolver(options.physicsResolver);
  }

  get isPlaying() {
    return this.playing;
  }

  get playbackState(): PlayerState {
    return this.state;
  }

  get currentLabel() {
    return this.label;
  }

  /**
   * Capture the live GLSL + blend/uniforms/texture bindings after thick-path
   * inject/bind. Used by the offline stamp factory — not a qualification gate.
   */
  dumpLiveMaterialStamp(): LiveMaterialCapture {
    if (!this.batchRenderer) {
      throw new Error('dumpLiveMaterialStamp: no batch renderer (effect not loaded)');
    }
    const effectId = this.contract?.effectId;
    if (!effectId) {
      throw new Error('dumpLiveMaterialStamp: missing effectId');
    }
    return dumpLiveMaterialCapture({
      effectId,
      label: this.label,
      batchRenderer: this.batchRenderer,
    });
  }

  /** URL-debug-safe state: lets regression tooling prove lifecycle progress without pixels. */
  get debugLifecycleState() {
    const injectAudit = (this.batchRenderer?.batches ?? []).map((batch, index) => {
      const material = batch.material as {
        userData?: { cfxrInjectMode?: string; offlineOwned?: string[] };
        uniforms?: { map?: { value?: { colorSpace?: string; uuid?: string } } };
      } | undefined;
      const offlineOwned = [...(material?.userData?.offlineOwned ?? [])].sort();
      const thinReady = ['blend', 'fragment', 'uniforms', 'vertex']
        .every((key) => offlineOwned.includes(key));
      return {
        batchIndex: index,
        injectMode: material?.userData?.cfxrInjectMode ?? 'unknown',
        offlineOwned,
        thinPlayerReady: thinReady,
        mapColorSpace: material?.uniforms?.map?.value?.colorSpace,
        mapUuid: material?.uniforms?.map?.value?.uuid,
      };
    });
    const slimBatches = injectAudit.filter((row) => row.injectMode === 'artifact-slim');
    const bridgeBatches = injectAudit.filter((row) => row.injectMode === 'bridge-full');
    const liveClosureIds = [...new Set(
      this.batchClosureAudit.flatMap((row) => row.closureIds),
    )].sort();
    const allClosuresQualified = liveClosureIds.length > 0
      && liveClosureIds.every((id) => this.qualifiedBatchClosures.has(id));
    // Effect-level thin-player gate: every live draw batch is artifact-slim and
    // fully offline-owned, and every live closure carries pixel evidence.
    const effectThinPlayerReady = bridgeBatches.length === 0
      && slimBatches.length > 0
      && slimBatches.every((row) => row.thinPlayerReady)
      && allClosuresQualified;
    const policy = resolveMountPolicy();
    return {
      state: this.state,
      playing: this.playing,
      elapsed: this.clock.time,
      lifecycle: this.contract?.lifecycle ?? null,
      batchClosureAudit: this.batchClosureAudit,
      qualifiedBatchClosures: [...this.qualifiedBatchClosures].sort(),
      liveClosureIds,
      uniformSource: this.uniformSource,
      vertexSource: policy.vertex,
      // Mounts are bags-only; ?behaviorSource no longer switches authority.
      behaviorSource: 'manifest' as const,
      blendSource: policy.blend,
      fragmentSource: policy.fragment,
      batchUniformAudit: this.batchUniformAudit,
      injectAudit,
      thinPlayerReadyBatches: injectAudit.filter((row) => row.thinPlayerReady).length,
      effectThinPlayerReady,
    };
  }

  async loadAndPlay(source: VfxArtifactSource, label: string): Promise<void> {
    if (this.state === 'disposed') throw new Error('Cannot load an effect after dispose().');
    this.state = 'loading';
    let raw: any;
    if (typeof source === 'object' && !(source instanceof URL)) {
      raw = source;
    } else {
      const url = String(source);
      const res = await fetch(url);
      const ct = res.headers.get('content-type') ?? '';
      if (!res.ok || !ct.includes('json')) {
        throw new Error(
          `缺少导出文件: ${url}\n请按 tools/unity-quarks-exporter/EXPORT_GUIDE.zh-CN.md 从 Unity 导出。\n` +
            `保存为 public/assets/quarks/ 下的 JSON 后刷新本页。`,
        );
      }
      raw = await res.json();
    }
    // Fetch/parse first. A failed load must not destroy the currently playing effect.
    this.clear();
    this.label = label;
    this.contract = validateArtifactContract(raw);
    const runtimeBundle = isWebRuntimeArtifact(raw.webRuntime) ? raw.webRuntime : null;
    if (runtimeBundle && runtimeBundle.effectId !== this.contract.effectId) {
      throw new Error(`Runtime artifact effect '${runtimeBundle.effectId}' does not match contract '${this.contract.effectId}'.`);
    }
    if (runtimeBundle && !runtimeBundle.cfxrState) {
      throw new Error(`Runtime artifact '${runtimeBundle.effectId}' is incomplete: missing compiled cfxrState.`);
    }
    const runtimeJson = runtimeBundle?.payload ?? raw;
    const closureByEmitter = new Map<string, string>();
    const collectClosureIds = (node: any) => {
      if (!node || typeof node !== 'object') return;
      const closureId = node?.ps?.artifactBatchClosureId;
      if (node.type === 'ParticleEmitter' && typeof node.uuid === 'string' && typeof closureId === 'string') {
        closureByEmitter.set(node.uuid, closureId);
      }
      for (const child of node.children ?? []) collectClosureIds(child);
    };
    collectClosureIds(runtimeJson.object);
    const runtimeConfig = runtimeBundle?.runtimeConfig;
    this.clock.reset();
    setCfxrEffectTime(0);
    this.random.reset(this.contract.seed);
    if (this.contract.representation === 'camera-baked@1') {
      throw new Error('camera-baked@1 is an offline regression oracle and cannot be played in production.');
    }
    this.delayGate = createStartDelayGate(runtimeConfig?.startDelays
      ? new Map(runtimeConfig.startDelays)
      : extractStartDelays(runtimeJson));
    if (runtimeBundle?.cfxrState) importCfxrRuntimeState(runtimeBundle.cfxrState);
    else setCfxrPropsFromJson(runtimeJson);
    if (!runtimeBundle) setDissolveCurvesFromJson(runtimeJson);
    const controllers = runtimeConfig?.controllers ?? runtimeJson.controllers;
    const lightController = Array.isArray(controllers)
      ? controllers.find((controller: any) => controller?.kind === 'deterministic-light-fade'
          || controller?.kind === 'sampled-unity-perlin-light')
      : undefined;
    this.hasEffectLight = !!(runtimeConfig?.cfxrEffect ?? runtimeJson.cfxrEffect) || !!lightController;
    if (lightController?.kind === 'deterministic-light-fade') {
      this.effectLight.configure({
        mode: 'linear-fade',
        intensityStart: requireControllerNumber('deterministic-light-fade.baseIntensity', lightController.baseIntensity),
        intensityEnd: requireControllerNumber('deterministic-light-fade.finalIntensity', lightController.finalIntensity),
        delay: requireControllerNumber('deterministic-light-fade.delay', lightController.delay),
        duration: requireControllerNumber('deterministic-light-fade.duration', lightController.duration),
        color: requireControllerVec3('deterministic-light-fade.color', lightController.color),
        range: requireControllerNumber('deterministic-light-fade.range', lightController.range),
        position: lightController.position,
        intensityScale: UNITY_TO_THREE_LIGHT_INTENSITY_SCALE,
      });
    } else if (lightController?.kind === 'sampled-unity-perlin-light') {
      if (typeof lightController.referencePhase !== 'number') {
        throw new Error('sampled-unity-perlin-light: referencePhase required (no invent)');
      }
      if (!Array.isArray(lightController.samples) || !lightController.samples.length) {
        throw new Error('sampled-unity-perlin-light: samples required (no invent)');
      }
      this.effectLight.configure({
        mode: 'sampled-flicker',
        intensityStart: requireControllerNumber('sampled-unity-perlin-light.baseIntensity', lightController.baseIntensity),
        flickerAdd: requireControllerNumber('sampled-unity-perlin-light.addIntensity', lightController.addIntensity),
        flickerSmooth: requireControllerNumber('sampled-unity-perlin-light.smoothFactor', lightController.smoothFactor),
        flickerPhase: requireControllerNumber('sampled-unity-perlin-light.referencePhase', lightController.referencePhase),
        flickerDomainStep: requireControllerNumber('sampled-unity-perlin-light.domainStep', lightController.domainStep),
        flickerSamples: lightController.samples.map((sample: unknown, index: number) => (
          requireControllerNumber(`sampled-unity-perlin-light.samples[${index}]`, sample)
        )),
        color: requireControllerVec3('sampled-unity-perlin-light.color', lightController.color),
        range: requireControllerNumber('sampled-unity-perlin-light.range', lightController.range),
        position: lightController.position,
        intensityScale: UNITY_TO_THREE_LIGHT_INTENSITY_SCALE,
      });
    } else if (this.hasEffectLight) this.effectLight.configure(runtimeConfig?.cfxrEffect ?? runtimeJson.cfxrEffect);
    else this.effectLight.stop();
    const obj = await loadQuarksObject(
      runtimeJson,
      this.batchRenderer,
      this.withSeededRandom.bind(this),
      runtimeBundle ? 'compiled-runtime' : 'legacy-unity-json',
    );

    // Preserve compiler closure identity on the live system. ObjectLoader does
    // not retain arbitrary `ps` JSON fields, so this explicit hand-off is the
    // only reliable way to audit the offline batch model against Quarks.
    obj.traverse((child: any) => {
      if (child?.type !== 'ParticleEmitter') return;
      const closureId = closureByEmitter.get(child.uuid);
      if (closureId) (child.system as any).__artifactBatchClosureId = closureId;
    });
    this.batchClosureAudit = this.batchRenderer.batches.map((batch, index) => ({
      batch: index,
      closureIds: [...new Set(Array.from(batch.systems)
        .map((system: any) => system.__artifactBatchClosureId)
        .filter((id): id is string => typeof id === 'string'))].sort(),
    }));

    this.root.add(obj);
    this.effectRoot = obj;
    // Soft-fill remains for legacy/frozen payloads that omit explicit 0.
    // Thin ArtifactQuarksPlayer uses requireStartDelayCoverage (offline-complete only).
    ensureStartDelayCoverage(this.effectRoot, this.delayGate.delays);
    this.autoRotations = buildAutoRotations(obj, controllers ?? []);
    // A freshly parsed Quarks system and a replayed system otherwise start from subtly
    // different emission state (the first deterministic freeze was one fixed frame ahead).
    // Normalize first play through the exact same seeded restart path used by regression/replay.
    this.restart();
  }

  /** Load an offline-compiled v3 payload without exposing the legacy webRuntime
   * envelope to artifact backends. The Quarks player owns this compatibility
   * detail because it is part of its public compiled-input contract. */
  async loadCompiledArtifact(
    simulation: Record<string, unknown>,
    runtimeState: { cfxrState: Record<string, unknown>; runtimeConfig: Record<string, unknown> },
    metadata: { effectId: string; seed: number; fixedDelta: number },
    label: string,
    geometryData: Record<string, { attributes: unknown; index?: unknown }> = {},
    pipelines: Record<string, {
      materialId: string;
      shader: string;
      executor?: 'semantic-bridge@1' | 'artifact-shader@1';
      qualification?: { familyId?: string; status?: 'bridge' | 'capture-stamped' | 'pixel-qualified' };
      uniformValues?: ArtifactUniformValues;
      blendState?: ArtifactBlendState;
      tileCounts?: [number, number];
      defines?: Record<string, string | number | boolean>;
      capturedUniforms?: Record<string, number | number[] | number[][]>;
    }> = {},
    shaders: Record<string, CompiledShaderModule> = {},
    batchClosures: Record<string, {
      qualification?: { status?: 'bridge' | 'capture-stamped' | 'pixel-qualified' };
    }> = {},
  ): Promise<void> {
    const quarksConfig = structuredClone(simulation) as any;
    for (const geometry of quarksConfig.geometries ?? []) {
      const data = geometry.resourceId ? geometryData[geometry.resourceId] : undefined;
      if (data) geometry.data = data;
    }
    // The offline compiler owns material→shader resolution. Persist that binding on the
    // serialized material so the Quarks adapter never guesses a shader family at runtime.
    for (const material of quarksConfig.materials ?? []) {
      const pipeline = Object.values(pipelines).find(
        (candidate) => candidate.materialId === material.uuid,
      );
      if (!pipeline) continue;
      if (!shaders[pipeline.shader]) {
        throw new Error(`Artifact '${metadata.effectId}' is missing shader module '${pipeline.shader}' for material '${material.uuid}'.`);
      }
      material.userData ??= {};
      material.userData.artifactShaderId = pipeline.shader;
      material.userData.artifactShader = shaders[pipeline.shader];
      if (shaders[pipeline.shader]?.provenance) {
        material.userData.artifactShaderProvenance = shaders[pipeline.shader].provenance;
      }
      // Do not invent semantic-bridge@1 — missing executor means bridge fragment path
      // (after-batch treats non-artifact-shader as installFragment).
      if (pipeline.executor) {
        material.userData.artifactExecutor = pipeline.executor;
      }
      material.userData.artifactFamilyId = pipeline.qualification?.familyId;
      if (pipeline.uniformValues) {
        material.userData.artifactUniformValues = pipeline.uniformValues;
      }
      if (pipeline.blendState) {
        material.userData.artifactBlendState = pipeline.blendState;
      }
      material.userData.artifactPipeline = pipeline;
      if (pipeline.tileCounts) {
        material.userData.artifactTileCounts = pipeline.tileCounts;
      }
      if (pipeline.capturedUniforms) {
        material.userData.artifactCapturedUniforms = pipeline.capturedUniforms;
      }
      if (pipeline.defines) {
        material.userData.artifactDefines = pipeline.defines;
      }
    }
    const vfxIR = quarksConfig.vfxIR
      ? { ...quarksConfig.vfxIR, effectId: metadata.effectId }
      : {
        schema: 'unity-vfx-ir@1', runtime: 'three-quarks-semantic@1', policy: 'strict',
        effectId: metadata.effectId, seed: metadata.seed, fixedDelta: metadata.fixedDelta, captureTimes: [0],
      };
    await this.loadAndPlay({
      vfxIR,
      webRuntime: {
        schema: 'web-vfx-runtime@1', effectId: metadata.effectId,
        payload: quarksConfig, cfxrState: runtimeState.cfxrState,
        runtimeConfig: runtimeState.runtimeConfig,
      },
    }, label);
    // Set after loadAndPlay: clear() resets qualified closures during reload.
    this.qualifiedBatchClosures = new Set(Object.entries(batchClosures)
      .filter(([, closure]) => closure?.qualification?.status === 'pixel-qualified')
      .map(([id]) => id));
    const policy = resolveMountPolicy();
    this.uniformSource = policy.uniform;
    this.fragmentSource = policy.fragment;
    this.boundShaders = shaders;
    this.expectedArtifactShaderIds = new Set(Object.values(pipelines)
      .filter((pipeline) => pipeline.executor === 'artifact-shader@1')
      .map((pipeline) => pipeline.shader));
    // loadAndPlay already restarted once; bind after that restart. stepTo/restart
    // will rebind again — QuarksUtil.restart rebuilds batch materials and drops
    // onBeforeCompile hooks, so fragment must be written onto the live batch.
    this.bindCompiledShaders(this.boundShaders, this.expectedArtifactShaderIds);
    this.refreshBatchUniformAudit();
    this.stampLiveTweaks();
  }

  /**
   * Apply only shader modules that explicitly declare the Quarks fragment ABI.
   * Binding additionally requires a pixel-qualified batch closure: transparent
   * compositing is only safe when the complete Quarks draw batch was reviewed.
   *
   * Writes fragmentShader directly (same durability as CFXR inject). Assigning
   * only onBeforeCompile is wiped when QuarksUtil.restart rebuilds batch materials.
   */
  private bindCompiledShaders(
    shaders: Record<string, CompiledShaderModule>,
    expectedShaderIds: Set<string> = new Set(),
  ) {
    // ?cfxrFragment=force keeps the CFXR ubershader body from inject; do not
    // overwrite it with the offline fragment (dual-path rollback / A-B).
    if (this.fragmentSource === 'bridge') {
      return;
    }
    const boundShaderIds = new Set<string>();
    for (const batch of this.batchRenderer.batches) {
      const members = Array.from(batch.systems).map((system) => {
        const material = (system as any).rendererSettings?.material;
        const shaderId = material?.userData?.artifactShaderId as string | undefined;
        return {
          executor: material?.userData?.artifactExecutor,
          shaderId,
          familyId: material?.userData?.artifactFamilyId as string | undefined,
          baked: material?.userData?.artifactUniformValues as ArtifactUniformValues | undefined,
          blendState: material?.userData?.artifactBlendState as ArtifactBlendState | undefined,
          capturedUniforms: material?.userData?.artifactCapturedUniforms as Record<string, number | number[]> | undefined,
          shader: shaderId ? shaders[shaderId] : undefined,
          closureId: (system as any).__artifactBatchClosureId as string | undefined,
        };
      });
      const artifactMembers = members.filter((member) => member.executor === 'artifact-shader@1');
      if (!artifactMembers.length) continue;
      const compiledId = artifactMembers[0].shaderId;
      const compiledFamilyId = artifactMembers[0].familyId;
      const compiledClosureId = artifactMembers[0].closureId;
      const compiledPreview = compiledId ? shaders[compiledId] : undefined;
      // Live-bridge captures already equal the thick path; bind without waiting for
      // pixel-qualified (that gate is reserved for thin catalog / spot checks).
      const captureAuthorized = compiledPreview?.provenance?.kind === 'live-bridge-capture@1';
      // A Quarks batch has one material program. Replacing it because just one
      // member opted into an artifact shader corrupts every bridge/member system
      // sharing that batch. Offline lowering must first split mixed programs.
      // Closure qualification is the second gate for emit-based shaders; capture
      // stamps authorize homogeneous batches directly.
      const homogeneous = artifactMembers.length === members.length
        && !!compiledFamilyId
        && !!compiledClosureId
        && artifactMembers.every((member) => member.familyId === compiledFamilyId
          && member.closureId === compiledClosureId)
        && (captureAuthorized || this.qualifiedBatchClosures.has(compiledClosureId));
      if (!homogeneous) continue;
      const compiled = compiledId ? shaders[compiledId] : undefined;
      if (compiled?.execution !== 'quarks-fragment-v1') continue;
      if (!compiled) continue;
      for (const member of artifactMembers) {
        if (member.shaderId) boundShaderIds.add(member.shaderId);
      }
      const baked = artifactMembers[0].baked;
      const blendState = artifactMembers[0].blendState;
      const capturedUniforms = artifactMembers[0].capturedUniforms;
      // Stamp both the live batch material and each system's settings material.
      // QuarksUtil.restart / UV-tile batches may clone from settings; writing only
      // batch.material leaves the drawing clone on the stock Quarks fragment.
      const targets = new Set<ShaderMaterial>([batch.material as ShaderMaterial]);
      for (const system of batch.systems) {
        const settingsMat = (system as any).rendererSettings?.material as ShaderMaterial | undefined;
        if (settingsMat) targets.add(settingsMat);
      }
      for (const material of targets) {
        if (captureAuthorized) {
          // Full live program: fragment + already-patched vertex + CFXR defines.
          material.fragmentShader = compiled.fragment;
          material.vertexShader = compiled.vertex;
          material.defines = { ...(compiled.defines ?? {}) };
        } else {
          // Keep Quarks vertex/batching; replace only the fragment program body.
          material.fragmentShader = compiled.fragment;
        }
        material.glslVersion = GLSL3;
        // Restart drops slim-inject blend (toneMapped/side/blending). Re-apply bake.
        if (blendState) applyBakedBlendState(material, blendState);
        if (baked) {
          this.applyArtifactUniformValues(
            material,
            baked,
            compiledId ?? 'unknown',
            // batch.material often lacks settings userData; use the batch gate.
            captureAuthorized,
          );
        }
        if (captureAuthorized && capturedUniforms) {
          this.applyCapturedUniforms(material, capturedUniforms);
        }
        // Keep tileCounts across restart clones; prefer offline stamps.
        if (!material.uniforms.tileCounts) {
          const offlineTiles = (material.userData as {
            artifactTileCounts?: [number, number];
            cfxr?: { tileCounts?: [number, number] };
          })?.artifactTileCounts
            ?? (material.userData as { cfxr?: { tileCounts?: [number, number] } })?.cfxr?.tileCounts;
          if (!offlineTiles) {
            throw new Error('restart: missing offline tileCounts on batch material');
          }
          material.uniforms.tileCounts = {
            value: new Vector2(Number(offlineTiles[0]), Number(offlineTiles[1])),
          };
        }
        material.needsUpdate = true;
      }
    }
    const missing = [...expectedShaderIds].filter((shaderId) => !boundShaderIds.has(shaderId));
    if (missing.length) {
      throw new Error(`Artifact shader binding failed for: ${missing.join(', ')}`);
    }
  }

  /** Dual-path constant uniforms: assert bake≡live (slim inject already wrote the
   * chosen authority); take artifact authority as a safety net overwrite. */
  private applyArtifactUniformValues(
    material: ShaderMaterial,
    baked: ArtifactUniformValues,
    shaderId: string,
    captureOwned = false,
  ) {
    const live: ArtifactUniformValues = {
      opacityGain: readUniformNumber(material, 'opacityGain'),
      legacyAlphaTintFactor: readUniformNumber(material, 'legacyAlphaTintFactor'),
      materialColor: readUniformVec3(material, 'materialColor'),
      ...(baked.hdrMultiply !== undefined
        ? { hdrMultiply: readUniformNumber(material, 'hdrMultiply') }
        : {}),
      ...(baked.vertColorGain !== undefined
        ? { vertColorGain: readUniformNumber(material, 'vertColorGain') }
        : {}),
    };
    // Shared-batch live-bridge clones can bake donor constants that differ from
    // per-emitter bridge defaults still on the material; capture bake wins.
    if (!captureOwned) {
      assertSameConstantUniforms(`player/${shaderId}`, baked, live);
    }
    if (this.uniformSource !== 'artifact') return;
    applyConstantUniforms(material, baked);
  }

  /** Restore the full thick-path uniform table recorded by live capture. */
  private applyCapturedUniforms(
    material: ShaderMaterial,
    captured: Record<string, number | number[] | number[][]>,
  ) {
    for (const [name, value] of Object.entries(captured)) {
      // Host clock / camera / RT size — kept live via SceneColorCapture + setCfxrEffectTime.
      if (name === 'effectTime' || name === 'cameraNear' || name === 'cameraFar' || name === 'sceneColorSize') {
        continue;
      }
      if (typeof value === 'number') {
        material.uniforms[name] = { value };
        continue;
      }
      if (!Array.isArray(value) || value.length === 0) continue;
      // ambientSH: number[9][3]
      if (Array.isArray(value[0])) {
        const rows = value as number[][];
        if (rows.every((row) => Array.isArray(row) && row.length === 3 && row.every((n) => typeof n === 'number'))) {
          material.uniforms[name] = { value: rows.map((row) => new Vector3(row[0], row[1], row[2])) };
        }
        continue;
      }
      if (!value.every((n) => typeof n === 'number')) continue;
      const nums = value as number[];
      if (nums.length === 2) material.uniforms[name] = { value: new Vector2(nums[0], nums[1]) };
      else if (nums.length === 3) {
        // Colors and vec3 share length 3; prefer Color for *Color* names.
        material.uniforms[name] = /color/i.test(name)
          ? { value: new Color(nums[0], nums[1], nums[2]) }
          : { value: new Vector3(nums[0], nums[1], nums[2]) };
      } else if (nums.length === 4) {
        material.uniforms[name] = { value: new Vector4(nums[0], nums[1], nums[2], nums[3]) };
      }
    }
  }

  private refreshBatchUniformAudit() {
    this.batchUniformAudit = this.batchRenderer.batches.map((batch, index) => {
      const systems = Array.from(batch.systems);
      const material = batch.material as ShaderMaterial;
      const sample = systems[0] as any;
      const settingsMat = sample?.rendererSettings?.material;
      return {
        batch: index,
        executor: settingsMat?.userData?.artifactExecutor,
        closureId: sample?.__artifactBatchClosureId,
        familyId: settingsMat?.userData?.artifactFamilyId,
        opacityGain: readUniformNumber(material, 'opacityGain'),
        materialColor: readUniformVec3(material, 'materialColor'),
        legacyAlphaTintFactor: readUniformNumber(material, 'legacyAlphaTintFactor'),
        hdrMultiply: readUniformNumber(material, 'hdrMultiply'),
        blending: material.blending,
        transparent: material.transparent,
        depthWrite: material.depthWrite,
        baked: settingsMat?.userData?.artifactUniformValues,
      };
    });
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
    return listEmitters(this.effectRoot);
  }

  getLiveTweaks(): Readonly<ResolvedLiveTweaks> {
    return {
      ...this.liveTweaks,
      tint: [...this.liveTweaks.tint],
    };
  }

  /** Instant preview tweaks. Identity values leave the baked artifact look unchanged. */
  applyLiveTweaks(patch: LiveTweaks) {
    if (patch.tint) {
      this.liveTweaks.tint = [
        Math.max(0, Number(patch.tint[0]) || 0),
        Math.max(0, Number(patch.tint[1]) || 0),
        Math.max(0, Number(patch.tint[2]) || 0),
      ];
    }
    if (patch.hdrGain !== undefined) {
      this.liveTweaks.hdrGain = Math.max(0, Number(patch.hdrGain) || 0);
    }
    if (patch.opacityGain !== undefined) {
      this.liveTweaks.opacityGain = Math.max(0, Number(patch.opacityGain) || 0);
    }
    if (patch.scale !== undefined) {
      this.liveTweaks.scale = Math.max(0.01, Number(patch.scale) || 0.01);
    }
    if (patch.speed !== undefined) {
      this.liveTweaks.speed = Math.max(0.01, Number(patch.speed) || 0.01);
    }
    this.stampLiveTweaks();
  }

  resetLiveTweaks() {
    this.liveTweaks = { ...DEFAULT_LIVE_TWEAKS, tint: [...DEFAULT_LIVE_TWEAKS.tint] };
    // Keep the original per-material baselines until the effect is cleared. Re-capturing
    // here would treat already-tinted MeshBasicMaterial state as the new identity.
    this.stampLiveTweaks();
  }

  private captureTweakBaseline(material: Material): TweakBaseline {
    const cached = this.tweakBaselines.get(material);
    if (cached) return cached;
    const baked = (material.userData as { artifactUniformValues?: ArtifactUniformValues } | undefined)
      ?.artifactUniformValues;
    const profile = (material.userData as { cfxr?: {
      colorMul?: [number, number, number];
      opacity?: number;
      hdr?: number;
    } } | undefined)?.cfxr;
    const shaderMat = material as ShaderMaterial;
    const basicMat = material as MeshBasicMaterial;
    let materialColor: [number, number, number];
    let opacityGain: number;
    let hdrCandidate: number | undefined;
    if (baked) {
      if (!Array.isArray(baked.materialColor) || baked.materialColor.length < 3) {
        throw new Error('captureTweakBaseline: baked materialColor[3] required (no invent)');
      }
      if (typeof baked.opacityGain !== 'number') {
        throw new Error('captureTweakBaseline: baked opacityGain required (no invent)');
      }
      materialColor = [baked.materialColor[0], baked.materialColor[1], baked.materialColor[2]];
      opacityGain = baked.opacityGain;
      hdrCandidate = typeof baked.hdrMultiply === 'number' ? baked.hdrMultiply : undefined;
    } else if (profile) {
      // Inject-stamped profile: refuse soft invent (uniforms may still supply hdr).
      if (!Array.isArray(profile.colorMul) || profile.colorMul.length < 3
        || profile.colorMul.some((c) => typeof c !== 'number')) {
        throw new Error('captureTweakBaseline: profile.colorMul[3] required (no invent)');
      }
      if (typeof profile.opacity !== 'number') {
        throw new Error('captureTweakBaseline: profile.opacity required (no invent)');
      }
      materialColor = [profile.colorMul[0], profile.colorMul[1], profile.colorMul[2]];
      opacityGain = profile.opacity;
      hdrCandidate = typeof profile.hdr === 'number'
        ? profile.hdr
        : readUniformNumber(shaderMat, 'hdrMultiply');
    } else {
      // Frozen/bridge without profile: soft-invent identity only when uniforms omit.
      materialColor = readUniformVec3(shaderMat, 'materialColor')
        ?? [...CFXR_COLOR_MUL_SOFT_IDENTITY];
      opacityGain = readUniformNumber(shaderMat, 'opacityGain')
        ?? CFXR_OPACITY_SOFT_IDENTITY;
      hdrCandidate = readUniformNumber(shaderMat, 'hdrMultiply');
    }
    const baseline: TweakBaseline = {
      materialColor,
      opacityGain,
      ...(hdrCandidate !== undefined ? { hdrMultiply: hdrCandidate } : {}),
      ...(basicMat.isMeshBasicMaterial && basicMat.color
        ? {
          meshColor: [basicMat.color.r, basicMat.color.g, basicMat.color.b] as [number, number, number],
          meshOpacity: basicMat.opacity,
          meshTransparent: basicMat.transparent,
        }
        : {}),
    };
    this.tweakBaselines.set(material, baseline);
    return baseline;
  }

  private liveTweakTargets(): Material[] {
    const targets = new Set<Material>();
    for (const batch of this.batchRenderer.batches) {
      if (batch.material) targets.add(batch.material as Material);
      const settingsMat = (batch as { settings?: { material?: Material } }).settings?.material;
      if (settingsMat) targets.add(settingsMat);
      for (const system of batch.systems) {
        const systemMat = (system as any).rendererSettings?.material as Material | undefined;
        if (systemMat) targets.add(systemMat);
        const emitterMat = (system as any).material as Material | undefined;
        if (emitterMat) targets.add(emitterMat);
      }
    }
    return [...targets];
  }

  private stampLiveTweaks() {
    // BatchedRenderer is a sibling of effectRoot under this.root — scale the player
    // root so both simulation emitters and the drawn batches grow/shrink together.
    this.root.scale.setScalar(this.liveTweaks.scale);
    if (this.effectRoot) this.effectRoot.scale.set(1, 1, 1);

    const { tint, hdrGain, opacityGain } = this.liveTweaks;
    for (const material of this.liveTweakTargets()) {
      const baseline = this.captureTweakBaseline(material);
      const baseColor = baseline.materialColor;
      const tinted: [number, number, number] = [
        baseColor[0] * tint[0],
        baseColor[1] * tint[1],
        baseColor[2] * tint[2],
      ];
      const tintedOpacity = baseline.opacityGain * opacityGain;
      const tintedHdr = baseline.hdrMultiply !== undefined
        ? baseline.hdrMultiply * hdrGain
        : undefined;

      const shaderMat = material as ShaderMaterial;
      if (shaderMat.isShaderMaterial && shaderMat.uniforms) {
        const colorUniform = shaderMat.uniforms.materialColor;
        if (colorUniform?.value?.set) {
          colorUniform.value.set(tinted[0], tinted[1], tinted[2]);
        } else if (colorUniform) {
          colorUniform.value = new Vector3(tinted[0], tinted[1], tinted[2]);
        } else {
          applyConstantUniforms(shaderMat, { materialColor: tinted });
        }
        const opacityUniform = shaderMat.uniforms.opacityGain;
        if (opacityUniform) opacityUniform.value = tintedOpacity;
        else applyConstantUniforms(shaderMat, { opacityGain: tintedOpacity });
        if (tintedHdr !== undefined) {
          const hdrUniform = shaderMat.uniforms.hdrMultiply;
          if (hdrUniform) hdrUniform.value = tintedHdr;
          else applyConstantUniforms(shaderMat, { hdrMultiply: tintedHdr });
        }
      }

      const basicMat = material as MeshBasicMaterial;
      if (basicMat.isMeshBasicMaterial && basicMat.color) {
        if (!baseline.meshColor || typeof baseline.meshOpacity !== 'number'
          || typeof baseline.meshTransparent !== 'boolean') {
          throw new Error(
            'stampLiveTweaks: meshColor/meshOpacity required for MeshBasicMaterial (no invent)',
          );
        }
        const meshColor = baseline.meshColor;
        const meshOpacity = baseline.meshOpacity;
        basicMat.color.setRGB(meshColor[0] * tint[0], meshColor[1] * tint[1], meshColor[2] * tint[2]);
        basicMat.opacity = Math.min(1, Math.max(0, meshOpacity * opacityGain));
        basicMat.transparent = baseline.meshTransparent || basicMat.opacity < 0.999;
        basicMat.needsUpdate = true;
      }
    }
  }

  private applySolo() {
    applySolo(this.effectRoot, this.soloName);
  }

  update(dt: number) {
    if (!this.playing) return;
    dt *= this.liveTweaks.speed;
    const lifecycle = this.contract?.lifecycle;
    // `terminalTime` is the last Unity-oracle-visible fixed frame. Let that frame render, then
    // clear on the following tick; clamping at terminalTime itself would erase valid t=2 data.
    const fixedDelta = this.contract?.fixedDelta;
    const stopAt = lifecycle
      ? (() => {
          if (!(typeof fixedDelta === 'number' && fixedDelta > 0)) {
            throw new Error('QuarksEffectPlayer: contract.fixedDelta required for lifecycle stop');
          }
          return lifecycle.terminalTime + fixedDelta;
        })()
      : Infinity;
    const remaining = lifecycle
      ? Math.max(0, stopAt - this.clock.time)
      : dt;
    const appliedDt = Math.min(Math.max(0, dt), remaining);
    if (remaining <= CFXR_ONESHOT_LIFECYCLE_EPS) {
      this.finishOneShot();
      return;
    }
    this.clock.advance(appliedDt);
    setCfxrEffectTime(this.clock.time);
    this.withSeededRandom(() => {
      updateAutoRotations(this.autoRotations, appliedDt);
      const emitterDeltas = this.effectRoot
        ? tickStartDelays(this.effectRoot, this.delayGate, appliedDt)
        : new Map();
      updateBatchesExactlyOnce(this.batchRenderer, appliedDt, emitterDeltas);
      this.effectLight.update(appliedDt);
    });
    // Quarks may rebuild batch materials during simulation; keep preview tweaks on top.
    this.stampLiveTweaks();
    if (lifecycle && this.clock.time + CFXR_ONESHOT_LIFECYCLE_EPS >= stopAt) this.finishOneShot();
  }

  private finishOneShot() {
    if (this.effectRoot) QuarksUtil.stop(this.effectRoot);
    // Quarks' stop() clears particleNum, but the instanced batch still contains the previous
    // frame until it is rebuilt. Flush a zero-time batch update so a stopped one-shot cannot
    // leave a frozen column of billboard/trail instances on screen.
    updateBatchesExactlyOnce(this.batchRenderer, 0);
    this.effectLight.stop();
    this.playing = false;
    this.state = 'finished';
  }


  get semanticContract() {
    return this.contract;
  }

  snapshotState(): ParticleStateSnapshot {
    if (!this.contract || !this.effectRoot) throw new Error('No semantic effect is loaded');
    return snapshotParticleState(this.effectRoot, this.contract, this.clock);
  }

  /** Restart from seed and advance by an integer number of exported fixed steps. */
  async stepTo(seconds: number) {
    const step = this.contract?.fixedDelta;
    if (!(typeof step === 'number' && step > 0)) {
      throw new Error('QuarksEffectPlayer: contract.fixedDelta required for stepTo');
    }
    const frames = Math.max(0, Math.round(seconds / step));
    this.restart();
    for (let frame = 0; frame < frames; frame++) this.update(step);
    // Quarks evaluates over-lifetime behaviours before incrementing particle.age. Unity's
    // captured/rendered state reflects curves at the completed frame time. A zero-delta pass
    // re-evaluates those pure behaviours at the final age without moving or aging particles.
    this.update(0);
    // Simulation may spawn/rebatch UV-tile systems onto fresh material clones.
    if (this.expectedArtifactShaderIds.size) {
      this.bindCompiledShaders(this.boundShaders, this.expectedArtifactShaderIds);
      this.refreshBatchUniformAudit();
    }
    this.stampLiveTweaks();
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

  captureSceneColor(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
    this.sceneColor.capture(renderer, scene, camera, this.batchRenderer);
  }

  private hasEffectLight = false;

  restart() {
    if (!this.effectRoot || this.state === 'disposed') return;
    if (typeof this.contract?.seed !== 'number') {
      throw new Error('QuarksEffectPlayer: contract.seed required for restart');
    }
    this.random.reset(this.contract.seed);
    this.clock.reset();
    resetAutoRotations(this.autoRotations);
    setCfxrEffectTime(0);
    this.withSeededRandom(() => QuarksUtil.restart(this.effectRoot!));
    armStartDelays(this.effectRoot, this.delayGate);
    this.applySolo();
    // QuarksUtil.restart rebuilds VFXBatch materials; re-stamp artifact fragments
    // and constant uniforms onto the live batch programs.
    if (this.expectedArtifactShaderIds.size) {
      this.bindCompiledShaders(this.boundShaders, this.expectedArtifactShaderIds);
      this.refreshBatchUniformAudit();
    }
    this.stampLiveTweaks();
    if (this.hasEffectLight) this.effectLight.restart();
    this.playing = true;
    this.state = 'playing';
  }

  pause() {
    if (!this.effectRoot) return;
    QuarksUtil.pause(this.effectRoot);
    this.effectLight.stop();
    this.state = 'paused';
  }

  resume() {
    if (!this.effectRoot) return;
    QuarksUtil.play(this.effectRoot);
    if (this.hasEffectLight) this.effectLight.restart();
    this.playing = true;
    this.state = 'playing';
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
    this.sceneColor.dispose();
    this.clock.reset();
    this.autoRotations = [];
    this.batchClosureAudit = [];
    this.qualifiedBatchClosures.clear();
    this.batchUniformAudit = [];
    this.boundShaders = {};
    this.expectedArtifactShaderIds.clear();
    this.uniformSource = 'artifact';
    this.fragmentSource = 'artifact';
    this.liveTweaks = { ...DEFAULT_LIVE_TWEAKS, tint: [...DEFAULT_LIVE_TWEAKS.tint] };
    this.tweakBaselines = new WeakMap();
    this.root.scale.set(1, 1, 1);
    setCfxrEffectTime(0);
    this.effectLight.stop();
    this.playing = false;
    this.contract = null;
    if (this.state !== 'disposed') this.state = 'empty';
  }

  dispose() {
    if (this.state === 'disposed') return;
    this.clear();
    this.root.remove(this.batchRenderer);
    this.state = 'disposed';
  }
}
