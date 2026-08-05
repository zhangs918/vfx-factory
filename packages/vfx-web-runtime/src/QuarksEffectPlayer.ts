import {
  Group,
  Object3D,
  Vector3,
  Euler,
  Quaternion,
  type WebGLRenderer,
  type Scene,
  type Camera,
} from 'three';
import { BatchedRenderer, QuarksLoader, QuarksUtil } from 'three.quarks';
import { setPhysicsResolver } from 'quarks.core';
import { Vector3 as QuarksVector3 } from 'quarks.core';
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
  patchCfxrBeforeBatch,
  patchCfxrAfterBatch,
  createStartDelayGate,
  armStartDelays,
  tickStartDelays,
  setCfxrEffectTime,
  updateCfxrCustomAttributes,
  type StartDelayGate,
} from './cfxrQuarksFidelity';
import { normalizeUnityQuarksJson } from './quarks-lowering';
import { CfxrEffectLight } from './effect-light';
import { SceneColorCapture } from './scene-color';

registerUnityEmitterShapes();

export interface PhysicsResolver {
  resolve(position: QuarksVector3, normal: QuarksVector3): boolean;
}

export interface QuarksEffectPlayerOptions {
  /** Host-owned physics adapter. Omit when the artifact does not require scene queries. */
  physicsResolver?: PhysicsResolver;
}

export interface QuarksManifestEntry {
  id: string;
  label: string;
  file: string;
  note?: string;
}

export interface QuarksManifest {
  effects: QuarksManifestEntry[];
}

export type VfxArtifactSource = string | URL | Record<string, unknown>;
export type PlayerState = 'empty' | 'loading' | 'playing' | 'paused' | 'finished' | 'error' | 'disposed';

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
  private autoRotations: Array<{
    target: Object3D;
    baseQuaternion: Quaternion;
    radiansPerSecond: [number, number, number];
    space: 'self' | 'world';
  }> = [];

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
    this.clock.reset();
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
    if (lifecycle && this.clock.time + 1e-7 >= stopAt) this.finishOneShot();
  }

  private finishOneShot() {
    if (this.effectRoot) QuarksUtil.stop(this.effectRoot);
    // Quarks' stop() clears particleNum, but the instanced batch still contains the previous
    // frame until it is rebuilt. Flush a zero-time batch update so a stopped one-shot cannot
    // leave a frozen column of billboard/trail instances on screen.
    this.updateBatchesExactlyOnce(0);
    this.effectLight.stop();
    this.playing = false;
    this.state = 'finished';
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
      simulationTime: Math.round(this.clock.time * 1e6) / 1e6,
      simulationUpdates: [...this.clock.updates],
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

  captureSceneColor(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
    this.sceneColor.capture(renderer, scene, camera, this.batchRenderer);
  }

  private hasEffectLight = false;

  restart() {
    if (!this.effectRoot || this.state === 'disposed') return;
    this.random.reset(this.contract?.seed ?? 1);
    this.clock.reset();
    for (const controller of this.autoRotations)
      controller.target.quaternion.copy(controller.baseQuaternion);
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

export async function loadQuarksManifest(candidate = false): Promise<QuarksManifest> {
  const res = await fetch(`/assets/quarks/${candidate ? 'manifest.candidates.json' : 'manifest.json'}`);
  if (!res.ok) return { effects: [] };
  return res.json();
}
