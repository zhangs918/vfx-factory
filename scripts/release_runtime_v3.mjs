import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeFingerprint } from './runtime_fingerprint.mjs';

const root = process.cwd();
const assetRoot = path.join(root, 'public/assets');
await mkdir(assetRoot, { recursive: true });
const stageRoot = await mkdtemp(path.join(assetRoot, '.runtime-v3-stage-'));
const backupRoot = path.join(assetRoot, `.runtime-v3-backup-${process.pid}-${Date.now()}`);
const names = ['v3-resources', 'v3-code', 'v3-artifacts'];
const env = {
  ...process.env,
  VFX_V3_ARTIFACT_DIR: path.join(stageRoot, 'v3-artifacts'),
  VFX_V3_RESOURCE_DIR: path.join(stageRoot, 'v3-resources'),
  VFX_V3_CODE_DIR: path.join(stageRoot, 'v3-code'),
};

function runScript(name) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', name], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function materialCaptures() {
  const bundleFile = path.join(root, 'config/runtime-v3-manual-captures.json');
  if (await exists(bundleFile)) {
    const currentFingerprint = runtimeFingerprint(root);
    const bundle = JSON.parse(await readFile(bundleFile, 'utf8'));
    if (bundle.schema !== 'vfx-manual-capture-bundle@1') {
      throw new Error('manual capture bundle schema is invalid');
    }
    if (bundle.runtimeFingerprint !== currentFingerprint) {
      throw new Error('manual capture bundle is stale for the current runtime fingerprint');
    }
    const stagedManifest = JSON.parse(await readFile(
      path.join(env.VFX_V3_ARTIFACT_DIR, 'manifest.json'),
      'utf8',
    ));
    const required = new Set((stagedManifest.effects ?? []).map((entry) => String(entry.id)));
    const missing = [...required].filter((id) => !bundle.effects?.[id]);
    if (missing.length) {
      throw new Error(`manual capture bundle missing ${missing.length} effects`);
    }
    const expandedDir = path.join(stageRoot, '.manual-captures');
    await mkdir(expandedDir, { recursive: true });
    const files = [];
    for (const id of [...required].sort()) {
      const stored = bundle.effects[id];
      const capture = {
        ...stored,
        batches: (stored.batches ?? []).map((batch) => {
          const shader = bundle.shaders?.[batch.shaderBundleId];
          if (!shader) throw new Error(`${id}: missing bundled shader ${batch.shaderBundleId}`);
          const { shaderBundleId: _shaderBundleId, ...metadata } = batch;
          return {
            ...metadata,
            vertexShader: shader.vertex,
            fragmentShader: shader.fragment,
          };
        }),
      };
      const file = path.join(expandedDir, `${id}.json`);
      await writeFile(file, JSON.stringify(capture));
      files.push(file);
    }
    console.log(`expanded ${files.length} checked-in manual captures`);
    return files;
  }
  if (process.env.VFX_ALLOW_TMP_CAPTURES !== '1') {
    throw new Error('checked-in manual capture bundle is required for release');
  }
  const dir = path.join(root, 'tmp/material-captures');
  try {
    const currentFingerprint = runtimeFingerprint(root);
    const files = (await readdir(dir))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(dir, name));
    const usable = [];
    for (const file of files) {
      try {
        const capture = JSON.parse(await readFile(file, 'utf8'));
        if (capture.runtimeFingerprint === currentFingerprint) usable.push(file);
      } catch {
        // Invalid generated captures are not release inputs.
      }
    }
    return usable;
  } catch {
    return [];
  }
}

async function exists(file) {
  try { await access(file); return true; }
  catch { return false; }
}

let promoted = false;
try {
  await runScript('index:frozen-materials');
  await runScript('compile:runtime-v3');
  await runScript('extract:runtime-v3-resources');
  await runScript('split:runtime-v3-code');
  const captures = await materialCaptures();
  if (captures.length) {
    await runNode('scripts/stamp_artifact_from_capture.mjs', captures);
  }
  await runScript('strip:runtime-v3-embedded');
  await runScript('restore:runtime-v3-qualification');
  await runScript('validate:runtime-v3-assets');

  await mkdir(backupRoot, { recursive: true });
  const movedOld = [];
  const movedNew = [];
  try {
    // The artifact manifest is the publication pointer, so it moves last.
    for (const name of names) {
      const current = path.join(assetRoot, name);
      if (await exists(current)) {
        await rename(current, path.join(backupRoot, name));
        movedOld.push(name);
      }
    }
    for (const name of names) {
      await rename(path.join(stageRoot, name), path.join(assetRoot, name));
      movedNew.push(name);
    }
  } catch (error) {
    for (const name of movedNew.reverse()) {
      const current = path.join(assetRoot, name);
      if (await exists(current)) await rename(current, path.join(stageRoot, name));
    }
    for (const name of movedOld.reverse()) {
      const backup = path.join(backupRoot, name);
      if (await exists(backup)) await rename(backup, path.join(assetRoot, name));
    }
    throw error;
  }
  promoted = true;
  console.log('runtime-v3 release validated and promoted transactionally');
} finally {
  await rm(stageRoot, { recursive: true, force: true });
  if (promoted) await rm(backupRoot, { recursive: true, force: true });
}
