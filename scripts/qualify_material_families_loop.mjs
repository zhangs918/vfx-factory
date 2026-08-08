#!/usr/bin/env node
/**
 * One material family per interval: exact thick proof -> full offline release ->
 * one thin effect batch -> asset validation. Failed families remain bridge and
 * are skipped for the lifetime of this process.
 */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { runtimeFingerprint } from './runtime_fingerprint.mjs';

const root = process.cwd();
const intervalMs = Number(process.env.VFX_LOOP_INTERVAL_MS ?? 60_000);
const maxIterations = Number(process.env.VFX_MAX_FAMILY_ITERATIONS ?? Number.POSITIVE_INFINITY);
const origin = process.env.VFX_ORIGIN ?? 'http://127.0.0.1:5175';
const familyOrder = process.env.VFX_FAMILY_ORDER ?? 'forward';
const skippedFamilies = new Set((process.env.VFX_SKIP_FAMILIES ?? '')
  .split(',').map((value) => value.trim()).filter(Boolean));
if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('Invalid VFX_LOOP_INTERVAL_MS');
if (!(maxIterations > 0)) throw new Error('Invalid VFX_MAX_FAMILY_ITERATIONS');
if (!['forward', 'reverse'].includes(familyOrder)) throw new Error('Invalid VFX_FAMILY_ORDER');

const attempted = new Set();

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function selectFamily() {
  const artifactDir = path.join(root, 'public/assets/v3-artifacts');
  const manifest = JSON.parse(await readFile(path.join(artifactDir, 'manifest.json'), 'utf8'));
  const qualification = JSON.parse(await readFile(
    path.join(root, 'config/material-family-qualification.json'),
    'utf8',
  ));
  const alreadyQualified = new Set(Object.entries(qualification.families ?? {})
    .filter(([, value]) => value?.status === 'pixel-qualified'
      && value?.evidence?.compilerVersion === 'unity-vfx-material-emitter@10')
    .map(([familyId]) => familyId));
  const groups = new Map();
  for (const entry of manifest.effects ?? []) {
    if (entry.status !== 'compiled') continue;
    const artifact = JSON.parse(await readFile(path.join(artifactDir, entry.file), 'utf8'));
    const pipelines = artifact.pipelines ?? {};
    const bridgeFamilies = new Set(Object.values(pipelines)
      .filter((pipeline) => pipeline.qualification?.status !== 'pixel-qualified')
      .map((pipeline) => pipeline.qualification?.familyId)
      .filter((familyId) => typeof familyId === 'string' && familyId.startsWith('material-family-')));
    for (const familyId of bridgeFamilies) {
      // A provisional family may switch only its own pipelines to artifact
      // execution. Select a fixture where every touched batch closure remains
      // homogeneous; otherwise the thick binder correctly rejects the mixed
      // bridge/artifact closure before a pixel comparison can run.
      const touchedClosures = Object.values(artifact.batchClosures ?? {}).filter((closure) => {
        const ids = closure.pipelineIds ?? closure.pipelines ?? [];
        return ids.some((id) => pipelines[id]?.qualification?.familyId === familyId);
      });
      const closureCompatible = touchedClosures.length > 0 && touchedClosures.every((closure) => {
        const ids = closure.pipelineIds ?? closure.pipelines ?? [];
        return ids.every((id) => pipelines[id]?.qualification?.familyId === familyId
          || pipelines[id]?.qualification?.status === 'pixel-qualified');
      });
      const group = groups.get(familyId) ?? { familyId, effects: [], totalBridgeFamilies: 0 };
      group.effects.push({
        id: entry.id,
        closureCompatible,
        familyCount: bridgeFamilies.size,
        pipelineCount: Object.keys(pipelines).length,
      });
      group.totalBridgeFamilies += bridgeFamilies.size;
      groups.set(familyId, group);
    }
  }
  for (const group of groups.values()) {
    group.effects.sort((left, right) => Number(right.closureCompatible) - Number(left.closureCompatible)
      || left.familyCount - right.familyCount
      || left.pipelineCount - right.pipelineCount
      || left.id.localeCompare(right.id));
  }
  const candidates = [...groups.values()]
    .filter((group) => !attempted.has(group.familyId)
      && !alreadyQualified.has(group.familyId)
      && !skippedFamilies.has(group.familyId))
    .sort((left, right) => right.effects.length - left.effects.length
      || left.totalBridgeFamilies - right.totalBridgeFamilies
      || left.familyId.localeCompare(right.familyId));
  return (familyOrder === 'reverse' ? candidates.at(-1) : candidates[0]) ?? null;
}

