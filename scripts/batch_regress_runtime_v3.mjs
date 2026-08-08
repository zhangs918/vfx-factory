import { readFile, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  atomicWriteJson,
  applyQualificationLedger,
  currentQualificationContext,
  loadQualificationLedger,
  recordQualification,
  saveQualificationLedger,
} from './lib/runtime_v3_qualification.mjs';
import { classifyRegressionReport } from './lib/runtime_v3_regression_report.mjs';

const run = promisify(execFile);
const batchSize = Number(process.env.VFX_BATCH_SIZE ?? 5);
const maxBatches = Number(process.env.VFX_MAX_BATCHES ?? Number.POSITIVE_INFINITY);
// One-shot CI/release batches should continue immediately. Monitoring callers
// can opt into a delay explicitly through VFX_LOOP_INTERVAL_MS.
const loopIntervalMs = Number(process.env.VFX_LOOP_INTERVAL_MS ?? 60_000);
if (!Number.isFinite(loopIntervalMs) || loopIntervalMs < 0) {
  throw new Error('VFX_LOOP_INTERVAL_MS must be a non-negative finite number');
}
const scope = process.env.VFX_REGRESSION_SCOPE ?? 'candidate';
const effectOrder = process.env.VFX_EFFECT_ORDER ?? 'forward';
if (!['forward', 'reverse'].includes(effectOrder)) {
  throw new Error('VFX_EFFECT_ORDER must be either forward or reverse');
}
const captureTimes = (process.env.VFX_CAPTURE_TIMES ?? '0.25')
  .split(',').map(Number).filter(Number.isFinite);
if (!captureTimes.length) throw new Error('VFX_CAPTURE_TIMES must contain at least one finite number.');
// Thin is the only production regression path. Opt out with VFX_THIN_PLAYER=0 only
// for emergency non-thin selection (preview itself always plays thin).
const thinPlayer = process.env.VFX_THIN_PLAYER !== '0';
const skipThinReady = process.env.VFX_SKIP_THIN_READY === '1';
const manifestPath = 'public/assets/v3-artifacts/manifest.json';
const logPath = '/tmp/vfx-runtime-v3-batch.log';
let totalPassed = 0;
let totalFailed = 0;
let totalHarnessErrors = 0;
const failedIds = new Set();
const testedIds = new Set();
let batches = 0;

async function persistFailures(ids, failure, report) {
  if (!ids.length) return;
  const context = await currentQualificationContext();
  const ledger = await loadQualificationLedger();
  for (const id of ids) {
    const rows = report?.results?.filter((row) => row.id === id && row.status === 'FAIL') ?? [];
    recordQualification(ledger, [id], 'failed', context, {
      failure,
      thinPlayer: report?.thinPlayer === true,
      captureTimes: rows.map((row) => row.captureTime),
      changedPixels: rows.reduce((maximum, row) => Math.max(maximum, row.changedPixels), 0),
      maxChannelDelta: rows.reduce((maximum, row) => Math.max(maximum, row.maxChannelDelta), 0),
    });
  }
  await saveQualificationLedger(ledger);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await atomicWriteJson(manifestPath, applyQualificationLedger(manifest, ledger, context));
}

