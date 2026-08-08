/**
 * Dual-path vertex patch authority: assert bridge≡artifact when both exist,
 * then apply the chosen source. Callers pass preferArtifact (?vertexSource).
 */
import { applyCfxrVertexPatches, vertexPatchesFromProfile } from './cfxr-vertex-patches';
import { assertSameStringSet } from './artifact-emitter-sim';
import type { CfxrRuntimeProfile } from './cfxr-material-profile';

export function applyCfxrDualPathVertexPatches(
  stockVertex: string,
  profile: CfxrRuntimeProfile,
  declaredPatches: string[] | undefined,
  preferArtifact: boolean,
  options?: { skipDivergenceAssert?: boolean },
): { vertexShader: string; usedArtifactPatches: boolean } {
  const bridgePatches = vertexPatchesFromProfile(profile);
  if (declaredPatches) {
    const viaBridge = applyCfxrVertexPatches(stockVertex, bridgePatches);
    const viaArtifact = applyCfxrVertexPatches(stockVertex, declaredPatches);
    assertSameStringSet('vertexPatches', declaredPatches, viaArtifact.applied);
    assertSameStringSet('vertexPatches.bridge', bridgePatches, viaBridge.applied);
    // Live-bridge captures already match thick; bag patches may intentionally
    // differ from profile-derived bridge (e.g. stretch) without being a regress.
    if (viaBridge.vertexShader !== viaArtifact.vertexShader
      && !options?.skipDivergenceAssert) {
      throw new Error('vertex patch dual-path divergence: bridge and artifact transforms differ');
    }
  }
  // Full inject (bridge fragment) may lack bag patches — fall back to profile bridge
  // without claiming artifact authority (callers should pass preferArtifact=false then).
  // Slim inject hard-requires declared patches before calling this helper.
  const chosen = preferArtifact && declaredPatches ? declaredPatches : bridgePatches;
  const patched = applyCfxrVertexPatches(stockVertex, chosen);
  return {
    vertexShader: patched.vertexShader,
    usedArtifactPatches: !!(preferArtifact && declaredPatches),
  };
}
