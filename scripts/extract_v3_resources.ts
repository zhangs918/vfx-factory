import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const artifactDir = process.env.VFX_V3_ARTIFACT_DIR
  ? path.resolve(root, process.env.VFX_V3_ARTIFACT_DIR)
  : path.join(root, 'public/assets/v3-artifacts');
const resourceDir = process.env.VFX_V3_RESOURCE_DIR
  ? path.resolve(root, process.env.VFX_V3_RESOURCE_DIR)
  : path.join(root, 'public/assets/v3-resources');
const codeDir = process.env.VFX_V3_CODE_DIR
  ? path.resolve(root, process.env.VFX_V3_CODE_DIR)
  : path.join(root, 'public/assets/v3-code');
const requested = new Set(
  process.argv.slice(2)
    .filter((arg) => !arg.startsWith('-'))
    .map((id) => String(id).toLowerCase()),
);
const manifest = JSON.parse(await readFile(path.join(artifactDir, 'manifest.json'), 'utf8'));
await mkdir(resourceDir, { recursive: true });
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function writeResourceBytes(filePath: string, bytes: Buffer | string, digest: string) {
  try {
    if (sha(await readFile(filePath)) === digest) return;
  } catch {
    // Missing resources are created below.
  }
  await writeFile(filePath, bytes);
}

async function externalizeJsonResource(artifact: any, value: unknown, kind: string, prefix: string) {
  const canonical = JSON.stringify(value);
  const digest = sha(canonical);
  const id = `${prefix}-${digest.slice(0, 20)}`;
  const uri = `/assets/v3-resources/${id}.json`;
  await writeResourceBytes(path.join(resourceDir, `${id}.json`), canonical, digest);
  artifact.resources[id] = {
    id, kind, uri, sha256: digest,
    bytes: Buffer.byteLength(canonical), mime: 'application/json',
  };
  return id;
}

async function externalizeCompiledTables(artifact: any, node: any) {
  if (!node || typeof node !== 'object') return;
  const ps = node.ps;
  if (ps && typeof ps === 'object') {
    if (ps.unityInitialState && !ps.unityInitialStateResourceId) {
      ps.unityInitialStateResourceId = await externalizeJsonResource(
        artifact, ps.unityInitialState, 'binary', 'particle-initial-state',
      );
      delete ps.unityInitialState;
    }
    if (ps.unityTrajectoryCache && !ps.unityTrajectoryCacheResourceId) {
      ps.unityTrajectoryCacheResourceId = await externalizeJsonResource(
        artifact, ps.unityTrajectoryCache, 'binary', 'particle-trajectory',
      );
      delete ps.unityTrajectoryCache;
    }
  }
  for (const child of node.children ?? []) await externalizeCompiledTables(artifact, child);
}

