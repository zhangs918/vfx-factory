import {
  Group,
  Object3D,
  Vector3,
  type WebGLRenderer,
  type Scene,
  type Camera,
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
import {
  extractStartDelays,
  setDissolveCurvesFromJson,
  setCfxrPropsFromJson,
  importCfxrRuntimeState,
  createStartDelayGate,
  armStartDelays,
  tickStartDelays,
  setCfxrEffectTime,
  type StartDelayGate,
} from './cfxrQuarksFidelity';
import { CfxrEffectLight } from './effect-light';
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

  /** URL-debug-safe state: lets regression tooling prove lifecycle progress without pixels. */
  get debugLifecycleState() {
    return {
      state: this.state,
      playing: this.playing,
      elapsed: this.clock.time,
      lifecycle: this.contract?.lifecycle ?? null,
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
    const runtimeJson = runtimeBundle?.payload ?? raw;
    this.clock.reset();
    setCfxrEffectTime(0);
    this.random.reset(this.contract.seed);
    if (this.contract.representation === 'camera-baked@1') {
      throw new Error('camera-baked@1 is an offline regression oracle and cannot be played in production.');
    }
    this.delayGate = createStartDelayGate(extractStartDelays(runtimeJson));
    setDissolveCurvesFromJson(runtimeJson);
    if (runtimeBundle?.cfxrState) importCfxrRuntimeState(runtimeBundle.cfxrState);
    else setCfxrPropsFromJson(runtimeJson);
    const lightController = Array.isArray(runtimeJson.controllers)
      ? runtimeJson.controllers.find((controller: any) => controller?.kind === 'deterministic-light-fade'
          || controller?.kind === 'sampled-unity-perlin-light')
      : undefined;
    this.hasEffectLight = !!runtimeJson.cfxrEffect || !!lightController;
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
    } else if (this.hasEffectLight) this.effectLight.configure(runtimeJson.cfxrEffect);
    else this.effectLight.stop();
    const obj = await loadQuarksObject(
      runtimeJson,
      this.batchRenderer,
      this.withSeededRandom.bind(this),
      !!runtimeBundle,
    );

    this.root.add(obj);
    this.effectRoot = obj;
    this.autoRotations = buildAutoRotations(obj, runtimeJson.controllers ?? []);
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
    return listEmitters(this.effectRoot);
  }

  private applySolo() {
    applySolo(this.effectRoot, this.soloName);
  }

  update(dt: number) {
    if (!this.playing) return;
    const lifecycle = this.contract?.lifecycle;
    // `terminalTime` is the last Unity-oracle-visible fixed frame. Let that frame render, then
    // clear on the following tick; clamping at terminalTime itself would erase valid t=2 data.
    const stopAt = lifecycle ? lifecycle.terminalTime + (this.contract?.fixedDelta ?? 1 / 60) : Infinity;
    const remaining = lifecycle
      ? Math.max(0, stopAt - this.clock.time)
      : dt;
    const appliedDt = Math.min(Math.max(0, dt), remaining);
    if (remaining <= 1e-7) {
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
    if (lifecycle && this.clock.time + 1e-7 >= stopAt) this.finishOneShot();
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

  captureSceneColor(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
    this.sceneColor.capture(renderer, scene, camera, this.batchRenderer);
  }

  private hasEffectLight = false;

  restart() {
    if (!this.effectRoot || this.state === 'disposed') return;
    this.random.reset(this.contract?.seed ?? 1);
    this.clock.reset();
    resetAutoRotations(this.autoRotations);
    setCfxrEffectTime(0);
    this.withSeededRandom(() => QuarksUtil.restart(this.effectRoot!));
    armStartDelays(this.effectRoot, this.delayGate);
    this.applySolo();
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
