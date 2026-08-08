/**
 * Restore custom1 / dissolve curve tables from Quarks JSON (production inject path).
 * Thin players collect the same curves into emitter bags via custom1CurvesFromPs.
 */
import {
  custom1CurvesByEmitter,
  resetCustom1CurvesTable,
} from './cfxr-runtime-state';
import {
  custom1CurvesFromCfxrCustomData,
  custom1CurvesFromPs,
} from './artifact-emitter-sim';

/** Collect custom data curves keyed by stable emitter UUID from raw JSON. */
export function extractDissolveCurves(json: any): Map<string, any> {
  const map = new Map<string, any>();
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.ps && o.uuid && o.ps.cfxrCustomData) {
      const cd = o.ps.cfxrCustomData;
      // Prefer custom1x; Shader Graph packs often wire dissolve → custom1.y while x stays 0.
      const curve = cd.custom1x ?? cd.custom1y;
      if (curve) map.set(o.uuid, curve);
    }
    if (Array.isArray(o.children)) o.children.forEach(walk);
    if (o.object) walk(o.object);
  };
  walk(json);
  return map;
}

export function setDissolveCurvesFromJson(json: any) {
  resetCustom1CurvesTable();
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.uuid && o.ps) {
      const curves = custom1CurvesFromPs(o.ps) ?? custom1CurvesFromCfxrCustomData(o.ps);
      if (curves) custom1CurvesByEmitter.set(o.uuid, curves);
    }
    if (Array.isArray(o.children)) o.children.forEach(walk);
    if (o.object) walk(o.object);
  };
  walk(json);
}
