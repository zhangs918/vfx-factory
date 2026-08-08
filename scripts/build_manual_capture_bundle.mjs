#!/usr/bin/env node
/** Deduplicate approved per-effect captures into a checked-in release input. */
import { createHash } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const captureDir = path.join(root, 'tmp/material-captures');
const target = path.join(root, 'config/runtime-v3-manual-captures.json');
const manifest = JSON.parse(await readFile(
  path.join(root, 'public/assets/v3-artifacts/manifest.json'),
  'utf8',
));
const wanted = new Set((manifest.effects ?? []).map((entry) => String(entry.id)));
const captures = new Map();
for (const name of await readdir(captureDir)) {
  if (!name.endsWith('.json')) continue;
  try {
    const capture = JSON.parse(await readFile(path.join(captureDir, name), 'utf8'));
    if (capture.schema === 'vfx-live-material-capture@1' && wanted.has(capture.effectId)) {
      captures.set(capture.effectId, capture);
    }
  } catch {
    // Ignore diagnostic/partial files.
  }
}
const missing = [...wanted].filter((id) => !captures.has(id));
if (missing.length) throw new Error(`Capture bundle missing effects: ${missing.slice(0, 12).join(', ')}`);

const shaders = {};
const effects = {};
let runtimeFingerprint;
for (const id of [...wanted].sort()) {
  const capture = captures.get(id);
  if (capture.qualification?.status !== 'manual-qualified') {
    throw new Error(`${id}: capture is not manual-qualified`);
  }
  if (runtimeFingerprint == null) runtimeFingerprint = capture.runtimeFingerprint;
  if (capture.runtimeFingerprint !== runtimeFingerprint) {
    throw new Error(`${id}: capture runtime fingerprint differs from bundle`);
  }
  const batches = (capture.batches ?? []).map((batch) => {
    const vertex = String(batch.vertexShader ?? '');
    const fragment = String(batch.fragmentShader ?? '');
    const shaderId = createHash('sha256').update(vertex).update('\0').update(fragment).digest('hex');
    shaders[shaderId] ??= { vertex, fragment };
    const { vertexShader: _vertex, fragmentShader: _fragment, ...metadata } = batch;
    return { ...metadata, shaderBundleId: shaderId };
  });
  const { batches: _batches, ...metadata } = capture;
  const stored = { ...metadata, batches };
  const expanded = {
    ...stored,
    batches: stored.batches.map((batch) => {
      const shader = shaders[batch.shaderBundleId];
      const { shaderBundleId: _shaderBundleId, ...batchMetadata } = batch;
      return {
        ...batchMetadata,
        vertexShader: shader.vertex,
        fragmentShader: shader.fragment,
      };
    }),
  };
  const { qualification: _qualification, ...payload } = expanded;
  stored.qualification = {
    ...stored.qualification,
    capturePayloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
  effects[id] = stored;
}
const bundle = {
  schema: 'vfx-manual-capture-bundle@1',
  runtimeFingerprint,
  effects,
  shaders,
};
const temporary = `${target}.tmp-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(bundle)}\n`);
await rename(temporary, target);
console.log(
  `MANUAL_CAPTURE_BUNDLE_OK effects=${Object.keys(effects).length} `
  + `shaders=${Object.keys(shaders).length} bytes=${Buffer.byteLength(JSON.stringify(bundle))}`,
);