while (batches < maxBatches) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const hasRequestedThinEvidence = (entry) => entry.qualification?.thinPlayer === true
    && captureTimes.every((time) => entry.qualification.captureTimes.includes(time));
  const eligible = manifest.effects.filter((entry) => entry.status === 'compiled' && !testedIds.has(entry.id)
    && (!skipThinReady || entry.capabilities?.thinPlayer !== true)
    && (thinPlayer
      ? entry.capabilities?.thinPlayer === true
        && entry.disposition !== 'failed'
        && !hasRequestedThinEvidence(entry)
      : (scope === 'all' || entry.disposition === scope)));
  const orderedEligible = effectOrder === 'reverse' ? eligible.toReversed() : eligible;
  const ids = orderedEligible.slice(0, batchSize).map((entry) => entry.id);
  if (!ids.length) break;
  batches++;
  const reportPath = `/tmp/vfx-runtime-v3-report-${process.pid}-${batches}.json`;
  const regressionEnv = {
    ...process.env,
    VFX_CAPTURE_TIMES: captureTimes.join(','),
    VFX_THIN_PLAYER: thinPlayer ? '1' : '0',
    VFX_REGRESSION_REPORT: reportPath,
  };
  try {
    const result = await run(process.execPath, ['scripts/regress_runtime_v3.mjs', ...ids], {
      maxBuffer: 1024 * 1024 * 4,
      env: regressionEnv,
    });
    await appendFile(logPath, result.stdout);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const { passed, failed } = classifyRegressionReport(report, ids, captureTimes, { requireThin: thinPlayer });
    if (passed.length) await run(process.execPath, ['scripts/promote_runtime_v3.mjs', ...passed], {
      env: { ...regressionEnv, VFX_REQUIRE_THIN_PLAYER: thinPlayer ? '1' : '0' },
    });
    const pixelFailed = failed.filter((id) => report.results.some((row) => row.id === id && row.status === 'FAIL'));
    await persistFailures(pixelFailed, 'fixed-seed-pixel-regression', report);
    totalPassed += passed.length;
    totalFailed += pixelFailed.length;
    totalHarnessErrors += failed.length - pixelFailed.length;
    ids.forEach((id) => testedIds.add(id));
    pixelFailed.forEach((id) => failedIds.add(id));
    console.log(
      `batch passed=${passed.length} failed=${pixelFailed.length} `
      + `harnessErrors=${failed.length - pixelFailed.length} totalPassed=${totalPassed} totalFailed=${totalFailed}`,
    );
  } catch (error) {
    const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
    await appendFile(logPath, `ERROR ${ids.join(' ')} ${output}\n`);
    let passed = [];
    let failed = [...ids];
    let report;
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
      ({ passed, failed } = classifyRegressionReport(report, ids, captureTimes, { requireThin: thinPlayer }));
    } catch {}
    if (passed.length) await run(process.execPath, ['scripts/promote_runtime_v3.mjs', ...passed], {
      env: { ...regressionEnv, VFX_REQUIRE_THIN_PLAYER: thinPlayer ? '1' : '0' },
    });
    // A harness/network/browser failure is not evidence that an effect is bad.
    // Persist only explicit pixel differences; incomplete effects remain candidates.
    const pixelFailed = report
      ? failed.filter((id) => report.results.some((row) => row.id === id && row.status === 'FAIL'))
      : [];
    await persistFailures(pixelFailed, 'fixed-seed-pixel-regression', report);
    totalPassed += passed.length;
    totalFailed += pixelFailed.length;
    totalHarnessErrors += failed.length - pixelFailed.length;
    ids.forEach((id) => testedIds.add(id));
    pixelFailed.forEach((id) => failedIds.add(id));
    console.error(
      `batch error passed=${passed.length} failed=${pixelFailed.length} `
      + `harnessErrors=${failed.length - pixelFailed.length} (${ids.join(', ')}), continuing`,
    );
  }
  await run(process.execPath, ['scripts/validate_runtime_v3_assets.mjs'], {
    maxBuffer: 1024 * 1024 * 8,
  });
  const nextManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const hasNext = nextManifest.effects.some((entry) => entry.status === 'compiled'
    && !testedIds.has(entry.id)
    && (!skipThinReady || entry.capabilities?.thinPlayer !== true)
    && (thinPlayer
      ? entry.capabilities?.thinPlayer === true
        && entry.disposition !== 'failed'
        && !hasRequestedThinEvidence(entry)
      : (scope === 'all' || entry.disposition === scope)));
  if (!hasNext) break;
  console.log(`batch validation passed; next qualification scan in ${loopIntervalMs}ms`);
  if (batches < maxBatches && loopIntervalMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, loopIntervalMs));
  }
}
console.log(
  `complete batches=${batches} passed=${totalPassed} failed=${totalFailed} `
  + `harnessErrors=${totalHarnessErrors} scope=${scope} thin=${thinPlayer}`,
);
if (totalHarnessErrors) process.exitCode = 2;
