/**
 * Expand zero-width Unity CFXR ring ribbons into an annulus (geometry-level).
 * Leaf module: no inject / runtime-state / ubershader dependency.
 */

/** Host-calibrated annulus width for CFXR procedural ring geometry expansion. */
export const CFXR_RING_ANNULUS_WIDTH = 0.42;
/** Accept only near-unit-radius Unity ring meshes for annulus expansion. */
export const CFXR_RING_RADIUS_AVG_MIN = 0.85;
export const CFXR_RING_RADIUS_AVG_MAX = 1.15;
/** Geometric singularity guard when a ring vertex lands on the origin. */
export const CFXR_RING_ORIGIN_LENGTH_GUARD = 1;

/** Expand zero-width Unity CFXR ring ribbons into an annulus (geometry-level, any effect). */
export function expandCfxrRingGeometry(json: any) {
  if (!Array.isArray(json.geometries)) return;
  for (const g of json.geometries) {
    const positions: number[] = g.positions ?? g.data?.attributes?.position?.array;
    const uvs: number[] = g.uvs ?? g.data?.attributes?.uv?.array;
    if (!positions || !uvs || positions.length < 9) continue;
    if (uvs.length < (positions.length / 3) * 2) {
      throw new Error('expandCfxrRingGeometry: uv attribute incomplete (no invent)');
    }
    let rSum = 0;
    let n = 0;
    for (let i = 0; i < positions.length; i += 3) {
      rSum += Math.hypot(positions[i], positions[i + 1]);
      n++;
    }
    const rAvg = rSum / n;
    if (rAvg < CFXR_RING_RADIUS_AVG_MIN || rAvg > CFXR_RING_RADIUS_AVG_MAX) continue;
    for (let vi = 0; vi < n; vi++) {
      const px = positions[vi * 3];
      const py = positions[vi * 3 + 1];
      // Geometric singularity guard for a degenerate vertex at the origin.
      const len = Math.hypot(px, py) || CFXR_RING_ORIGIN_LENGTH_GUARD;
      const v = uvs[vi * 2 + 1];
      if (typeof v !== 'number') {
        throw new Error('expandCfxrRingGeometry: uv.v required (no invent)');
      }
      const r = 1 - v * CFXR_RING_ANNULUS_WIDTH;
      positions[vi * 3] = (px / len) * r;
      positions[vi * 3 + 1] = (py / len) * r;
    }
  }
}
