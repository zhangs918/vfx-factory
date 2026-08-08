import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeFingerprint } from '../runtime_fingerprint.mjs';

export const QUALIFICATION_SCHEMA = 'vfx-runtime-qualification@1';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function atomicWriteFile(file, contents) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

export async function atomicWriteJson(file, value) {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function currentQualificationContext(root = process.cwd()) {
  const oracleFiles = [
    'public/assets/frozen-quarks/manifest.json',
    'public/assets/frozen-quarks/materials.manifest.json',
    'public/assets/frozen-quarks/resources.manifest.json',
  ];
  const oracleHash = createHash('sha256');
  for (const relative of oracleFiles) {
    oracleHash.update(`${relative}\0`);
    oracleHash.update(await readFile(path.join(root, relative)));
    oracleHash.update('\0');
  }
  return {
    corpusSha256: sha256(await readFile(path.join(root, oracleFiles[0]))),
    oracleSha256: oracleHash.digest('hex'),
    runtimeFingerprint: runtimeFingerprint(root),
  };
}

export async function loadQualificationLedger(root = process.cwd()) {
  const file = path.join(root, 'config/runtime-v3-qualification.json');
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  if (ledger.schema !== QUALIFICATION_SCHEMA || !ledger.effects || typeof ledger.effects !== 'object') {
    throw new Error('Invalid runtime-v3 qualification ledger');
  }
  return ledger;
}

export async function saveQualificationLedger(ledger, root = process.cwd()) {
  const file = path.join(root, 'config/runtime-v3-qualification.json');
  await atomicWriteJson(file, ledger);
}

export function dispositionFor(record, context, artifactSha256) {
  if (record?.disposition === 'failed') return 'failed';
  if (record?.disposition === 'qualified'
    && record.evidence?.corpusSha256 === context.corpusSha256
    && record.evidence?.oracleSha256 === context.oracleSha256
    && record.evidence?.runtimeFingerprint === context.runtimeFingerprint
    && record.evidence?.artifactSha256 === artifactSha256) return 'qualified';
  return 'candidate';
}

export function applyQualificationLedger(manifest, ledger, context) {
  return {
    ...manifest,
    schema: 'vfx-runtime-artifact-manifest@3',
    effects: manifest.effects.map((entry) => {
      const record = ledger.effects[entry.id];
      const disposition = dispositionFor(record, context, entry.sha256);
      const next = { ...entry, disposition };
      if (record?.failure) next.failure = record.failure;
      else delete next.failure;
      if (disposition === 'qualified') {
        next.qualification = {
          thinPlayer: record.evidence?.thinPlayer === true,
          captureTimes: Array.isArray(record.evidence?.captureTimes)
            ? record.evidence.captureTimes
            : [],
          changedPixels: record.evidence?.changedPixels,
          maxChannelDelta: record.evidence?.maxChannelDelta,
          updatedAt: record.evidence?.updatedAt,
        };
      } else {
        delete next.qualification;
      }
      return next;
    }),
  };
}

export function recordQualification(ledger, ids, disposition, context, extraEvidence = {}) {
  const updatedAt = new Date().toISOString();
  for (const id of ids) {
    const existing = ledger.effects[id];
    // Evidence strength is monotonic inside one compiler/oracle context: a
    // thick-path rerun must not erase a stronger thin-player qualification.
    if (disposition === 'qualified'
      && existing?.disposition === 'qualified'
      && existing.evidence?.corpusSha256 === context.corpusSha256
      && existing.evidence?.oracleSha256 === context.oracleSha256
      && existing.evidence?.runtimeFingerprint === context.runtimeFingerprint
      && existing.evidence?.thinPlayer === true
      && extraEvidence.thinPlayer !== true) continue;
    ledger.effects[id] = {
      disposition,
      evidence: {
        corpusSha256: context.corpusSha256,
        oracleSha256: context.oracleSha256,
        runtimeFingerprint: context.runtimeFingerprint,
        updatedAt,
        ...extraEvidence,
      },
      ...(disposition === 'failed' ? { failure: extraEvidence.failure ?? 'fixed-seed-pixel-regression' } : {}),
    };
  }
  return ledger;
}
