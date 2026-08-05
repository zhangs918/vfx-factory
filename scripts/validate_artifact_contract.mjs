import fs from 'node:fs';
import path from 'node:path';
import { isParticleMaterialProgram, isStrictArtifact } from '../packages/vfx-artifact-schema/index.mjs';

const root = path.resolve(import.meta.dirname, '..');
const assetRoot = path.join(root, 'public/assets/quarks');
const manifest = JSON.parse(fs.readFileSync(path.join(assetRoot, 'manifest.json'), 'utf8'));
const failures = [];

for (const entry of manifest.effects ?? []) {
  const file = path.join(assetRoot, entry.file);
  if (!fs.existsSync(file)) { failures.push(`${entry.id}: missing ${entry.file}`); continue; }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ir = json.vfxIR;
  if (!isStrictArtifact(json))
    failures.push(`${entry.id}: missing strict unity-vfx-ir@1`);
  if (ir?.representation !== 'live-particles@1' && ir?.representation !== 'hybrid-live@1')
    failures.push(`${entry.id}: unsupported production representation ${ir?.representation ?? '(none)'}`);
  const lifecycle = ir?.lifecycle;
  if (lifecycle?.schema !== 'effect-lifecycle@1'
      || lifecycle.rootLoopPolicy !== 'one-shot'
      || lifecycle.terminalAction !== 'stop-and-clear'
      || !(Number(lifecycle.terminalTime) > 0))
    failures.push(`${entry.id}: invalid lifecycle contract`);
  if ((ir?.diagnostics ?? []).some((d) => d.severity === 'error'))
    failures.push(`${entry.id}: error diagnostics remain in production artifact`);
  for (const material of json.materials ?? []) {
    if ('cfxr' in material) failures.push(`${entry.id}/${material.name}: legacy cfxr block`);
    if (!isParticleMaterialProgram(material.vfxProgram))
      failures.push(`${entry.id}/${material.name}: missing particle material IR`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${manifest.effects?.length ?? 0} production artifact contract(s).`);
}
