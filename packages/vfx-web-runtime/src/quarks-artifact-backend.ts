import type { ArtifactRuntimeSink, PreparedV3Effect } from './v3-artifact-player';
import type { QuarksEffectPlayer } from './QuarksEffectPlayer';

/**
 * Production v3 backend. The artifact loader owns validation/resource hydration;
 * this backend is the only layer that translates the frozen artifact contract
 * into the three.quarks player input. No Unity or compiler code is involved.
 */
export class QuarksArtifactBackend implements ArtifactRuntimeSink {
  readonly needsShaders = true;
  constructor(private readonly player: QuarksEffectPlayer) {}

  async loadPrepared(effect: PreparedV3Effect, label: string): Promise<void> {
    if (!effect.runtimeState.cfxrState) {
      throw new Error(
        `QuarksArtifactBackend requires runtimeState.cfxrState for '${effect.artifact.effectId}'`,
      );
    }
    const seed = effect.artifact.metadata?.seed;
    const fixedDelta = effect.artifact.metadata?.fixedDelta;
    if (typeof seed !== 'number') {
      throw new Error(
        `QuarksArtifactBackend: artifact '${effect.artifact.effectId}' missing metadata.seed`,
      );
    }
    if (!(typeof fixedDelta === 'number' && fixedDelta > 0)) {
      throw new Error(
        `QuarksArtifactBackend: artifact '${effect.artifact.effectId}' missing positive metadata.fixedDelta`,
      );
    }
    await this.player.loadCompiledArtifact(
      effect.quarksConfig,
      {
        cfxrState: effect.runtimeState.cfxrState,
        runtimeConfig: effect.runtimeState.runtimeConfig,
      },
      {
        effectId: effect.artifact.effectId,
        seed,
        fixedDelta,
      },
      label,
      effect.geometryData,
      effect.artifact.pipelines,
      effect.shaders,
      effect.artifact.batchClosures,
    );
  }
}