for (let iteration = 1; iteration <= maxIterations; iteration++) {
  const startedAt = Date.now();
  const iterationFingerprint = runtimeFingerprint(root);
  const candidate = await selectFamily();
  if (!candidate) {
    console.log(`FAMILY_LOOP_COMPLETE iterations=${iteration - 1} attempted=${attempted.size}`);
    break;
  }
  attempted.add(candidate.familyId);
  const representative = candidate.effects[0].id;
  console.log(
    `FAMILY_LOOP_BEGIN iteration=${iteration} family=${candidate.familyId} `
    + `affected=${candidate.effects.length} representative=${representative}`,
  );
  try {
    await run(process.execPath, [
      'scripts/try_qualify_material_family.mjs',
      candidate.familyId,
      representative,
    ], { VFX_ORIGIN: origin });
    if (runtimeFingerprint(root) !== iterationFingerprint) {
      throw new Error('runtime fingerprint changed before release');
    }
    await run('npm', ['run', 'compile:runtime-v3:release']);
    if (runtimeFingerprint(root) !== iterationFingerprint) {
      throw new Error('runtime fingerprint changed during release');
    }
    await run(process.execPath, ['scripts/batch_regress_runtime_v3.mjs'], {
      VFX_ORIGIN: origin,
      VFX_THIN_PLAYER: '1',
      VFX_CAPTURE_TIMES: '0.25,0.5',
      VFX_BATCH_SIZE: process.env.VFX_THIN_BATCH_SIZE ?? '5',
      VFX_MAX_BATCHES: '1',
      VFX_LOOP_INTERVAL_MS: '0',
    });
    await run(process.execPath, ['scripts/validate_runtime_v3_assets.mjs']);
    console.log(`FAMILY_LOOP_OK iteration=${iteration} family=${candidate.familyId}`);
  } catch (error) {
    console.error(`FAMILY_LOOP_FAIL iteration=${iteration} family=${candidate.familyId} ${error.message}`);
    // Some Quarks batches coalesce materials more aggressively than the static
    // closure signature can prove. Do not widen the runtime bridge or forge a
    // family proof: capture that effect's final thick GLSL offline, exercise the
    // thin player provisionally, then persist the capture only on exact pixels.
    if (process.env.VFX_CAPTURE_FALLBACK !== '0'
      && runtimeFingerprint(root) === iterationFingerprint) {
      const capturePath = path.join(root, 'tmp/material-captures', `${representative}.json`);
      const reportPath = `/tmp/vfx-family-capture-${process.pid}-${iteration}.json`;
      try {
        await run(process.execPath, [
          'scripts/capture_bridge_material_stamps.mjs', representative,
        ], { VFX_ORIGIN: origin, VFX_CAPTURE_FREEZE: '0.25' });
        await run(process.execPath, [
          'scripts/stamp_artifact_from_capture.mjs', capturePath,
        ], {
          VFX_PROVISIONAL_CAPTURE_QUALIFICATION: '1',
          VFX_CAPTURE_TIMES: '0.25,0.5',
        });
        await run(process.execPath, [
          'scripts/strip_runtime_v3_embedded.mjs', representative,
        ]);
        await run(process.execPath, [
          'scripts/regress_runtime_v3.mjs', representative,
        ], {
          VFX_ORIGIN: origin,
          VFX_THIN_PLAYER: '1',
          VFX_CAPTURE_TIMES: '0.25,0.5',
          VFX_REGRESSION_REPORT: reportPath,
        });
        await run(process.execPath, [
          'scripts/qualify_material_capture.mjs', capturePath, reportPath,
        ]);
        if (runtimeFingerprint(root) !== iterationFingerprint) {
          throw new Error('runtime fingerprint changed during capture fallback');
        }
        await run('npm', ['run', 'compile:runtime-v3:release']);
        await run(process.execPath, ['scripts/batch_regress_runtime_v3.mjs'], {
          VFX_ORIGIN: origin,
          VFX_THIN_PLAYER: '1',
          VFX_CAPTURE_TIMES: '0.25,0.5',
          VFX_BATCH_SIZE: process.env.VFX_THIN_BATCH_SIZE ?? '5',
          VFX_MAX_BATCHES: '1',
          VFX_LOOP_INTERVAL_MS: '0',
        });
        await run(process.execPath, ['scripts/validate_runtime_v3_assets.mjs']);
        console.log(`FAMILY_LOOP_CAPTURE_OK iteration=${iteration} effect=${representative}`);
      } catch (captureError) {
        console.error(
          `FAMILY_LOOP_CAPTURE_FAIL iteration=${iteration} effect=${representative} ${captureError.message}`,
        );
      }
    }
  }
  const waitMs = Math.max(0, intervalMs - (Date.now() - startedAt));
  if (iteration < maxIterations && waitMs > 0) {
    console.log(`FAMILY_LOOP_WAIT ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
