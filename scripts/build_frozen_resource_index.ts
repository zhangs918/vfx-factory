import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dir = path.join(root, 'public/assets/frozen-quarks');
const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { effects: any[] };
const resources = new Map<string, any>();
const effects: any[] = [];

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
for (const entry of manifest.effects.filter((item) => item.status === 'compiled')) {
  const file = path.join(dir, entry.file);
  const artifact = JSON.parse(await readFile(file, 'utf8'));
  const payload = artifact.webRuntime.payload;
  const refs: Record<string, string> = {};
  for (const image of payload.images ?? []) {
    const content = String(image.url ?? '');
    const sha256 = hash(content);
    const id = `tex-${sha256.slice(0, 20)}`;
    refs[image.uuid] = id;
    if (!resources.has(id)) resources.set(id, {
      id, kind: 'texture', sha256, sourceUuid: image.uuid,
      bytes: content.length, embedded: content.startsWith('data:'),
    });
  }
  for (const geometry of payload.geometries ?? []) {
    const content = JSON.stringify(geometry.data ?? geometry);
    const sha256 = hash(content);
    const id = `geo-${sha256.slice(0, 20)}`;
    refs[geometry.uuid] = id;
    if (!resources.has(id)) resources.set(id, {
      id, kind: 'geometry', sha256, sourceUuid: geometry.uuid,
      bytes: content.length,
    });
  }
  effects.push({ id: entry.id, file: entry.file, resources: refs });
}

await writeFile(path.join(dir, 'resources.manifest.json'), JSON.stringify({
  schema: 'vfx-resource-index@1', resources: [...resources.values()], effects,
}, null, 2));
console.log(`indexed ${effects.length} effects, ${resources.size} unique resources`);
