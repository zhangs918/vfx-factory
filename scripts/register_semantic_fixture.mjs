import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(root, 'public/assets/quarks/manifest.json');
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : { effects: [] };
manifest.effects = manifest.effects.filter((effect) => {
  if (effect.id === 'semantic_fixture') return false;
  const artifact = path.join(root, 'public/assets/quarks', effect.file);
  if (!fs.existsSync(artifact)) return false;
  try {
    const json = JSON.parse(fs.readFileSync(artifact, 'utf8'));
    return json.vfxIR?.schema === 'unity-vfx-ir@1' && json.vfxIR?.policy === 'strict';
  } catch {
    return false;
  }
});
manifest.effects.unshift({
  id: 'semantic_fixture',
  label: 'Semantic IR · Conformance Fixture',
  file: 'Semantic Fixture.json',
  note: 'strict conformance fixture',
});
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
