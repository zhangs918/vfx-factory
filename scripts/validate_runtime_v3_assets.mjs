import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertVfxRuntimeArtifactV3 } from '@vfx-factory/artifact-schema';

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
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const errors = [];

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    errors.push(`${label}: unreadable JSON (${error.message})`);
    return undefined;
  }
}

function resolveAssetUri(uri, prefix, directory, label) {
  if (typeof uri !== 'string' || !uri.startsWith(prefix)) {
    errors.push(`${label}: invalid URI ${String(uri)}`);
    return undefined;
  }
  const relative = uri.slice(prefix.length);
  const resolved = path.resolve(directory, relative);
  if (resolved !== directory && !resolved.startsWith(`${directory}${path.sep}`)) {
    errors.push(`${label}: URI escapes asset directory`);
    return undefined;
  }
  return resolved;
}

async function verifyFile(ref, prefix, directory, label, requireMain = false) {
  const file = resolveAssetUri(ref?.uri, prefix, directory, label);
  if (!file) return undefined;
  try {
    const bytes = await readFile(file);
    if (digest(bytes) !== ref.sha256) errors.push(`${label}: sha256 mismatch`);
    if (ref.bytes !== undefined && ref.bytes !== bytes.length) errors.push(`${label}: byte length mismatch`);
    if (requireMain && !bytes.toString('utf8').includes('void main')) errors.push(`${label}: missing GLSL main`);
    return bytes;
  } catch {
    errors.push(`${label}: missing file ${file}`);
    return undefined;
  }
}

function scanBindings(value, artifact, referenced, location = '$') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'resources') continue;
    if (typeof child === 'string' && child.startsWith('data:')) {
      errors.push(`${artifact.effectId}: embedded data URI at ${location}.${key}`);
    }
    if ((key === 'resourceId' || key.endsWith('ResourceId')) && child != null) {
      if (typeof child !== 'string' || !artifact.resources[child]) {
        errors.push(`${artifact.effectId}: ${location}.${key} references missing resource ${String(child)}`);
      } else referenced.add(child);
    }
    if (key === 'textures' && child && typeof child === 'object' && !Array.isArray(child)
      && Object.values(child).every((id) => typeof id === 'string')) {
      for (const id of Object.values(child)) {
        if (typeof id !== 'string' || !artifact.resources[id]) {
          errors.push(`${artifact.effectId}: ${location}.textures references missing resource ${String(id)}`);
        } else referenced.add(id);
      }
    }
    if ((key === 'url' || key === 'uri') && typeof child === 'string') {
      const match = Object.values(artifact.resources).find((resource) => resource.uri === child);
      if (match) referenced.add(match.id);
    }
    if (key === 'data' && location.includes('geometr')) {
      errors.push(`${artifact.effectId}: embedded geometry data at ${location}`);
    }
    if (child && typeof child === 'object') scanBindings(child, artifact, referenced, `${location}.${key}`);
  }
}

function computeThinPlayerCapability(artifact) {
  const pipelines = Object.values(artifact.pipelines ?? {});
  const closures = Object.values(artifact.batchClosures ?? {});
  return pipelines.length > 0
    && closures.length > 0
    && artifact.execution?.simulation === 'artifact-emitter-sim@1'
    && artifact.execution?.trajectory === 'artifact-trajectory@1'
    && pipelines.every((pipeline) => {
      const shader = artifact.shaders?.[pipeline.shader]
        ?? artifact.files?.shaders?.[pipeline.shader];
      return pipeline.executor === 'artifact-shader@1'
        && !!pipeline.blendState
        && !!pipeline.uniformValues
        && Array.isArray(pipeline.tileCounts)
        && pipeline.tileCounts.length === 2
        && shader?.execution === 'quarks-fragment-v1'
        && shader.vertexExecution === 'quarks-vertex-v1';
    })
    && closures.every((closure) => ['pixel-qualified', 'manual-qualified']
      .includes(closure.qualification?.status));
}

