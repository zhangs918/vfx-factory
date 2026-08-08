/**
 * Pure Quarks-stock vertex patch applicator. Shared by the CFXR inject path and
 * the offline-declared vertexPatches dual-path so both authorities run the
 * exact same string transforms.
 */

export const CFXR_VERTEX_PATCH_STRETCH = 'unity-centered-stretch@1';
export const CFXR_VERTEX_PATCH_VERTICAL = 'unity-vertical-billboard@1';
export const CFXR_VERTEX_PATCH_CUSTOM_ATTRS = 'cfxr-custom-attrs@1';

const QUARKS_STRETCH_NEEDLE = `mvPosition.xyz += position.y * normalize(cross(mvPosition.xyz, viewVelocity)) * avgSize; // switch the cross to  match unity implementation
    mvPosition.xyz -= (position.x + 0.5) * viewVelocity * (1.0 + lengthFactor / vlength) * avgSize; // minus position.x to match unity implementation`;

const UNITY_STRETCH_REPLACEMENT = `vec3 unityWidth = normalize(cross(viewVelocity, mvPosition.xyz));
    // BakeMesh keeps the complete depth component: Unity's long axis is the normalized
    // view-space velocity, not its projection onto the camera plane.
    vec3 unityLength = normalize(viewVelocity);
    // Unity/Quarks stretched billboards use quad X (texture U) as the length axis and
    // quad Y (texture V) as the width axis. The particle position is the tail, so remap
    // the centered PlaneGeometry X range [-.5,.5] to [0,1] along the motion direction.
    // SpriteBatch has already multiplied velocity.xyz by renderer velocityScale before this
    // shader; vlength is therefore the authored velocity contribution exactly once.
    float unityParticleLength = vlength + lengthFactor * avgSize;
    // Unity Stretch rotates the authored billboard basis: renderer pivot.x shifts width,
    // pivot.y shifts length. The API pivot is half the serialized normalized quad offset.
    mvPosition.xyz += (position.y - 2.0 * cfxrRendererPivot.x) * unityWidth
      * avgSize;
    mvPosition.xyz -= ((position.x + 0.5) * unityParticleLength
      - 2.0 * cfxrRendererPivot.y * avgSize) * unityLength;`;

const VERTICAL_ALIGNED_NEEDLE = 'vec2 alignedPosition = position.xy * size.xy;';
const VERTICAL_ALIGNED_REPLACEMENT = 'vec2 alignedPosition = position.xy * size.xy * 0.7071067811865476;';

export function vertexPatchesFromProfile(profile: {
  unityCenteredStretch?: boolean;
  unityVerticalBillboard?: boolean;
}): string[] {
  const patches = [CFXR_VERTEX_PATCH_CUSTOM_ATTRS];
  if (profile.unityCenteredStretch) patches.push(CFXR_VERTEX_PATCH_STRETCH);
  if (profile.unityVerticalBillboard) patches.push(CFXR_VERTEX_PATCH_VERTICAL);
  return patches;
}

/** Apply declared CFXR vertex patches to a Quarks stock vertex program. */
export function applyCfxrVertexPatches(
  vertexShader: string,
  patches: readonly string[],
): { vertexShader: string; applied: string[] } {
  let vs = vertexShader;
  const applied: string[] = [];
  const wanted = new Set(patches);

  if (wanted.has(CFXR_VERTEX_PATCH_STRETCH)) {
    if (vs.includes(UNITY_STRETCH_REPLACEMENT)) {
      // Idempotent: restart/finalize may re-enter an already-lowered program.
      applied.push(CFXR_VERTEX_PATCH_STRETCH);
    } else if (!vs.includes(QUARKS_STRETCH_NEEDLE)) {
      throw new Error(
        'Strict Unity stretched-billboard lowering failed: Quarks vertex template changed',
      );
    } else {
      vs = vs.replace(QUARKS_STRETCH_NEEDLE, UNITY_STRETCH_REPLACEMENT);
      applied.push(CFXR_VERTEX_PATCH_STRETCH);
    }
  }

  if (wanted.has(CFXR_VERTEX_PATCH_VERTICAL)) {
    if (vs.includes(VERTICAL_ALIGNED_REPLACEMENT)) {
      applied.push(CFXR_VERTEX_PATCH_VERTICAL);
    } else if (!vs.includes(VERTICAL_ALIGNED_NEEDLE)) {
      throw new Error('Strict Unity vertical-billboard lowering failed: Quarks vertex template changed');
    } else {
      vs = vs.replace(VERTICAL_ALIGNED_NEEDLE, VERTICAL_ALIGNED_REPLACEMENT);
      applied.push(CFXR_VERTEX_PATCH_VERTICAL);
    }
  }

  if (wanted.has(CFXR_VERTEX_PATCH_CUSTOM_ATTRS)) {
    if (!vs.includes('vCfxrCustom1')) {
      const isTrailVertex = vs.includes('attribute vec3 previous;');
      const worldPositionExpr = !isTrailVertex && vs.includes('vec4 mvPosition')
        ? '(inverse(viewMatrix) * mvPosition).xyz'
        : '(modelMatrix * vec4(position, 1.0)).xyz';
      vs = 'attribute vec4 cfxrCustom1;\nattribute vec4 cfxrCustom2;\nattribute vec2 cfxrUvFlip;\nattribute vec4 cfxrRendererPivot;\nattribute vec2 uv1;\nvarying vec4 vCfxrCustom1;\nvarying vec4 vCfxrCustom2;\nvarying vec2 vCfxrUvFlip;\nvarying vec2 vCfxrUv1;\nvarying vec3 vCfxrWorldPosition;\n' + vs;
      if (vs.includes('#include <tile_vertex>')) {
        vs = vs.replace(
          '#include <tile_vertex>',
          `#include <tile_vertex>\n\tvCfxrCustom1 = cfxrCustom1;\n\tvCfxrCustom2 = cfxrCustom2;\n\tvCfxrUvFlip = cfxrUvFlip;\n\tvCfxrUv1 = uv1;\n\tvCfxrWorldPosition = ${worldPositionExpr};`,
        );
      } else {
        vs = vs.replace(
          /void\s+main\s*\(\s*\)\s*\{/,
          'void main() {\n\tvCfxrCustom1 = cfxrCustom1;\n\tvCfxrCustom2 = cfxrCustom2;\n\tvCfxrUvFlip = cfxrUvFlip;\n\tvCfxrUv1 = uv1;\n\tvCfxrWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;',
        );
      }
    }
    applied.push(CFXR_VERTEX_PATCH_CUSTOM_ATTRS);
  }

  return { vertexShader: vs, applied };
}
