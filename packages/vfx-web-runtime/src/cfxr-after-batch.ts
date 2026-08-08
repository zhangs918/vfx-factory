/**
 * Production after-batch orchestration: resolve inject profiles and dispatch
 * slim/full CFXR material inject. Thin ArtifactQuarksPlayer never enters here.
 */
import { MeshBasicMaterial, type ShaderMaterial } from 'three';
import type { VfxPipelineBlendState } from './cfxr-blend-state';
import type { VfxPipelineUniformValues } from './cfxr-constant-uniforms';
import { clearCfxrSceneInputMaterials } from './cfxr-scene-inputs';
import { updateCfxrCustomAttributes } from './batch-stepper';
import type { CfxrRuntimeProfile } from './cfxr-material-profile';
import { resolveMountPolicy } from './cfxr-mount-policy';
import { injectCfxrShader, loadCfxrInjectMaps } from './cfxr-full-inject';
import { readArtifactEmitterSim } from './artifact-emitter-sim';
import { BatchedRenderer } from 'three.quarks';

export async function patchCfxrAfterBatch(batchRenderer: BatchedRenderer) {
  clearCfxrSceneInputMaterials();
  const policy = resolveMountPolicy();
  // ?cfxrFragment=force → bridge ubershader body for every batch.
  const forceBridgeFragment = policy.fragment === 'bridge';
  for (const batch of batchRenderer.batches) {
    const settingsMat = batch.settings.material as MeshBasicMaterial & {
      userData?: { cfxr?: CfxrRuntimeProfile };
    };
    let profile = settingsMat.userData?.cfxr;

    // Live authority is system-local beforeBatch stamp (__cfxrProfile).
    if (!profile) {
      for (const sys of batch.systems) {
        const local = (sys as unknown as { __cfxrProfile?: CfxrRuntimeProfile }).__cfxrProfile;
        if (local) {
          profile = local;
          break;
        }
      }
    }
    if (!profile?.tileCounts) {
      if (!profile) continue;
      throw new Error('after-batch: profile missing offline tileCounts');
    }

    const mat = batch.material as ShaderMaterial;
    if (!mat?.isShaderMaterial) continue;

    // Declare the instance stream before first shader compilation. The values are refreshed
    // after each simulation/batch update by updateCfxrCustomAttributes().
    updateCfxrCustomAttributes(batchRenderer);

    // Artifact-shader pipelines receive an offline fragment via bindCompiledShaders.
    // Keep inject for uniforms/vertex (stretch), but skip the CFXR ubershader body
    // unless ?cfxrFragment=force opts back into the historical full inject.
    let artifactExecutor: string | undefined;
    let declaredVertexPatches: string[] | undefined;
    let bagTileCounts: [number, number] | undefined;
    for (const system of batch.systems) {
      const executor = (system as any).rendererSettings?.material?.userData?.artifactExecutor;
      if (typeof executor === 'string') artifactExecutor ??= executor;
      const bag = readArtifactEmitterSim(system);
      const bagPatches = bag?.vertexPatches;
      // Empty array is a valid offline declaration (custom-attrs-only etc.).
      if (declaredVertexPatches === undefined && bagPatches) {
        declaredVertexPatches = bagPatches;
      }
      if (!bagTileCounts && bag?.tileCounts) {
        bagTileCounts = bag.tileCounts;
      }
    }
    // Bag-only vertexPatches — no vertexPatchesByEmitter dual authority.
    artifactExecutor ??= (settingsMat as any).userData?.artifactExecutor;
    const installFragment = forceBridgeFragment
      || artifactExecutor !== 'artifact-shader@1';

    const settingsUserData = (settingsMat as {
      userData?: {
        artifactBlendState?: VfxPipelineBlendState;
        artifactUniformValues?: VfxPipelineUniformValues;
        artifactTileCounts?: [number, number];
        artifactPipeline?: { tileCounts?: [number, number] };
        artifactCapturedUniforms?: unknown;
      };
    }).userData;
    const matUserData = mat.userData as {
      artifactBlendState?: VfxPipelineBlendState;
      artifactUniformValues?: VfxPipelineUniformValues;
      artifactTileCounts?: [number, number];
      artifactPipeline?: { tileCounts?: [number, number] };
      artifactCapturedUniforms?: unknown;
    };
    const captureOwned = (
      settingsUserData as { artifactPipeline?: { qualification?: { evidence?: { captureProvenance?: string } } } }
    )?.artifactPipeline?.qualification?.evidence?.captureProvenance === 'live-bridge-capture@1'
      || !!settingsUserData?.artifactCapturedUniforms
      || (
        matUserData as { artifactPipeline?: { qualification?: { evidence?: { captureProvenance?: string } } } }
      )?.artifactPipeline?.qualification?.evidence?.captureProvenance === 'live-bridge-capture@1'
      || !!matUserData.artifactCapturedUniforms;

    // Emit-based artifact fragments are map-free; live-bridge captures may still
    // sample CFXR aux / scene maps and need the same loads as bridge-full.
    const maps = (installFragment || captureOwned)
      ? await loadCfxrInjectMaps(profile)
      : {
          dissolve: null,
          mask: null,
          distortion: null,
          height: null,
          orbAlpha: null,
          orbNoise: null,
        };
    injectCfxrShader(mat, profile, maps, {
      policy,
      installFragment,
      declaredVertexPatches,
      declaredBlendState: settingsUserData?.artifactBlendState ?? matUserData.artifactBlendState,
      declaredUniformValues: settingsUserData?.artifactUniformValues ?? matUserData.artifactUniformValues,
      // Prefer material/pipeline stamps, then bag, then beforeBatch profile stamp.
      declaredTileCounts: settingsUserData?.artifactTileCounts
        ?? settingsUserData?.artifactPipeline?.tileCounts
        ?? matUserData.artifactTileCounts
        ?? matUserData.artifactPipeline?.tileCounts
        ?? bagTileCounts
        ?? profile.tileCounts,
      captureOwned,
    });
  }
}
