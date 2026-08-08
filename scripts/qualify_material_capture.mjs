#!/usr/bin/env node
/** Bind a machine pixel report to one exact offline material capture payload. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  classifyRegressionReport,
  DEFAULT_REGRESSION_REPORT,
} from './lib/runtime_v3_regression_report.mjs';
import {
  atomicWriteJson,
  currentQualificationContext,
} from './lib/runtime_v3_qualification.mjs';

const capturePath = process.argv[2];
const reportPath = process.argv[3] ?? process.env.VFX_REGRESSION_REPORT ?? DEFAULT_REGRESSION_REPORT;
if (!capturePath) {
  throw new Error('Usage: node scripts/qualify_material_capture.mjs <capture.json> [report.json]');
}

const capture = JSON.parse(await readFile(capturePath, 'utf8'));
if (capture.schema !== 'vfx-live-material-capture@1' || !capture.effectId) {
  throw new Error('Invalid live material capture');
}
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const context = await currentQualificationContext();
if (capture.runtimeFingerprint !== context.runtimeFingerprint
  || report.runtimeFingerprint !== context.runtimeFingerprint) {
  throw new Error('Capture or regression report runtime fingerprint is stale');
}
const captureTimes = [...new Set(report.captureTimes ?? [])];
if (captureTimes.length < 2) {
  throw new Error('Capture qualification requires at least two distinct times');
}
const classification = classifyRegressionReport(
  report,
  [capture.effectId],
  captureTimes,
  { requireThin: true },
);
if (classification.failed.length) {
  throw new Error(`Capture regression is incomplete or non-zero for '${capture.effectId}'`);
}
const manifest = JSON.parse(await readFile('public/assets/v3-artifacts/manifest.json', 'utf8'));
const entry = manifest.effects?.find((candidate) => candidate.id === capture.effectId);
if (!entry?.file) throw new Error(`No exact artifact manifest entry for '${capture.effectId}'`);
const artifactBytes = await readFile(join('public/assets/v3-artifacts', entry.file));
const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');
if (report.artifactFingerprints?.[capture.effectId] !== artifactSha256) {
  throw new Error('Capture qualification report tested different artifact bytes');
}
const { qualification: _qualification, ...payload } = capture;
const capturePayloadSha256 = createHash('sha256')
  .update(Buffer.from(JSON.stringify(payload)))
  .digest('hex');
capture.qualification = {
  schema: 'vfx-capture-qualification@1',
  status: 'pixel-qualified',
  qualifiedAt: new Date().toISOString(),
  runtimeFingerprint: context.runtimeFingerprint,
  corpusSha256: context.corpusSha256,
  oracleSha256: context.oracleSha256,
  capturePayloadSha256,
  reportSchema: report.schema,
  reportCreatedAt: report.createdAt,
  captureTimes,
  changedPixels: 0,
  maxChannelDelta: 0,
};
await atomicWriteJson(capturePath, capture);
console.log(`CAPTURE_QUALIFIED ${capture.effectId} times=${captureTimes.join(',')} report=${reportPath}`);
