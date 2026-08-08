import type { VfxRuntimeArtifactV3 } from '@vfx-factory/artifact-schema';
import type { ArtifactRuntimeSink, PreparedV3Effect } from './v3-artifact-player';
import type { ArtifactQuarksPlayer } from './artifact-quarks-player';
import {
  assertArtifactEmitterSimCoversMounts,
  collectArtifactEmitterSim,
  type ArtifactEmitterSim,
} from './artifact-emitter-sim';

/** Compile-time gate: every pipeline/closure must already be material-offline. */
export function assertEffectMaterialThinReady(artifact: VfxRuntimeArtifactV3) {
  const pipelines = Object.entries(artifact.pipelines ?? {});
  if (!pipelines.length) {
    throw new Error(`thinPlayer: artifact '${artifact.effectId}' has no pipelines`);
  }
  const bridge = pipelines.filter(([, pipeline]) => pipeline.executor !== 'artifact-shader@1');
  if (bridge.length) {
    throw new Error(
      `thinPlayer: artifact '${artifact.effectId}' still has bridge pipelines: `
      + bridge.map(([id]) => id).join(', '),
    );
  }
  const closures = Object.entries(artifact.batchClosures ?? {});
  if (!closures.length) {
    throw new Error(`thinPlayer: artifact '${artifact.effectId}' has no batchClosures`);
  }
  const unproven = closures.filter(([, closure]) => (
    closure.qualification?.status !== 'pixel-qualified'
    && closure.qualification?.status !== 'manual-qualified'
  ));
  if (unproven.length) {
    throw new Error(
      `thinPlayer: artifact '${artifact.effectId}' has unproven closures: `
      + unproven.map(([id]) => id).join(', '),
    );
  }
  for (const [id, pipeline] of pipelines) {
    if (pipeline.executor !== 'artifact-shader@1') {
      throw new Error(`thinPlayer: pipeline '${id}' executor must be artifact-shader@1`);
    }
    if (!pipeline.blendState) {
      throw new Error(`thinPlayer: pipeline '${id}' is missing baked blendState`);
    }
    if (!pipeline.uniformValues) {
      throw new Error(`thinPlayer: pipeline '${id}' is missing baked uniformValues`);
    }
    if (!pipeline.tileCounts
      || !Array.isArray(pipeline.tileCounts)
      || pipeline.tileCounts.length !== 2
      || !Number.isFinite(pipeline.tileCounts[0])
      || !Number.isFinite(pipeline.tileCounts[1])) {
      throw new Error(`thinPlayer: pipeline '${id}' is missing baked tileCounts`);
    }
    const shader = artifact.shaders?.[pipeline.shader]
      ?? artifact.files?.shaders?.[pipeline.shader];
    if (!shader || shader.execution !== 'quarks-fragment-v1') {
      throw new Error(`thinPlayer: pipeline '${id}' shader is not quarks-fragment-v1`);
    }
    if (shader.vertexExecution !== 'quarks-vertex-v1') {
      throw new Error(`thinPlayer: pipeline '${id}' shader is missing quarks-vertex-v1 bake`);
    }
  }
  const simExec = artifact.execution?.simulation;
  if (simExec !== 'artifact-emitter-sim@1') {
    throw new Error(
      `thinPlayer: artifact '${artifact.effectId}' requires execution.simulation=artifact-emitter-sim@1 `
      + `(got '${simExec}')`,
    );
  }
  const trajectoryExec = artifact.execution?.trajectory;
  if (trajectoryExec !== 'artifact-trajectory@1') {
    throw new Error(
      `thinPlayer: artifact '${artifact.effectId}' requires execution.trajectory=artifact-trajectory@1 `
      + `(got '${trajectoryExec}')`,
    );
  }
}

/** Catalog filter: same gate as load, without throwing. */
export function isEffectMaterialThinReady(artifact: VfxRuntimeArtifactV3): boolean {
  try {
    assertEffectMaterialThinReady(artifact);
    return true;
  } catch {
    return false;
  }
}

/**
 * Simulation gate for thin: material-bearing emitters must carry offline mount
 * manifests so playback never consults global cfxrState maps.
 */
