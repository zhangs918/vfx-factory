import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  classifyRegressionReport,
  DEFAULT_REGRESSION_REPORT,
} from './lib/runtime_v3_regression_report.mjs';
import {
  atomicWriteFile,
  atomicWriteJson,
  applyQualificationLedger,
  currentQualificationContext,
  loadQualificationLedger,
  recordQualification,
  saveQualificationLedger,
} from './lib/runtime_v3_qualification.mjs';
const ids = new Set(process.argv.slice(2));
if (!ids.size) throw new Error('Usage: npm run promote:runtime-v3 -- <effect-id> [...]');
const path = 'public/assets/v3-artifacts/manifest.json';
const run = promisify(execFile);
const originalManifest = await readFile(path, 'utf8');
const originalLedger = await readFile('config/runtime-v3-qualification.json', 'utf8');
const manifest = JSON.parse(originalManifest);
const entries = new Map(manifest.effects.map((entry) => [entry.id, entry]));
for (const id of ids) {
  const entry = entries.get(id);
  if (!entry) throw new Error(`Unknown runtime-v3 effect '${id}'`);
  if (entry.status !== 'compiled') throw new Error(`Runtime-v3 effect '${id}' is not compiled`);
}
const reportPath = process.env.VFX_REGRESSION_REPORT ?? DEFAULT_REGRESSION_REPORT;
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const requested = [...ids];
const classification = classifyRegressionReport(report, requested, report.captureTimes, {
  requireThin: process.env.VFX_REQUIRE_THIN_PLAYER === '1',
});
if (process.env.VFX_REQUIRE_THIN_PLAYER === '1'
  && new Set(report.captureTimes).size < 2) {
  throw new Error('Thin-player qualification requires at least two distinct capture times');
}
if (classification.failed.length) {
  throw new Error(`Regression evidence is incomplete or non-zero for: ${classification.failed.join(', ')}`);
}
const context = await currentQualificationContext();
if (report.runtimeFingerprint !== context.runtimeFingerprint) {
  throw new Error('Regression report runtime fingerprint is stale');
}
for (const id of ids) {
  const entry = entries.get(id);
  const bytes = await readFile(`public/assets/v3-artifacts/${entry.file}`);
  const currentArtifact = createHash('sha256').update(bytes).digest('hex');
  if (report.artifactFingerprints?.[id] !== currentArtifact) {
    throw new Error(`Regression report artifact fingerprint is stale for '${id}'`);
  }
}
const ledger = await loadQualificationLedger();
for (const id of ids) {
  recordQualification(ledger, [id], 'qualified', context, {
    artifactSha256: report.artifactFingerprints[id],
    reportSchema: report.schema,
    reportCreatedAt: report.createdAt,
    thinPlayer: report.thinPlayer,
    captureTimes: report.captureTimes,
    changedPixels: 0,
    maxChannelDelta: 0,
  });
}
const restored = applyQualificationLedger(manifest, ledger, context);
try {
  await saveQualificationLedger(ledger);
  await atomicWriteJson(path, restored);
  await run(process.execPath, ['scripts/validate_runtime_v3_assets.mjs'], {
    maxBuffer: 1024 * 1024 * 8,
  });
} catch (error) {
  await atomicWriteFile('config/runtime-v3-qualification.json', originalLedger);
  await atomicWriteFile(path, originalManifest);
  throw error;
}
console.log(`qualified ${restored.effects.filter((entry) => entry.disposition === 'qualified').length} v3 effects transactionally from ${reportPath}`);