async function externalizeRuntimeTables(artifact: any) {
  const cfxr = artifact.runtimeState?.cfxrState;
  if (!cfxr || typeof cfxr !== 'object') return;
  for (const key of Object.keys(cfxr)) {
    if (!Array.isArray(cfxr[key]) || cfxr[key].length === 0 || cfxr[`${key}ResourceId`]) continue;
    if (Buffer.byteLength(JSON.stringify(cfxr[key])) < 64 * 1024) continue;
    const name = key.replace(/ByEmitter$/, '').replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`);
    cfxr[`${key}ResourceId`] = await externalizeJsonResource(
      artifact, cfxr[key], 'binary', `compiled-${name}`,
    );
    delete cfxr[key];
  }
}

async function externalizeArtifact(artifact: any) {
  const simulation = artifact.simulation;
  if (!simulation) return false;
  artifact.resources ??= {};
  await externalizeCompiledTables(artifact, simulation.object);
  await externalizeRuntimeTables(artifact);
  for (const image of simulation.images ?? []) {
    const url = String(image.url ?? '');
    if (!url.startsWith('data:')) continue;
    const match = url.match(/^data:([^;,]+)(?:;[^,]+)*;base64,(.*)$/s);
    if (!match) throw new Error(`${artifact.effectId}: unsupported embedded image data URI`);
    const mime = match[1];
    const bytes = Buffer.from(match[2], 'base64');
    const id = `tex-${sha(url).slice(0, 20)}`;
    const contentDigest = sha(bytes);
    const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
    const uri = `/assets/v3-resources/${id}.${ext}`;
    await writeResourceBytes(path.join(resourceDir, `${id}.${ext}`), bytes, contentDigest);
    image.url = uri;
    artifact.resources[id] = {
      id, kind: 'texture', uri, sha256: contentDigest, bytes: bytes.length, mime,
    };
  }
  for (const geometry of simulation.geometries ?? []) {
    if (!geometry.data && geometry.resourceId) continue;
    if (!geometry.data) throw new Error(`${artifact.effectId}: geometry lacks data and resourceId`);
    const canonical = JSON.stringify(geometry.data);
    const digest = sha(canonical);
    const id = `geo-${digest.slice(0, 20)}`;
    const uri = `/assets/v3-resources/${id}.json`;
    await writeResourceBytes(path.join(resourceDir, `${id}.json`), canonical, digest);
    artifact.resources[id] = {
      id, kind: 'geometry', uri, sha256: digest,
      bytes: Buffer.byteLength(canonical), mime: 'application/json',
    };
    delete geometry.data;
    geometry.resourceId = id;
  }
  return true;
}

function collectResourceBindings(value: any, ids: Set<string>, uriToId: Map<string, string>) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'resources') continue;
    if ((key === 'resourceId' || key.endsWith('ResourceId')) && typeof child === 'string') ids.add(child);
    if (key === 'textures' && child && typeof child === 'object') {
      for (const id of Object.values(child)) if (typeof id === 'string') ids.add(id);
    }
    if ((key === 'url' || key === 'uri') && typeof child === 'string') {
      const id = uriToId.get(child);
      if (id) ids.add(id);
    }
    if (child && typeof child === 'object') collectResourceBindings(child, ids, uriToId);
  }
}

async function loadExternalConfig(artifact: any) {
  const uri = artifact.files?.config?.uri;
  if (typeof uri !== 'string' || !uri.startsWith('/assets/v3-code/')) return undefined;
  const relative = uri.slice('/assets/v3-code/'.length);
  try {
    return JSON.parse(await readFile(path.join(codeDir, relative), 'utf8'));
  } catch {
    return undefined;
  }
}

let extractedEffects = 0;
for (const entry of manifest.effects) {
  if (requested.size && !requested.has(String(entry.id).toLowerCase())) continue;
  const file = path.join(artifactDir, entry.file);
  const artifact = JSON.parse(await readFile(file, 'utf8'));
  if (await externalizeArtifact(artifact)) extractedEffects++;
  await writeFile(file, JSON.stringify(artifact));
}

// Rebuild the resource manifest from the complete artifact reference closure.
// This deliberately prunes stale entries after targeted compilation as well.
const index = new Map<string, any>();
for (const entry of manifest.effects) {
  const file = path.join(artifactDir, entry.file);
  const artifact = JSON.parse(await readFile(file, 'utf8'));
  const resources = artifact.resources ?? {};
  const uriToId = new Map(Object.values(resources).map((resource: any) => [resource.uri, resource.id]));
  const referenced = new Set<string>();
  collectResourceBindings(artifact, referenced, uriToId);
  collectResourceBindings(await loadExternalConfig(artifact), referenced, uriToId);
  for (const id of referenced) {
    const resource = resources[id];
    if (!resource) throw new Error(`${entry.id}: binding references missing resource '${id}'`);
    const prior = index.get(id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(resource)) {
      throw new Error(`${entry.id}: resource '${id}' conflicts with another artifact`);
    }
    index.set(id, resource);
  }
  artifact.resources = Object.fromEntries([...referenced].sort().map((id) => [id, resources[id]]));
  await writeFile(file, JSON.stringify(artifact));
}

await writeFile(
  path.join(artifactDir, 'resources.manifest.json'),
  `${JSON.stringify({
    schema: 'vfx-resource-manifest@3',
    resources: [...index.values()].sort((left, right) => left.id.localeCompare(right.id)),
  }, null, 2)}\n`,
);
console.log(
  `extracted ${index.size} reachable v3 resources from ${extractedEffects} effects`
  + `${requested.size ? ' (targeted; global closure rebuilt)' : ''}`,
);
