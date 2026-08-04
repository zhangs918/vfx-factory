import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeFingerprint } from './runtime_fingerprint.mjs';

const root = path.resolve(import.meta.dirname, '..');
const assetRoot = path.join(root, 'public/assets/quarks');
const candidatePath = path.join(assetRoot, 'manifest.candidates.json');
if (!fs.existsSync(candidatePath)) throw new Error('Missing manifest.candidates.json; export candidates first');

const candidates = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const registryRaw = fs.readFileSync(path.join(root, 'config/semantic-adapters.json'));
const registryHash = crypto.createHash('sha256').update(registryRaw).digest('hex');
const runtimeHash = runtimeFingerprint(root);
const promoted = [];
const rejected = [];
const attestationDir = path.join(assetRoot, 'attestations');
fs.mkdirSync(attestationDir, { recursive: true });

for (const entry of candidates.effects ?? []) {
  const assetFile = path.join(assetRoot, entry.file);
  const reportFile = path.join(root, 'tmp-oracle-comparison', entry.id, 'report.json');
  if (!fs.existsSync(assetFile) || !fs.existsSync(reportFile)) {
    rejected.push({ id: entry.id, reason: 'missing asset or oracle report' });
    continue;
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const assetHash = crypto.createHash('sha256').update(fs.readFileSync(assetFile)).digest('hex');
  const valid = report.schema === 'live-oracle-comparison@3'
    && report.effectId === entry.id
    && report.passed === true
    && (!report.scope || report.scope.kind === 'full')
    && report.assetSha256 === assetHash
    && report.adapterRegistrySha256 === registryHash
    && report.runtimeSha256 === runtimeHash;
  if (!valid) {
    rejected.push({
      id: entry.id,
      reason: report.scope?.kind === 'diagnostic-subset'
        ? 'diagnostic subset cannot promote'
        : report.passed ? 'stale asset/oracle/adapter/runtime hashes' : 'oracle thresholds failed',
    });
    continue;
  }
  const attestation = {
    schema: 'live-ir-promotion@1',
    effectId: entry.id,
    passed: true,
    assetSha256: assetHash,
    oracleSha256: report.oracleSha256,
    adapterRegistrySha256: registryHash,
    runtimeSha256: runtimeHash,
    report: path.relative(root, reportFile),
  };
  fs.writeFileSync(path.join(attestationDir, `${entry.id}.json`), `${JSON.stringify(attestation, null, 2)}\n`);
  promoted.push({ ...entry, note: 'oracle-qualified live-particles@1' });
}

const manifest = { schema: 'vfx-production-manifest@1', effects: promoted };
fs.writeFileSync(path.join(assetRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const summary = { promoted: promoted.map((entry) => entry.id), rejected };
console.log(JSON.stringify(summary, null, 2));
if (rejected.length) process.exitCode = 1;
