import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const assetRoot = path.join(root, 'public/assets/quarks');
const manifest = JSON.parse(fs.readFileSync(path.join(assetRoot, 'manifest.candidates.json'), 'utf8'));
const registry = JSON.parse(fs.readFileSync(path.join(root, 'config/semantic-adapters.json'), 'utf8'));
const adapters = new Set(registry.adapters.map((entry) => `${entry.id}@${entry.version}:${entry.kind}`));
const failures = [];

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of value.children ?? []) walk(child, visit);
}

const candidates = (manifest.effects ?? []).filter((entry) => String(entry.note ?? '').startsWith('Cartoon FX/'));
for (const entry of candidates) {
  const file = path.join(assetRoot, entry.file);
  if (!fs.existsSync(file)) { failures.push(`${entry.id}: missing ${entry.file}`); continue; }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ir = json.vfxIR;
  if (ir?.schema !== 'unity-vfx-ir@1' || ir.runtime !== 'three-quarks-semantic@1'
      || ir.policy !== 'strict' || ir.representation !== 'live-particles@1') {
    failures.push(`${entry.id}: invalid strict live IR envelope`);
    continue;
  }
  for (const diagnostic of ir.diagnostics ?? [])
    if (diagnostic.severity === 'error') failures.push(`${entry.id}: ${diagnostic.code} at ${diagnostic.path}`);
  const terminal = Number(ir.lifecycle?.terminalTime);
  if (ir.lifecycle?.schema !== 'effect-lifecycle@1' || ir.lifecycle.rootLoopPolicy !== 'one-shot'
      || !(terminal > 0) || terminal > Math.max(...(ir.captureTimes ?? []), 0) + 1e-6) {
    failures.push(`${entry.id}: invalid finite effect lifecycle`);
  }
  for (const required of ir.qualification?.simulationAdapters ?? []) {
    const key = `${required.id}@${required.version}:${required.kind}`;
    if (!adapters.has(key)) failures.push(`${entry.id}: unregistered adapter ${key}`);
  }
  walk(json.object, (object) => {
    if (object.type !== 'ParticleEmitter') return;
    const ps = object.ps ?? {};
    if (ps.unityRendererUvFlip) {
      const flip = ps.unityRendererUvFlip;
      if (flip.schema !== 'unity-renderer-uv-flip@1'
          || flip.source !== 'renderer-baked-per-particle'
          || !Array.isArray(flip.probability) || flip.probability.length !== 2) {
        failures.push(`${entry.id}/${object.name}: invalid renderer UV flip IR`);
      }
      for (const state of ps.unityInitialState ?? []) {
        if (!Array.isArray(state.rendererFlip) || state.rendererFlip.length !== 2
            || state.rendererFlip.some((value) => typeof value !== 'boolean')) {
          failures.push(`${entry.id}/${object.name}: missing exact per-particle renderer flip`);
          break;
        }
      }
    }
    if (ps.unitySubEmitterLifecycle) {
      const lifecycle = ps.unitySubEmitterLifecycle;
      if (lifecycle.schema !== 'unity-sub-emitter-lifecycle@1'
          || lifecycle.ownership !== 'parent-event' || lifecycle.looping !== true
          || lifecycle.termination !== 'child-duration' || ps.onlyUsedByOther !== true
          || ps.unitySpawnSchedule || ps.unityInitialState || ps.unityTrajectoryCache) {
        failures.push(`${entry.id}/${object.name}: invalid live sub-emitter lifecycle`);
      }
    }
    for (const behavior of ps.behaviors ?? []) {
      if (behavior.type !== 'EmitSubParticleSystem') continue;
      const inheritance = behavior.unityInheritance;
      if (inheritance?.schema !== 'unity-sub-emitter-inheritance@1'
          || typeof inheritance.size !== 'boolean' || typeof inheritance.color !== 'boolean'
          || inheritance.rotation !== false || inheritance.lifetime !== false) {
        failures.push(`${entry.id}/${object.name}: unsupported sub-emitter inheritance`);
      }
    }
    if ((ps.unitySpawnSchedule?.bursts ?? []).some((burst) =>
      !(Number(burst.time) >= 0) || Number(burst.time) > terminal + 1e-5)) {
      failures.push(`${entry.id}/${object.name}: spawn outside finite root clock`);
    }
    const cache = ps.unityTrajectoryCache;
    if (cache?.schema === 'particle-trajectory-cache@6') {
      const tileCount = Math.max(1, Number(ps.uTileCount ?? 1) * Number(ps.vTileCount ?? 1));
      for (const track of cache.tracks ?? []) {
        let priorAge = -Infinity;
        for (const sample of track.samples ?? []) {
          if (!(Number(sample.age) >= priorAge))
            failures.push(`${entry.id}/${object.name}: non-monotonic trajectory sample age`);
          priorAge = Number(sample.age);
          if (tileCount > 1 && (!Number.isInteger(sample.frame)
              || sample.frame < 0 || sample.frame >= tileCount))
            failures.push(`${entry.id}/${object.name}: cached flipbook sample lacks exact frame`);
        }
      }
    }
  });
  for (const material of json.materials ?? [])
    if (material.vfxProgram?.schema !== 'particle-material-program@2')
      failures.push(`${entry.id}/${material.name}: missing explicit material program`);

  const oracleFile = path.join(assetRoot, 'oracles', path.basename(entry.file));
  if (!fs.existsSync(oracleFile)) { failures.push(`${entry.id}: missing camera oracle`); continue; }
  const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  if (oracle.vfxIR?.representation !== 'camera-baked@1') failures.push(`${entry.id}: invalid oracle representation`);
  const layerIds = (oracle.baked?.buffers?.layers ?? []).map((layer) => layer.id);
  if (layerIds.some((id) => !Number.isInteger(id)) || new Set(layerIds).size !== layerIds.length)
    failures.push(`${entry.id}: oracle layers lack unique stable ids`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${candidates.length} strict candidate IR/oracle contract(s).`);
}
