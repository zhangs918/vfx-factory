import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const assets = path.join(root, 'public/assets/quarks');
const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.candidates.json'), 'utf8'));
const limit = Math.max(1, Number(process.env.VFX_LIMIT ?? 3));
const entries = (manifest.effects ?? [])
  .filter((entry) => String(entry.note ?? '').startsWith('Assets/'))
  .slice(0, limit);
const required = ['shaderFamily', 'unityMode', 'srcBlend', 'dstBlend', 'zWrite', 'cutoff'];
const modes = new Set(['opaque', 'alpha-test', 'alpha', 'premultiplied-alpha', 'additive', 'multiply']);
const failures = [];
for (const entry of entries) {
  const file = path.join(assets, entry.file);
  if (!fs.existsSync(file)) { failures.push(`${entry.id}: missing artifact`); continue; }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const material of json.materials ?? []) {
    if (String(material.name ?? '').startsWith('Missing material')) continue;
    const program = material.vfxProgram;
    if (!program || program.schema !== 'particle-material-program@2') {
      failures.push(`${entry.id}/${material.name}: missing material IR`); continue;
    }
    for (const key of required)
      if (!(key in program)) failures.push(`${entry.id}/${material.name}: missing ${key}`);
    if (!modes.has(program.blend)) failures.push(`${entry.id}/${material.name}: invalid blend ${program.blend}`);
    if (program.profile?.blendMode !== program.blend)
      failures.push(`${entry.id}/${material.name}: profile blend disagrees with program blend`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated explicit material IR for ${entries.length} candidate effect(s).`);
}