function auditTrajectoryClosure(effectId, config, artifact) {
  const failures = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ParticleEmitter') {
      const ps = node.ps ?? {};
      const ref = ps.unityTrajectoryCacheResourceId;
      const inline = ps.unityTrajectoryCache;
      const mounts = ps.artifactBehaviorMount?.mounts;
      if (inline != null) failures.push(`${effectId}: embedded trajectory cache remains on ${node.uuid}`);
      if (ref != null) {
        if (!artifact.resources?.[ref]) failures.push(`${effectId}: missing trajectory resource ${ref}`);
        if (!Array.isArray(mounts) || !mounts.includes('trajectory-cache@1')) {
          failures.push(`${effectId}: trajectory emitter ${node.uuid} lacks trajectory-cache@1 mount`);
        }
      }
      if (Array.isArray(mounts) && mounts.includes('trajectory-cache@1') && ref == null) {
        failures.push(`${effectId}: trajectory mount ${node.uuid} lacks a resource binding`);
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(config?.quarksConfig?.object);
  return failures;
}

const manifest = await readJson(path.join(artifactDir, 'manifest.json'), 'artifact manifest');
const resourceManifest = await readJson(path.join(artifactDir, 'resources.manifest.json'), 'resource manifest');
if (!manifest || !resourceManifest) process.exit(1);
if (manifest.schema !== 'vfx-runtime-artifact-manifest@3') errors.push('artifact manifest: invalid schema');
if (resourceManifest.schema !== 'vfx-resource-manifest@3') errors.push('resource manifest: invalid schema');

const resourceById = new Map();
const resourceByUri = new Map();
for (const resource of resourceManifest.resources ?? []) {
  if (resourceById.has(resource.id)) errors.push(`resource manifest: duplicate id ${resource.id}`);
  if (resourceByUri.has(resource.uri)) errors.push(`resource manifest: duplicate URI ${resource.uri}`);
  resourceById.set(resource.id, resource);
  resourceByUri.set(resource.uri, resource);
  await verifyFile(resource, '/assets/v3-resources/', resourceDir, `resource ${resource.id}`);
}

const effectIds = new Set();
const artifactFiles = new Set();
const globallyReferenced = new Set();
for (const entry of manifest.effects ?? []) {
  if (effectIds.has(entry.id)) errors.push(`artifact manifest: duplicate effect id ${entry.id}`);
  if (artifactFiles.has(entry.file)) errors.push(`artifact manifest: duplicate artifact file ${entry.file}`);
  effectIds.add(entry.id);
  artifactFiles.add(entry.file);
  if (!['candidate', 'qualified', 'failed'].includes(entry.disposition)) {
    errors.push(`${entry.id}: invalid or missing disposition`);
  }
  if (!entry.capabilities || typeof entry.capabilities.thinPlayer !== 'boolean') {
    errors.push(`${entry.id}: missing compiled capabilities.thinPlayer stamp`);
  }
  if (entry.disposition === 'qualified'
    && (!entry.qualification || typeof entry.qualification.thinPlayer !== 'boolean'
      || !Array.isArray(entry.qualification.captureTimes)
      || entry.qualification.captureTimes.some((time) => !Number.isFinite(time)))) {
    errors.push(`${entry.id}: qualified entry is missing machine qualification evidence`);
  }
  if (entry.artifact !== `/assets/v3-artifacts/${entry.file}`) {
    errors.push(`${entry.id}: artifact URI does not match manifest file`);
  }
  const artifact = await readJson(path.join(artifactDir, entry.file), entry.id);
  if (!artifact) continue;
  const artifactBytes = await readFile(path.join(artifactDir, entry.file));
  if (!/^[a-f0-9]{64}$/.test(entry.sha256) || digest(artifactBytes) !== entry.sha256) {
    errors.push(`${entry.id}: manifest artifact sha256 mismatch`);
  }
  if (artifact.effectId !== entry.id) errors.push(`${entry.id}: artifact effectId mismatch`);
  if (artifact.compatibility) errors.push(`${entry.id}: legacy compatibility payload remains`);
  try {
    assertVfxRuntimeArtifactV3(artifact);
  } catch (error) {
    errors.push(`${entry.id}: schema contract failed (${error.message})`);
  }
  const computedThin = computeThinPlayerCapability(artifact);
  if (entry.capabilities?.thinPlayer !== computedThin) {
    errors.push(`${entry.id}: thin capability stamp disagrees with artifact closure`);
  }
  if (!artifact.files?.config || !artifact.files?.shaders) errors.push(`${entry.id}: physical code split missing`);
  if (artifact.simulation || artifact.runtimeState || artifact.shaders) {
    errors.push(`${entry.id}: split artifact still contains embedded runtime fields`);
  }

  const referenced = new Set();
  scanBindings(artifact, artifact, referenced);
  for (const [id, resource] of Object.entries(artifact.resources ?? {})) {
    if (resource.id !== id) errors.push(`${entry.id}: resource key/id mismatch ${id}`);
    const indexed = resourceById.get(id);
    if (!indexed || JSON.stringify(indexed) !== JSON.stringify(resource)) {
      errors.push(`${entry.id}: resource ${id} is absent from or differs from global index`);
    }
    await verifyFile(resource, '/assets/v3-resources/', resourceDir, `${entry.id}: resource ${id}`);
  }

  let config;
  if (artifact.files?.config) {
    const bytes = await verifyFile(
      artifact.files.config, '/assets/v3-code/', codeDir, `${entry.id}: config`,
    );
    if (bytes) {
      try { config = JSON.parse(bytes.toString('utf8')); }
      catch { errors.push(`${entry.id}: config is not JSON`); }
    }
    if (config) {
      if (!config.quarksConfig || typeof config.quarksConfig !== 'object') errors.push(`${entry.id}: config missing quarksConfig`);
      if (!config.runtimeState || typeof config.runtimeState !== 'object') errors.push(`${entry.id}: config missing runtimeState`);
      const artifactOwnedExecution = artifact.execution?.simulation === 'artifact-emitter-sim@1'
        && artifact.execution?.trajectory === 'artifact-trajectory@1';
      if (artifactOwnedExecution) {
        if (config.schema !== 'vfx-thin-config@1') errors.push(`${entry.id}: thin config schema is missing`);
        if (config.runtimeState?.cfxrState != null) errors.push(`${entry.id}: thin config retains cfxrState`);
      } else if (config.schema !== 'vfx-runtime-config@3') {
        errors.push(`${entry.id}: bridge config schema is missing`);
      }
      if (!config.runtimeState?.runtimeConfig || typeof config.runtimeState.runtimeConfig !== 'object') {
        errors.push(`${entry.id}: config missing runtimeConfig`);
      }
      if ('simulation' in config || 'runtimePlan' in config) errors.push(`${entry.id}: deprecated config field remains`);
      if (artifact.execution?.trajectory === 'artifact-trajectory@1') {
        errors.push(...auditTrajectoryClosure(entry.id, config, artifact));
      }
      scanBindings(config, artifact, referenced, '$config');
    }
  }
  for (const [shaderId, shader] of Object.entries(artifact.files?.shaders ?? {})) {
    if (shader.id !== shaderId) errors.push(`${entry.id}: split shader key/id mismatch ${shaderId}`);
    await verifyFile(shader.vertex, '/assets/v3-code/', codeDir, `${entry.id}: ${shaderId} vertex`, true);
    await verifyFile(shader.fragment, '/assets/v3-code/', codeDir, `${entry.id}: ${shaderId} fragment`, true);
  }
  for (const id of referenced) globallyReferenced.add(id);
  for (const id of Object.keys(artifact.resources ?? {})) {
    if (!referenced.has(id)) errors.push(`${entry.id}: unreferenced artifact resource ${id}`);
  }
}

for (const id of resourceById.keys()) {
  if (!globallyReferenced.has(id)) errors.push(`resource manifest: orphan resource ${id}`);
}
for (const id of globallyReferenced) {
  if (!resourceById.has(id)) errors.push(`resource manifest: missing referenced resource ${id}`);
}

if (errors.length) {
  console.error(`v3 asset validation failed (${errors.length}):\n${errors.slice(0, 80).join('\n')}`);
  process.exit(1);
}
console.log(
  `v3 asset validation passed (${manifest.effects.length} artifacts, `
  + `${resourceById.size} reachable resources, no orphan entries).`,
);
