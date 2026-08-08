#!/usr/bin/env node
/**
 * Offline family qualify attempt (prod Quarks path vs frozen).
 * Stamps provisional evidence → targeted release compile → 4-time regress.
 * Keeps evidence only on all PASS; otherwise revokes and rolls artifacts back.
 *
 * Usage:
 *   node scripts/try_qualify_material_family.mjs <familyId> <effectId> [effectId...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runtimeFingerprint } from './runtime_fingerprint.mjs';
import { classifyRegressionReport } from './lib/runtime_v3_regression_report.mjs';

const familyId = process.argv[2];
const effectIds = process.argv.slice(3).filter((a) => !a.startsWith('-'));
if (!familyId?.startsWith('material-family-') || !effectIds.length) {
  console.error('Usage: node scripts/try_qualify_material_family.mjs <familyId> <effectId>...');
  process.exit(2);
}

const QUAL = 'config/material-family-qualification.json';
const reportPath = `/tmp/vfx-material-family-${process.pid}.json`;
const initialRuntimeFingerprint = runtimeFingerprint(process.cwd());
const evidence = {
  status: 'pixel-qualified',
  evidence: {
    compilerVersion: 'unity-vfx-material-emitter@10',
    captureTimes: [0.1, 0.25, 0.5, 1],
    changedPixels: 0,
    maxChannelDelta: 0,
  },
};

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: false,
  });
  if (r.status) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
};

const loadQual = () => JSON.parse(readFileSync(QUAL, 'utf8'));
const saveQual = (q) => writeFileSync(QUAL, `${JSON.stringify(q, null, 2)}\n`);

const releaseOne = (id) => {
  run('npm', ['run', 'compile:runtime-v3', '--', id]);
  run('npm', ['run', 'extract:runtime-v3-resources', '--', id]);
  run('npm', ['run', 'restore:runtime-v3-qualification', '--', id]);
  run('node', ['scripts/split_runtime_v3_code.mjs', id]);
  run('node', ['scripts/strip_runtime_v3_embedded.mjs', id]);
};

const assertFamilyActivated = (id) => {
  const manifest = JSON.parse(readFileSync('public/assets/v3-artifacts/manifest.json', 'utf8'));
  const entry = manifest.effects.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`missing v3 manifest entry for '${id}'`);
  const artifact = JSON.parse(readFileSync(`public/assets/v3-artifacts/${entry.file}`, 'utf8'));
  const pipelines = Object.values(artifact.pipelines ?? {})
    .filter((pipeline) => pipeline.qualification?.familyId === familyId);
  if (!pipelines.length) {
    throw new Error(`family '${familyId}' is not used by '${id}'`);
  }
  if (!pipelines.some((pipeline) => pipeline.executor === 'artifact-shader@1'
    && pipeline.qualification?.status === 'pixel-qualified')) {
    throw new Error(`family '${familyId}' is not artifact-executable for '${id}'`);
  }
};

const q0 = loadQual();
const had = q0.families[familyId];
q0.families[familyId] = evidence;
saveQual(q0);
console.log(`provisional ${familyId} for ${effectIds.length} effect(s)`);

try {
  for (const id of effectIds) {
    releaseOne(id);
    assertFamilyActivated(id);
  }
  const { VFX_THIN_PLAYER: _dropThin, ...baseEnv } = process.env;
  const env = {
    ...baseEnv,
    VFX_ORIGIN: process.env.VFX_ORIGIN ?? 'http://127.0.0.1:5173',
    VFX_CAPTURE_TIMES: '0.1,0.25,0.5,1',
    VFX_REGRESSION_REPORT: reportPath,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH
      ?? `${process.env.HOME}/Library/Caches/ms-playwright`,
    PLAYWRIGHT_CHROMIUM_EXECUTABLE: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  };
  const regress = spawnSync('node', ['scripts/regress_runtime_v3.mjs', ...effectIds], {
    stdio: 'inherit',
    env,
  });
  if (regress.status) throw new Error(`regress failed (${regress.status})`);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const currentRuntimeFingerprint = runtimeFingerprint(process.cwd());
  if (report.runtimeFingerprint !== initialRuntimeFingerprint
    || currentRuntimeFingerprint !== initialRuntimeFingerprint) {
    throw new Error('runtime fingerprint changed during family qualification');
  }
  const classification = classifyRegressionReport(
    report,
    effectIds,
    evidence.evidence.captureTimes,
  );
  if (classification.failed.length) {
    throw new Error(`incomplete family evidence: ${classification.failed.join(', ')}`);
  }
  console.log(`KEEP ${familyId}`);
} catch (err) {
  console.error(String(err?.message ?? err));
  const q = loadQual();
  if (had) q.families[familyId] = had;
  else delete q.families[familyId];
  saveQual(q);
  console.log(`REVOKED ${familyId}; rolling back effects`);
  for (const id of effectIds) {
    try { releaseOne(id); } catch (e) { console.error('rollback', id, e.message); }
  }
  process.exit(1);
}
