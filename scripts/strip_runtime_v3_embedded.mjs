import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const requested = new Set(
  process.argv.slice(2)
    .filter((arg) => !arg.startsWith('-'))
    .map((id) => String(id).toLowerCase()),
);
const artifactDir = process.env.VFX_V3_ARTIFACT_DIR
  ? path.resolve(process.env.VFX_V3_ARTIFACT_DIR)
  : path.resolve('public/assets/v3-artifacts');
const manifestPath = path.join(artifactDir, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
let stripped = 0;
for (const entry of manifest.effects) {
  if (requested.size && !requested.has(String(entry.id).toLowerCase())) continue;
  const file = path.join(artifactDir, entry.file);
  const artifact = JSON.parse(await readFile(file, 'utf8'));
  if (!artifact.files?.config || !artifact.files?.shaders) continue;
  delete artifact.simulation;
  delete artifact.shaders;
  delete artifact.runtimeState;
  const bytes = JSON.stringify(artifact);
  await writeFile(file, bytes);
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  stripped++;
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`stripped embedded v3 fields and stamped artifact hashes for ${stripped} artifacts`);
