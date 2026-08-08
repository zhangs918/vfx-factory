/**
 * Offline Unity startDelay extraction + calibrated spawn-schedule lowering.
 * Mutates emitter JSON in place (same contract as historical CFXR inject).
 * Leaf module: no ubershader / runtime-state dependency.
 */

/** Extract startDelay map and apply calibrated spawn-schedule lowering onto `ps`. */
export function extractStartDelays(json: any): Map<string, number> {
  const map = new Map<string, number>();
  const globallyScheduled = new Set<string>();
  const collectSchedules = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.uuid
        && o.ps?.unitySpawnSchedule?.schema === 'calibrated-spawn-schedule@1') {
      globallyScheduled.add(o.uuid);
    }
    if (Array.isArray(o.children)) o.children.forEach(collectSchedules);
    if (o.object) collectSchedules(o.object);
  };
  collectSchedules(json);
  const terminal = json?.vfxIR?.lifecycle?.terminalTime;
  let oneShotDuration = 0;
  if (globallyScheduled.size > 0) {
    if (!(typeof terminal === 'number' && terminal > 0)) {
      throw new Error(
        'extractStartDelays: calibrated spawn schedules require positive vfxIR.lifecycle.terminalTime (no invent)',
      );
    }
    oneShotDuration = terminal;
  }
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.ps && o.uuid) {
      if (o.ps.unitySpawnSchedule?.schema === 'calibrated-spawn-schedule@1') {
        o.ps.emissionOverTime = { type: 'ConstantValue', value: 0 };
        o.ps.emissionOverDistance = { type: 'ConstantValue', value: 0 };
        o.ps.emissionBursts = o.ps.unitySpawnSchedule.bursts;
        // This emitter is now driven by the root clock, including when it originated as a
        // Unity sub-emitter. It must participate in the normal system update loop.
        o.ps.onlyUsedByOther = false;
        // The root-clock schedule contains every native-RNG birth inside one finite effect
        // instance. Local emitter loops would wrap before later schedule entries and repeat the
        // first cycle, so all globally scheduled systems become one-shot on the root horizon.
        o.ps.looping = false;
        const duration = Number(o.ps.duration);
        if (!Number.isFinite(duration)) {
          throw new Error(
            `extractStartDelays: emitter '${o.uuid}' missing numeric duration (no invent)`,
          );
        }
        o.ps.duration = Math.max(duration, oneShotDuration);
      }
      if (Array.isArray(o.ps.behaviors)) {
        // Remove only event edges whose target was strictly compiled to a global schedule.
        // Keeping the edge as well would double-emit; removing unrelated/local-space edges
        // would lose semantics, so this is deliberately target-specific.
        o.ps.behaviors = o.ps.behaviors.filter((behavior: any) =>
          behavior?.type !== 'EmitSubParticleSystem'
          || !globallyScheduled.has(String(behavior.subParticleSystem ?? '')));
      }
      const d = o.ps.startDelay;
      let v: number;
      if (typeof d === 'number') {
        v = d;
      } else if (d && typeof d.value === 'number') {
        v = d.value;
      } else {
        throw new Error(
          `extractStartDelays: emitter '${o.uuid}' missing numeric startDelay (no invent)`,
        );
      }
      // Always record — including 0 — so runtime delay gates never invent missing uuids.
      map.set(o.uuid, v);
    }
    if (Array.isArray(o.children)) o.children.forEach(walk);
    if (o.object) walk(o.object);
  };
  walk(json);
  return map;
}