export function assertEffectSimulationThinReady(
  effectId: string,
  quarksConfig: Record<string, any>,
  runtimeConfig: Record<string, unknown> | undefined,
) {
  if (!Array.isArray(runtimeConfig?.startDelays)) {
    throw new Error(`thinPlayer: artifact '${effectId}' missing runtimeConfig.startDelays`);
  }
  const startDelays = new Map(
    (runtimeConfig.startDelays as Array<[string, number]>).map(([uuid, delay]) => [uuid, delay]),
  );
  const missing: string[] = [];
  const texByUuid = new Map((quarksConfig.textures ?? []).map((tex: any) => [tex.uuid, tex]));
  const matByUuid = new Map((quarksConfig.materials ?? []).map((mat: any) => [mat.uuid, mat]));
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ParticleEmitter' && node.uuid) {
      if (!startDelays.has(String(node.uuid))) {
        throw new Error(
          `thinPlayer: artifact '${effectId}' missing startDelay for emitter '${String(node.uuid)}' (no invent)`,
        );
      }
    }
    if (node.type === 'ParticleEmitter' && node.ps?.material) {
      const mount = node.ps.artifactBehaviorMount;
      if (mount?.schema !== 'cfxr-behavior-mount@1' || !Array.isArray(mount.mounts)) {
        missing.push(String(node.uuid ?? '(anonymous)'));
      } else {
        if (Array.isArray(node.ps.unityRendererFlip)) {
          const c1 = node.ps.artifactDefaultCustom1;
          const c2 = node.ps.artifactDefaultCustom2;
          if (!Array.isArray(c1) || c1.length !== 4 || c1.some((v: unknown) => typeof v !== 'number')
            || !Array.isArray(c2) || c2.length !== 4 || c2.some((v: unknown) => typeof v !== 'number')) {
            throw new Error(
              `thinPlayer: artifact '${effectId}' emitter '${String(node.uuid ?? '(anonymous)')}' `
              + 'missing offline artifactDefaultCustom1/2 (no invent)',
            );
          }
        }
        const sim: ArtifactEmitterSim = collectArtifactEmitterSim(node.ps) ?? { behaviorMount: mount };
        // Prefer collected bag; ensure behaviorMount is present for coverage check.
        if (!sim.behaviorMount) sim.behaviorMount = mount;
        if (typeof sim.mainMapSrgb !== 'boolean') {
          const mat = matByUuid.get(node.ps.material) as { map?: string } | undefined;
          if (mat?.map) {
            const tex = texByUuid.get(mat.map) as { sRGB?: boolean } | undefined;
            if (typeof tex?.sRGB !== 'boolean') {
              throw new Error(
                `thinPlayer: artifact '${effectId}' emitter '${String(node.uuid ?? '(anonymous)')}' missing offline mainMapSrgb`,
              );
            }
            sim.mainMapSrgb = !!tex.sRGB;
          }
        }
        assertArtifactEmitterSimCoversMounts(
          effectId,
          String(node.uuid ?? '(anonymous)'),
          sim,
          node.ps,
        );
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(quarksConfig.object);
  if (missing.length) {
    throw new Error(
      `thinPlayer: artifact '${effectId}' emitters missing artifactBehaviorMount: `
      + missing.join(', '),
    );
  }
}

/**
 * Shadow/migration backend for fully material-qualified effects.
 * Simulation mounts from emitter-local `__artifactEmitterSim` bags; the CFXR
 * ubershader inject path is never entered.
 */
export class ThinArtifactBackend implements ArtifactRuntimeSink {
  readonly needsShaders = true;
  readonly skipCfxrRuntimeHydrate = true;
  constructor(private readonly player: ArtifactQuarksPlayer) {}

  async loadPrepared(effect: PreparedV3Effect, label: string): Promise<void> {
    assertEffectMaterialThinReady(effect.artifact);
    assertEffectSimulationThinReady(
      effect.artifact.effectId,
      effect.quarksConfig,
      effect.runtimeState?.runtimeConfig as Record<string, unknown> | undefined,
    );
    if (effect.runtimeState?.cfxrState != null) {
      throw new Error(
        `thinPlayer: refuses cfxrState for '${effect.artifact.effectId}' `
        + `(simulation is bag-only; use skipCfxrRuntimeHydrate)`,
      );
    }
    await this.player.load({
      effectId: effect.artifact.effectId,
      seed: effect.artifact.metadata.seed,
      fixedDelta: effect.artifact.metadata.fixedDelta,
      terminalTime: Number.POSITIVE_INFINITY,
      simulation: effect.quarksConfig,
      geometryData: effect.geometryData,
      pipelines: effect.artifact.pipelines,
      shaders: effect.shaders,
      batchClosures: effect.artifact.batchClosures,
      runtimeState: {
        runtimeConfig: effect.runtimeState.runtimeConfig,
      },
    }, label);
  }
}
