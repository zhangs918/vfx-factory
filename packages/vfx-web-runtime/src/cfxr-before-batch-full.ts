/**
 * Production beforeBatch: shared simulation mounts + full CFXR material pending
 * (inject profile, procedural ring, map colorspace from program).
 * Thin player must not import this module.
 */
import {
  NoColorSpace,
  SRGBColorSpace,
  type Object3D,
} from 'three';
import { RenderMode } from 'three.quarks';
import {
  applyBakedBlendState,
  assertSameBlendState,
  blendStateFromProfile,
  type VfxPipelineBlendState,
} from './cfxr-blend-state';
import {
  applySemanticBlendState,
  getSoftRingTexture,
  propsToProfile,
  type CfxrRuntimeProfile,
} from './cfxr-material-profile';
import { resolveMountPolicy } from './cfxr-mount-policy';
import { UnityColor32Behavior } from './cfxr-simulation-behaviors';
import {
  forEachCfxrEmitterMount,
} from './cfxr-simulation-mounts';
import { readArtifactEmitterSim } from './artifact-emitter-sim';

export function patchCfxrBeforeBatch(root: Object3D) {
  const preferArtifactBlend = resolveMountPolicy().blend === 'artifact';
  forEachCfxrEmitterMount(root, ({
    emitter,
    system,
    mat,
    take,
    tileCount,
    props,
    finishMountAudit,
  }) => {
    if (!props) {
      mat.needsUpdate = true;
      finishMountAudit();
      return;
    }

    // Older frozen exports can carry an otherwise complete HDR profile while
    // leaving depth/cutoff only on the serialized Three material. Those values
    // are authored state (and normalizeUnityQuarksJson validates depthWrite),
    // so merge them into the profile before applying the strict pending ABI.
    // The v3 compiler performs the same normalization offline.
    const profile = propsToProfile({
      ...props,
      zWrite: typeof props.zWrite === 'boolean' ? props.zWrite : mat.depthWrite,
      cutoff: typeof props.cutoff === 'number' ? props.cutoff : mat.alphaTest,
    });

    if (profile.proceduralRing && !mat.map) {
      if (typeof profile.ringTopOffset !== 'number') {
        throw new Error(
          `proceduralRing missing ringTopOffset for emitter '${emitter.uuid}' (no invent)`,
        );
      }
      mat.map = getSoftRingTexture(profile.ringTopOffset);
      system.rendererSettings.renderMode = RenderMode.HorizontalBillBoard;
    }

    if (mat.map) {
      take('map-colorspace@1', () => {
        // Prefer offline bag — do not invent via propsToProfile mainMapSrgb ?? true.
        const bagSrgb = readArtifactEmitterSim(system)?.mainMapSrgb;
        if (typeof bagSrgb !== 'boolean') {
          throw new Error(
            `map-colorspace@1 missing offline mainMapSrgb for emitter '${emitter.uuid}'`,
          );
        }
        mat.map!.colorSpace = bagSrgb ? SRGBColorSpace : NoColorSpace;
        mat.map!.needsUpdate = true;
      });
    }

    const meshParticles = system.renderMode === RenderMode.Mesh;
    const hasSheetAnim =
      tileCount > 1 || system.behaviors.some((b) => b.type === 'FrameOverLife');
    const dissolveViaUvTile = meshParticles
      && (profile.dissolve || profile.dynamicAlphaClip) && !hasSheetAnim;

    const bagTiles = readArtifactEmitterSim(system)?.tileCounts;
    const pipelineTiles = (mat.userData as { artifactTileCounts?: [number, number] })
      .artifactTileCounts;
    const offlineTiles = pipelineTiles ?? bagTiles;
    if (!offlineTiles) {
      throw new Error(
        `beforeBatch: emitter '${emitter.uuid}' missing offline tileCounts (pipeline/bag)`,
      );
    }
    const profileForBatch: CfxrRuntimeProfile = {
      ...profile,
      dissolveViaUvTile,
      tileCounts: offlineTiles,
      unityCenteredStretch: system.renderMode === RenderMode.StretchedBillBoard,
      unityVerticalBillboard: system.renderMode === RenderMode.VerticalBillBoard,
    };

    take('semantic-blend@1', () => {
      const declaredBlend = (mat.userData as { artifactBlendState?: VfxPipelineBlendState })
        .artifactBlendState;
      const bridgeBlend = blendStateFromProfile(profileForBatch);
      const captureOwned = (
        mat.userData as { artifactCaptureOwned?: boolean }
      ).artifactCaptureOwned === true
        || (mat.userData as { artifactShaderProvenance?: { kind?: string } })
          .artifactShaderProvenance?.kind === 'live-bridge-capture@1';
      // Live-bridge capture / clone stamps the shared Quarks batch blend. Sibling
      // emitters in that batch can still propsToProfile to a different path; the
      // captured batch material is authoritative — do not fail the dual-path gate.
      if (declaredBlend && !captureOwned) {
        assertSameBlendState(`semantic-blend[${emitter.uuid}]`, declaredBlend, bridgeBlend);
      }
      const artifactShader = (mat.userData as { artifactExecutor?: string })
        .artifactExecutor === 'artifact-shader@1';
      if (preferArtifactBlend && declaredBlend) {
        applyBakedBlendState(mat, declaredBlend);
      } else if (preferArtifactBlend && artifactShader) {
        throw new Error(
          `semantic-blend: blendSource=artifact requires declaredBlendState for `
          + `artifact-shader emitter '${emitter.uuid}'`,
        );
      } else {
        applySemanticBlendState(mat, profileForBatch);
      }
      (mat.userData as { cfxr?: CfxrRuntimeProfile }).cfxr = profileForBatch;
      // System-local stamp so after-batch survives settings.material userData clones.
      (system as unknown as { __cfxrProfile?: CfxrRuntimeProfile }).__cfxrProfile = profileForBatch;
    });

    take('color32-stream@1', () => {
      if (!system.behaviors.some((behavior) => behavior.type === 'UnityColor32')) {
        system.behaviors.push(new UnityColor32Behavior());
      }
    });

    mat.needsUpdate = true;
    finishMountAudit();
  }, { preferArtifactBlend });
}
