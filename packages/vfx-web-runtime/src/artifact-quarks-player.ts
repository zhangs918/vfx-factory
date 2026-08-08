import {
  Color,
  GLSL3,
  Group,
  Object3D,
  Vector2,
  Vector3,
  Vector4,
  type Camera,
  type Scene,
  type ShaderMaterial,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { BatchedRenderer, QuarksLoader, QuarksUtil } from 'three.quarks';
import { setPhysicsResolver } from 'quarks.core';
import { registerUnityEmitterShapes } from './unityEmitterShapes';
import { DeterministicClock, SeededRandom } from './deterministic';
import { applyBakedBlendState, type VfxPipelineBlendState } from './cfxr-blend-apply';
import { applyConstantUniforms, type VfxPipelineUniformValues } from './cfxr-constant-uniforms-apply';
import { patchCfxrSimulationBeforeBatch } from './cfxr-emitter-mount-core';
import { setArtifactEffectTime } from './artifact-host-effect-time';
import {
  clearArtifactSceneInputMaterials,
  registerArtifactSceneInputMaterial,
} from './artifact-scene-inputs';
import { loadArtifactTexture } from './artifact-texture-cache';
import { CfxrEffectLight, UNITY_TO_THREE_LIGHT_INTENSITY_SCALE } from './effect-light';
import {
  assertArtifactEmitterSimCoversMounts,
  collectArtifactEmitterSim,
  stampArtifactEmitterSim,
  type ArtifactEmitterSim,
} from './artifact-emitter-sim';
import {
  armStartDelays,
  createStartDelayGate,
  requireStartDelayCoverage,
  tickStartDelays,
  type StartDelayGate,
} from './start-delay-gate';
import { updateBatchesExactlyOnce } from './batch-stepper';
import { snapshotParticleState } from './particle-snapshot';
import { SceneColorCapture } from './scene-color';
import {
  applySolo,
  buildAutoRotations,
  listEmitters,
  resetAutoRotations,
  updateAutoRotations,
  type AutoRotation,
} from './player-controls';

type CaptureAuxMaps = {
  dissolve: Texture | null;
  mask: Texture | null;
  distortion: Texture | null;
  height: Texture | null;
};

export interface ArtifactShaderModule {
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

export interface ArtifactPlayerPipeline {
  materialId: string;
  shader: string;
  blend?: string;
  srcBlend?: number;
  dstBlend?: number;
  zWrite?: boolean;
  alphaTest?: number;
  blendState?: VfxPipelineBlendState;
  uniformValues?: VfxPipelineUniformValues;
  /** Offline UV tile counts for the fragment ABI (`tileCounts` uniform). */
  tileCounts?: [number, number];
  defines?: Record<string, string | number | boolean>;
  capturedUniforms?: Record<string, number | number[] | number[][]>;
  executor?: 'semantic-bridge@1' | 'artifact-shader@1';
  qualification?: { familyId?: string; status?: string };
}

export interface ArtifactPlayerClosure {
  vertexPatches?: string[];
  qualification?: { status?: 'bridge' | 'capture-stamped' | 'pixel-qualified' };
}

export interface ArtifactPlayerEffect {
  effectId: string;
  seed: number;
  fixedDelta: number;
  terminalTime: number;
  simulation: Record<string, any>;
  geometryData?: Record<string, { attributes: unknown; index?: unknown }>;
  pipelines?: Record<string, ArtifactPlayerPipeline>;
  shaders?: Record<string, ArtifactShaderModule>;
  batchClosures?: Record<string, ArtifactPlayerClosure>;
  /** Offline runtime config only (startDelays). Thin never accepts cfxrState maps. */
  runtimeState?: {
    runtimeConfig: Record<string, unknown>;
  };
}

type PlayerState = 'empty' | 'loading' | 'playing' | 'paused' | 'finished' | 'disposed';

/**
 * Thin online kernel for fully material-qualified v3 effects.
 * - Materials: baked blend/uniforms/vertex/fragment only (no CFXR ubershader inject)
 * - Simulation: `patchCfxrSimulationBeforeBatch` — mounts Unity behaviors /
 *   Color32 / map colorspace, but does not dual-path bridge blend or stash
 *   inject profiles
 */
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

export class ArtifactQuarksPlayer {
  readonly root = new Group();
  readonly batchRenderer = new BatchedRenderer();
  readonly effectLight = new CfxrEffectLight();
  soloName: string | null = null;
  private effectRoot: Object3D | null = null;
  private state: PlayerState = 'empty';
  private playing = false;
  private clock = new DeterministicClock();
  private random = new SeededRandom();
  private seed = 1;
  private fixedDelta = 1 / 60;
  private terminalTime = Infinity;
  private contract: any = null;
  private offlineAudit: Array<{
    batch: number;
    offlineOwned: string[];
    thinPlayerReady: boolean;
    mapColorSpace?: string;
    mapUuid?: string;
  }> = [];
  private boundShaders: Record<string, ArtifactShaderModule> = {};
  private boundEffect: ArtifactPlayerEffect | null = null;
  private delayGate: StartDelayGate = createStartDelayGate(new Map());
  private autoRotations: AutoRotation[] = [];
  private label = '';
  private hasEffectLight = false;
  private readonly sceneColor = new SceneColorCapture();
  /** Live-bridge-capture aux maps keyed by quarks material uuid. */
  private captureAuxByMaterial = new Map<string, CaptureAuxMaps>();

  constructor(options: {
    physicsResolver?: {
      resolve(
        position: { x: number; y: number; z: number },
        normal: { set(x: number, y: number, z: number): void },
      ): boolean;
    };
  } = {}) {
    registerUnityEmitterShapes();
    // Match QuarksEffectPlayer: ApplyCollision needs the same ground resolver.
    if (options.physicsResolver) setPhysicsResolver(options.physicsResolver);
    this.root.name = 'ArtifactQuarksPlayer';
    this.root.add(this.batchRenderer);
    this.effectLight.attach(this.root);
  }

  get isPlaying() { return this.playing; }
  get playbackState() { return this.state; }
  get semanticContract() { return this.contract; }
  get debugLifecycleState() {
    const thinReadyBatches = this.offlineAudit.filter((row) => row.thinPlayerReady).length;
    return {
      state: this.state,
      playing: this.playing,
      elapsed: this.clock.time,
      player: 'ArtifactQuarksPlayer',
      beforeBatchMaterialSide: 'simulation',
      offlineAudit: this.offlineAudit,
      thinPlayerReadyBatches: thinReadyBatches,
      effectThinPlayerReady: this.offlineAudit.length > 0
        && this.offlineAudit.every((row) => row.thinPlayerReady),
    };
  }

  snapshotState() {
    if (!this.contract || !this.effectRoot) {
      return { state: this.state, time: this.clock.time };
    }
    return snapshotParticleState(this.effectRoot, this.contract, this.clock);
  }
  async loadAndPlay(_source: unknown, _label: string): Promise<void> {
    throw new Error('ArtifactQuarksPlayer accepts only prepared v3 artifacts; use ThinArtifactBackend.');
  }

  async load(effect: ArtifactPlayerEffect, label = effect.effectId): Promise<void> {
    if (this.state === 'disposed') throw new Error('Cannot load an effect after dispose().');
    this.clear();
    this.state = 'loading';
    this.label = label;
    this.seed = effect.seed;
    // Match QuarksEffectPlayer.loadAndPlay: Noise's module-level Simplex pool is
    // filled on first `new Noise()` during QuarksLoader.parse via Math.random.
    // Reset before parse so thick/thin share the same generator tables.
    this.random.reset(this.seed);
    if (!(effect.fixedDelta > 0)) {
      throw new Error(`thinPlayer: effect '${effect.effectId}' missing positive fixedDelta`);
    }
    this.fixedDelta = effect.fixedDelta;
    this.terminalTime = effect.terminalTime > 0 ? effect.terminalTime : Infinity;
    if (!effect.simulation?.vfxIR) {
      throw new Error(`thinPlayer: effect '${effect.effectId}' missing simulation.vfxIR`);
    }
    this.contract = effect.simulation.vfxIR;
    const json = structuredClone(effect.simulation) as any;
    for (const geometry of json.geometries ?? []) {
      const data = geometry.resourceId ? effect.geometryData?.[geometry.resourceId] : undefined;
      if (data) geometry.data = data;
      if (geometry.resourceId && !geometry.data) {
        throw new Error(
          `thinPlayer: effect '${effect.effectId}' geometry '${geometry.uuid ?? '(anonymous)'}' `
          + `was not hydrated from '${geometry.resourceId}'`,
        );
      }
    }
    const simByEmitter = new Map<string, ArtifactEmitterSim>();
    const materialIdByEmitter = new Map<string, string>();
    const tileCountsByMaterial = new Map<string, [number, number]>();
    const texByUuid = new Map((json.textures ?? []).map((tex: any) => [tex.uuid, tex]));
    const matByUuid = new Map((json.materials ?? []).map((mat: any) => [mat.uuid, mat]));
    // Thin simulation bags come from hydrated emitter `ps` only (artifact* /
    // unity* fields). Declared behavior mounts already gate blend/color32.
    // Vertex patches / batch closure ids are compile-time material metadata —
    // thin binds baked quarks-vertex-v1 shaders and does not stamp them live.
    const collectOfflineBindings = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ParticleEmitter' && typeof node.uuid === 'string') {
        const sim = collectArtifactEmitterSim(node.ps) ?? {};
        if (node.ps?.material) {
          materialIdByEmitter.set(node.uuid, String(node.ps.material));
          if (sim.behaviorMount?.schema !== 'cfxr-behavior-mount@1') {
            throw new Error(
              `Artifact '${effect.effectId}' emitter '${node.uuid}' missing offline behaviorMount bag`,
            );
          }
          // Prefer compile stamp; else resolve from offline texture.sRGB table.
          // Do not invent sRGB=true when the table omits the flag.
          if (typeof sim.mainMapSrgb !== 'boolean') {
            const mat = matByUuid.get(node.ps.material) as { map?: string } | undefined;
            if (mat?.map) {
              const tex = texByUuid.get(mat.map) as { sRGB?: boolean } | undefined;
              if (typeof tex?.sRGB !== 'boolean') {
                throw new Error(
                  `Artifact '${effect.effectId}' emitter '${node.uuid}' missing offline mainMapSrgb`,
                );
              }
              sim.mainMapSrgb = !!tex.sRGB;
            }
          }
          assertArtifactEmitterSimCoversMounts(effect.effectId, node.uuid, sim, node.ps);
          // No [1,1] invent — pipeline stamp or bag must supply tileCounts later.
          if (sim.tileCounts) {
            const tiles = sim.tileCounts;
            const matId = String(node.ps.material);
            const prev = tileCountsByMaterial.get(matId);
            if (prev && (prev[0] !== tiles[0] || prev[1] !== tiles[1])) {
              throw new Error(
                `Artifact '${effect.effectId}' material '${matId}' has disagreeing offline tileCounts`,
              );
            }
            tileCountsByMaterial.set(matId, tiles);
          }
        }
        if (Object.keys(sim).length) simByEmitter.set(node.uuid, sim);
      }
      for (const child of node.children ?? []) collectOfflineBindings(child);
    };
    collectOfflineBindings(json.object);
    for (const material of json.materials ?? []) {
      const pipeline = Object.values(effect.pipelines ?? {}).find(
        (candidate) => candidate.materialId === material.uuid,
      );
      if (!pipeline) continue;
      const shader = effect.shaders?.[pipeline.shader];
      if (!shader) throw new Error(`Artifact '${effect.effectId}' is missing shader '${pipeline.shader}'.`);
      const tileCounts = pipeline.tileCounts
        ?? tileCountsByMaterial.get(String(material.uuid));
      if (!tileCounts) {
        throw new Error(
          `Artifact '${effect.effectId}' material '${material.uuid}' missing offline tileCounts`,
        );
      }
      const pipelineWithTiles: ArtifactPlayerPipeline = { ...pipeline, tileCounts };
      material.userData ??= {};
      material.userData.artifactShaderId = pipeline.shader;
      material.userData.artifactShader = shader;
      material.userData.artifactPipeline = pipelineWithTiles;
      if (pipeline.blendState) {
        material.userData.artifactBlendState = pipeline.blendState;
      }
      if (pipeline.uniformValues) {
        material.userData.artifactUniformValues = pipeline.uniformValues;
      }
      material.userData.artifactTileCounts = tileCounts;
      if (!pipeline.executor) {
        throw new Error(
          `Artifact '${effect.effectId}' material '${material.uuid}' missing pipeline.executor`,
        );
      }
      material.userData.artifactExecutor = pipeline.executor;
      material.userData.artifactFamilyId = pipeline.qualification?.familyId;
    }

    // Thin mounts are bag-only (`cfxr-emitter-mount-core`); they never read
    // global CFXR runtime-state maps, so no table reset is required.
    // Thin contract: startDelays are offline-authored in runtimeConfig. Do not
    // fall back to extractStartDelays (it also mutates spawn schedules).
    const startDelays = effect.runtimeState?.runtimeConfig?.startDelays as Array<[string, number]> | undefined;
    if (!Array.isArray(startDelays)) {
      throw new Error(`Artifact '${effect.effectId}' missing runtimeConfig.startDelays`);
    }
    this.delayGate = createStartDelayGate(new Map(startDelays));
    this.configureEffectLight(effect.runtimeState?.runtimeConfig);
    setArtifactEffectTime(0);

    const loader = new QuarksLoader();
    const object = await new Promise<Object3D>((resolve, reject) => {
      try {
        this.withSeededRandom(() => loader.parse(json, (ready) => resolve(ready)));
      } catch (error) {
        reject(error);
      }
    });

    this.withSeededRandom(() => {
      // Stamp offline sim bags before simulation mounts. Always stamp (even `{}`)
      // so mounts enter local-only mode and cannot fall back to cleared maps.
      object.traverse((child: any) => {
        if (child?.type !== 'ParticleEmitter') return;
        const system = child.system as any;
        if (!system) return;
        const bag = simByEmitter.get(child.uuid) ?? {};
        stampArtifactEmitterSim(system, bag, { forbidMaterialProps: true });
        // QuarksLoader does not preserve arbitrary serialized material.userData.
        // Mount-time blend runs before finalizeOfflineMaterials, so copy the
        // already-compiled pipeline constants onto the live settings material
        // now; this is an artifact lookup, not a semantic/runtime fallback.
        const materialId = materialIdByEmitter.get(child.uuid);
        const pipeline = materialId ? Object.values(effect.pipelines ?? {}).find(
          (candidate) => candidate.materialId === materialId,
        ) : undefined;
        const material = system.material ?? system.rendererSettings?.material;
        if (!pipeline?.blendState || !material?.isMaterial) {
          throw new Error(
            `thinPlayer: emitter '${child.uuid}' missing mount-time offline blend pipeline`,
          );
        }
        material.userData ??= {};
        material.userData.artifactBlendState = pipeline.blendState;
        material.userData.artifactPipeline = pipeline;
        material.userData.artifactShaderId = pipeline.shader;
      });
      // Simulation mounts + Color32 / map colorspace only. Skip bridge dual-path
      // blend and inject-profile stash — finalizeOfflineMaterials owns materials.
      patchCfxrSimulationBeforeBatch(object);
      // Do not rewrite Material.type — see compiled-quarks-loader. Homogeneous
      // closure binding already refuses mixed artifact/bridge batches.
      QuarksUtil.addToBatchRenderer(object, this.batchRenderer);
    });

    this.boundEffect = effect;
    this.boundShaders = effect.shaders ?? {};
    await this.loadCaptureAuxMaps(json, effect);
    this.finalizeOfflineMaterials(effect);
    this.bindExecutableShaders(this.boundShaders);
    this.root.add(object);
    this.effectRoot = object;
    // QuarksLoader decomposes authored float32 matrices into noisy non-1 scale on
    // emitters (including nested children). Match thick stampLiveTweaks intent:
    // keep preview scale on player.root only.
    this.normalizeEmitterScales(this.effectRoot);
    const controllers = effect.runtimeState?.runtimeConfig?.controllers;
    this.autoRotations = buildAutoRotations(object, Array.isArray(controllers) ? controllers : []);
    requireStartDelayCoverage(this.effectRoot, this.delayGate.delays);
    this.clock.reset();
    this.restart();
    void label;
  }

  update(dt: number) {
    if (!this.playing || !this.effectRoot) return;
    const remaining = this.terminalTime === Infinity
      ? dt
      : Math.max(0, this.terminalTime + this.fixedDelta - this.clock.time);
    if (this.terminalTime !== Infinity && remaining <= 1e-7) {
      this.finish();
      return;
    }
    const applied = Math.min(Math.max(0, dt), remaining === dt ? dt : remaining);
    this.clock.advance(applied);
    setArtifactEffectTime(this.clock.time);
    this.withSeededRandom(() => {
      updateAutoRotations(this.autoRotations, applied);
      const emitterDeltas = this.effectRoot
        ? tickStartDelays(this.effectRoot, this.delayGate, applied)
        : new Map();
      updateBatchesExactlyOnce(this.batchRenderer, applied, emitterDeltas);
      if (this.hasEffectLight) this.effectLight.update(applied);
    });
    if (this.terminalTime !== Infinity && this.clock.time + 1e-7 >= this.terminalTime + this.fixedDelta) {
      this.finish();
    }
  }

  async stepTo(seconds: number) {
    this.restart();
    const frames = Math.max(0, Math.round(seconds / this.fixedDelta));
    for (let i = 0; i < frames; i++) this.update(this.fixedDelta);
    this.update(0);
    if (this.boundEffect) {
      this.finalizeOfflineMaterials(this.boundEffect);
      this.bindExecutableShaders(this.boundShaders);
    }
  }

  restart() {
    if (!this.effectRoot) return;
    this.random.reset(this.seed);
    this.clock.reset();
    setArtifactEffectTime(0);
    resetAutoRotations(this.autoRotations);
    this.normalizeEmitterScales(this.effectRoot);
    this.withSeededRandom(() => QuarksUtil.restart(this.effectRoot!));
    armStartDelays(this.effectRoot, this.delayGate);
    this.applySolo();
    // QuarksUtil.restart rebuilds batch materials; re-apply offline fragment + uniforms.
    if (this.boundEffect) {
      this.finalizeOfflineMaterials(this.boundEffect);
      this.bindExecutableShaders(this.boundShaders);
    }
    // QuarksUtil.restart can restore float32 scale from the serialized matrix.
    this.normalizeEmitterScales(this.effectRoot);
    if (this.hasEffectLight) this.effectLight.restart();
    this.playing = true;
    this.state = 'playing';
  }
  pause() {
    if (this.effectRoot) {
      QuarksUtil.pause(this.effectRoot);
      this.effectLight.stop();
      // Match QuarksEffectPlayer.pause: keep `playing` true so freeze/regression
      // host paths that gate on isPlaying still run scene-color capture.
      this.state = 'paused';
    }
  }
  resume() {
    if (this.effectRoot) {
      QuarksUtil.play(this.effectRoot);
      if (this.hasEffectLight) this.effectLight.restart();
      this.playing = true;
      this.state = 'playing';
    }
  }
  setSolo(name: string | null) { this.soloName = name; this.applySolo(); }
  setVerticalGroundPresentation(enabled: boolean, lift = 1.15) {
    this.root.rotation.set(enabled ? -Math.PI / 2 : 0, 0, 0);
    this.root.position.set(0, enabled ? Math.max(0, lift) : 0, 0);
    this.root.updateMatrixWorld(true);
  }
  captureSceneColor(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
    this.sceneColor.capture(renderer, scene, camera, this.batchRenderer);
  }
  listEmitters() { return listEmitters(this.effectRoot); }
  clear() {
    if (this.effectRoot) {
      QuarksUtil.stop(this.effectRoot);
      this.root.remove(this.effectRoot);
      this.effectRoot = null;
    }
    // Drop old batches so materials/shaders don't leak across loads.
    // Object3D.remove alone leaves entries in BatchedRenderer.batches.
    while (this.batchRenderer.batches.length) {
      const batch = this.batchRenderer.batches.pop();
      if (batch) {
        this.batchRenderer.remove(batch);
        batch.geometry?.dispose();
        (batch.material as { dispose?: () => void })?.dispose?.();
      }
    }
    this.batchRenderer.systemToBatchIndex.clear();
    this.offlineAudit = [];
    this.boundShaders = {};
    this.boundEffect = null;
    this.captureAuxByMaterial.clear();
    clearArtifactSceneInputMaterials();
    this.autoRotations = [];
    this.hasEffectLight = false;
    this.effectLight.stop();
    this.playing = false;
    this.state = 'empty';
    this.contract = null;
    this.clock.reset();
  }
  dispose() {
    this.clear();
    this.root.remove(this.batchRenderer);
    this.effectLight.stop();
    this.state = 'disposed';
  }

  private finish() {
    if (this.effectRoot) QuarksUtil.stop(this.effectRoot);
    updateBatchesExactlyOnce(this.batchRenderer, 0);
    this.effectLight.stop();
    this.playing = false;
    this.state = 'finished';
  }

  private configureEffectLight(runtimeConfig: Record<string, unknown> | undefined) {
    const controllers = runtimeConfig?.controllers;
    const lightController = Array.isArray(controllers)
      ? controllers.find((controller: any) => controller?.kind === 'deterministic-light-fade'
        || controller?.kind === 'sampled-unity-perlin-light')
      : undefined;
    const cfxrEffect = runtimeConfig?.cfxrEffect as Record<string, unknown> | undefined;
    this.hasEffectLight = !!cfxrEffect || !!lightController;
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
    } else if (this.hasEffectLight) {
      this.effectLight.configure(cfxrEffect as any);
    } else {
      this.effectLight.stop();
    }
  }

  /** Apply offline-baked blend / uniforms. Never consult CFXR profiles. */
  private finalizeOfflineMaterials(effect: ArtifactPlayerEffect) {
    this.offlineAudit = this.batchRenderer.batches.map((batch, index) => {
      const batchMaterial = batch.material as ShaderMaterial;
      const settingsPipeline = [...batch.systems]
        .map((system: any) => system.rendererSettings?.material?.userData?.artifactPipeline as ArtifactPlayerPipeline | undefined)
        .find(Boolean)
        ?? (batchMaterial.userData as { artifactPipeline?: ArtifactPlayerPipeline }).artifactPipeline;
      const offlineOwned: string[] = [];
      if (!settingsPipeline) {
        return { batch: index, offlineOwned, thinPlayerReady: false };
      }

      if (!settingsPipeline.blendState) {
        throw new Error(
          `ArtifactQuarksPlayer batch ${index} missing baked blendState (no side/toneMapped invent)`,
        );
      }
      if (!settingsPipeline.uniformValues) {
        throw new Error(
          `ArtifactQuarksPlayer batch ${index} missing baked uniformValues (no invent)`,
        );
      }
      const uniforms = settingsPipeline.uniformValues;
      if (typeof uniforms.opacityGain !== 'number') {
        throw new Error(
          `ArtifactQuarksPlayer batch ${index} missing baked opacityGain (no invent)`,
        );
      }
      if (!Array.isArray(uniforms.materialColor) || uniforms.materialColor.length !== 3
        || uniforms.materialColor.some((channel) => typeof channel !== 'number')) {
        throw new Error(
          `ArtifactQuarksPlayer batch ${index} missing baked materialColor[3] (no invent)`,
        );
      }
      // Prefer pipeline/material offline stamp; bag is the emitter-local source.
      const tiles = settingsPipeline.tileCounts
        ?? (batchMaterial.userData as { artifactTileCounts?: [number, number] }).artifactTileCounts;
      if (!Array.isArray(tiles) || tiles.length !== 2
        || typeof tiles[0] !== 'number' || typeof tiles[1] !== 'number'
        || !(tiles[0] >= 1) || !(tiles[1] >= 1)) {
        throw new Error(
          `ArtifactQuarksPlayer batch ${index} missing offline tileCounts[2] >= 1 (no invent)`,
        );
      }

      const shaderId = settingsPipeline.shader
        ?? [...batch.systems]
          .map((system: any) => system.rendererSettings?.material?.userData?.artifactShaderId as string | undefined)
          .find((value) => typeof value === 'string');
      const shaderModule = shaderId ? effect.shaders?.[shaderId] : undefined;
      if (shaderModule?.vertexExecution !== 'quarks-vertex-v1') {
        throw new Error(
          `ArtifactQuarksPlayer requires quarks-vertex-v1 bake`
          + (shaderId ? ` for shader '${shaderId}'` : ''),
        );
      }
      // Baked Quarks+patches vertex — bindExecutableShaders writes it.
      offlineOwned.push('blend', 'uniforms', 'vertex');
      if (settingsPipeline.executor === 'artifact-shader@1') offlineOwned.push('fragment');
      offlineOwned.sort();
      const thinPlayerReady = ['blend', 'fragment', 'uniforms', 'vertex']
        .every((key) => offlineOwned.includes(key));
      const map = batchMaterial.uniforms?.map?.value as Texture | undefined;

      // Match QuarksEffectPlayer.bindCompiledShaders: restart / UV-tile batches may
      // clone from settings.material — stamp every draw target, not only batch.material.
      const targets = new Set<ShaderMaterial>([batchMaterial]);
      for (const system of batch.systems as unknown as any[]) {
        const settingsMat = system.rendererSettings?.material as ShaderMaterial | undefined;
        if (settingsMat) targets.add(settingsMat);
      }
      for (const material of targets) {
        if (shaderModule?.provenance?.kind === 'live-bridge-capture@1') {
          // Keep the exact CFXR defines recorded from the thick path.
          material.defines = { ...(shaderModule.defines ?? {}) };
        } else {
          const defines: Record<string, string> = { ...((material.defines ?? {}) as Record<string, string>) };
          delete defines.USE_COLOR_AS_ALPHA;
          delete defines.USE_ALPHATEST;
          for (const key of Object.keys(defines)) {
            if (key.startsWith('CFXR_')) delete defines[key];
          }
          material.defines = defines;
        }
        // GLSL3 is set in bindExecutableShaders when offline shaders are written.
        applyBakedBlendState(material, settingsPipeline.blendState);
        applyConstantUniforms(material, uniforms);
        if (settingsPipeline.capturedUniforms) {
          for (const [name, value] of Object.entries(settingsPipeline.capturedUniforms)) {
            if (name === 'effectTime' || name === 'cameraNear' || name === 'cameraFar' || name === 'sceneColorSize') {
              continue;
            }
            if (typeof value === 'number') {
              material.uniforms[name] = { value };
              continue;
            }
            if (!Array.isArray(value) || value.length === 0) continue;
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
              material.uniforms[name] = /color/i.test(name)
                ? { value: new Color(nums[0], nums[1], nums[2]) }
                : { value: new Vector3(nums[0], nums[1], nums[2]) };
            } else if (nums.length === 4) {
              material.uniforms[name] = { value: new Vector4(nums[0], nums[1], nums[2], nums[3]) };
            }
          }
        }
        material.uniforms.tileCounts = { value: new Vector2(tiles[0], tiles[1]) };
        if (shaderModule?.provenance?.kind === 'live-bridge-capture@1') {
          this.applyCaptureAuxMaps(material, batch);
        }
        // Capture stamps used to bake effectTime/camera*; those are host-synced.
        // Always allocate placeholders + register so setCfxrEffectTime can drive them.
        if (settingsPipeline.capturedUniforms
          || shaderModule?.provenance?.kind === 'live-bridge-capture@1') {
          this.ensureHostSceneUniforms(material);
          registerArtifactSceneInputMaterial(material);
        }
        (material.userData as { offlineOwned?: string[]; cfxrInjectMode?: string }).offlineOwned = offlineOwned;
        (material.userData as { cfxrInjectMode?: string }).cfxrInjectMode = 'artifact-player';
        material.needsUpdate = true;
      }
      return {
        batch: index,
        offlineOwned,
        thinPlayerReady,
        mapColorSpace: map?.colorSpace,
        mapUuid: map?.uuid,
      };
    });
  }

  /**
   * Live-bridge captures still sample CFXR aux maps. Resolve them from offline
   * material `userData.maps` / `cfxrProps` texture UUIDs → quarks image URLs.
   */
  private async loadCaptureAuxMaps(
    json: { materials?: any[]; textures?: any[]; images?: any[] },
    effect: ArtifactPlayerEffect,
  ) {
    this.captureAuxByMaterial.clear();
    const needsCapture = Object.values(effect.shaders ?? {})
      .some((shader) => shader.provenance?.kind === 'live-bridge-capture@1');
    if (!needsCapture) return;

    const texByUuid = new Map((json.textures ?? []).map((tex: any) => [tex.uuid, tex]));
    const imgByUuid = new Map((json.images ?? []).map((img: any) => [img.uuid, img]));
    const resolveSlot = (texUuid: string | undefined): {
      url: string;
      srgb: boolean;
      sampler?: { wrap?: [number, number]; magFilter?: number; minFilter?: number };
    } | null => {
      if (!texUuid) return null;
      const tex = texByUuid.get(texUuid);
      if (!tex?.image) return null;
      const img = imgByUuid.get(tex.image);
      if (!img?.url || typeof img.url !== 'string') return null;
      // Match thick loadCfxrInjectMaps: honor offline wrap/filter stamps.
      const sampler = {
        wrap: Array.isArray(tex.wrap) && tex.wrap.length >= 2
          ? [Number(tex.wrap[0]), Number(tex.wrap[1])] as [number, number]
          : undefined,
        magFilter: Number.isFinite(tex.magFilter) ? Number(tex.magFilter) : undefined,
        minFilter: Number.isFinite(tex.minFilter) ? Number(tex.minFilter) : undefined,
      };
      const hasSampler = sampler.wrap || sampler.magFilter != null || sampler.minFilter != null;
      return { url: img.url, srgb: !!tex.sRGB, ...(hasSampler ? { sampler } : {}) };
    };
    const loadSlot = async (texUuid: string | undefined): Promise<Texture | null> => {
      const resolved = resolveSlot(texUuid);
      if (!resolved) return null;
      return loadArtifactTexture(resolved.url, resolved.srgb, resolved.sampler);
    };

    for (const mat of json.materials ?? []) {
      const matId = String(mat.uuid ?? '');
      if (!matId) continue;
      const maps = (mat.userData?.maps ?? {}) as Record<string, string | undefined>;
      const props = (mat.userData?.cfxrProps ?? {}) as Record<string, string | undefined>;
      const dissolveId = maps.dissolve ?? props.dissolveMap;
      const maskId = maps.mask ?? props.maskMap;
      const distortionId = maps.distortion ?? props.distortionMap;
      const heightId = maps.height ?? props.heightMap;
      if (!dissolveId && !maskId && !distortionId && !heightId) continue;
      this.captureAuxByMaterial.set(matId, {
        dissolve: await loadSlot(dissolveId),
        mask: await loadSlot(maskId),
        distortion: await loadSlot(distortionId),
        height: await loadSlot(heightId),
      });
    }
  }

  private ensureHostSceneUniforms(material: ShaderMaterial) {
    material.uniforms.effectTime ??= { value: 0 };
    material.uniforms.cameraNear ??= { value: 0.1 };
    material.uniforms.cameraFar ??= { value: 100 };
    material.uniforms.sceneColorSize ??= { value: new Vector3(1, 1, 0) };
    material.uniforms.sceneColorMap ??= { value: null };
    material.uniforms.sceneDepthMap ??= { value: null };
  }

  private applyCaptureAuxMaps(
    material: ShaderMaterial,
    batch: { systems: Iterable<object>; material: object },
  ) {
    let aux: CaptureAuxMaps | undefined;
    for (const system of batch.systems as unknown as any[]) {
      const settingsMat = system.rendererSettings?.material as ShaderMaterial | undefined;
      if (!settingsMat) continue;
      const sid = String((settingsMat as any)?.uuid ?? '');
      if (sid && this.captureAuxByMaterial.has(sid)) {
        aux = this.captureAuxByMaterial.get(sid);
        break;
      }
      // Quarks may rewrite Material.uuid; recover export id from pipeline key
      // (`mat-<exportUuid>`) via the stamped artifactShaderId.
      const shaderId = settingsMat.userData?.artifactShaderId as string | undefined;
      if (shaderId && this.boundEffect?.pipelines) {
        for (const [pipelineId, pipeline] of Object.entries(this.boundEffect.pipelines)) {
          if (pipeline.shader !== shaderId) continue;
          if (pipelineId.startsWith('mat-')) {
            aux = this.captureAuxByMaterial.get(pipelineId.slice(4));
            if (aux) break;
          }
        }
      }
      if (aux) break;
    }
    if (!aux) {
      // Still allocate scene samplers so SceneColorCapture can bind later.
      material.uniforms.sceneColorMap ??= { value: null };
      material.uniforms.sceneDepthMap ??= { value: null };
      return;
    }
    const hasDefine = (name: string) =>
      !!material.defines && Object.prototype.hasOwnProperty.call(material.defines, name);
    // Match loadCfxrInjectMaps: distortion is also required for trail-front-face / orb-warp.
    const needsDistortion = hasDefine('CFXR_DISTORTION')
      || hasDefine('CFXR_TRAIL_FRONT_FACE_V2')
      || hasDefine('CFXR_ORB_WARP_V1');
    if (aux.dissolve && hasDefine('CFXR_DISSOLVE')) {
      material.uniforms.dissolveMap = { value: aux.dissolve };
    }
    if (aux.mask && hasDefine('CFXR_MASK')) {
      material.uniforms.maskMap = { value: aux.mask };
    }
    if (aux.distortion && needsDistortion) {
      material.uniforms.distortionMap = { value: aux.distortion };
    }
    if (aux.height && hasDefine('CFXR_PARALLAX_OCCLUSION')) {
      material.uniforms.heightMap = { value: aux.height };
    }
    // Host placeholders — SceneColorCapture overwrites each frame when registered.
    material.uniforms.sceneColorMap = { value: null };
    material.uniforms.sceneDepthMap = { value: null };
  }

  /** Match thick stampLiveTweaks: only the effect root is forced to unit scale. */
  private normalizeEmitterScales(root: Object3D) {
    root.scale.set(1, 1, 1);
  }

  private bindExecutableShaders(shaders: Record<string, ArtifactShaderModule>) {
    for (const batch of this.batchRenderer.batches) {
      let module: ArtifactShaderModule | undefined;
      for (const system of batch.systems as unknown as any[]) {
        const id = system.rendererSettings?.material?.userData?.artifactShaderId;
        const candidate = id ? shaders[id] : undefined;
        if (candidate?.execution === 'quarks-fragment-v1') { module = candidate; break; }
      }
      if (!module) continue;
      const targets = new Set<ShaderMaterial>([batch.material as ShaderMaterial]);
      for (const system of batch.systems as unknown as any[]) {
        const settingsMat = system.rendererSettings?.material as ShaderMaterial | undefined;
        if (settingsMat) targets.add(settingsMat);
      }
      for (const material of targets) {
        // Direct write — onBeforeCompile is wiped when QuarksUtil.restart rebuilds batches.
        material.fragmentShader = module.fragment;
        if (module.vertexExecution === 'quarks-vertex-v1') {
          material.vertexShader = module.vertex;
        }
        material.glslVersion = GLSL3;
        material.needsUpdate = true;
      }
    }
  }
  private applySolo() {
    applySolo(this.effectRoot, this.soloName);
  }
  private withSeededRandom<T>(fn: () => T): T {
    const original = Math.random;
    Math.random = this.random.next;
    try { return fn(); } finally { Math.random = original; }
  }
}
