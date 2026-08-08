#!/usr/bin/env node
/**
 * Bind an explicit human visual approval to the current runtime/corpus/oracle
 * context for every captured effect in the production manifest.
 *
 * This is intentionally separate from pixel qualification: it never invents
 * changedPixels/maxChannelDelta evidence.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentQualificationContext } from './lib/runtime_v3_qualification.mjs';

const root = process.cwd();
if (!process.argv.includes('--all') || process.env.VFX_MANUAL_APPROVAL !== '1') {
  throw new Error(
    'Manual approval requires --all and VFX_MANUAL_APPROVAL=1 (explicit human authorization)',
  );
}
const approvedBy = String(process.env.VFX_MANUAL_APPROVED_BY ?? '').trim();
if (!approvedBy) throw new Error('VFX_MANUAL_APPROVED_BY is required');
const note = String(process.env.VFX_MANUAL_APPROVAL_NOTE ?? '').trim();
const approvedAt = new Date().toISOString();
const captureDir = path.join(root, 'tmp/material-captures');
const manifest = JSON.parse(await readFile(
  path.join(root, 'public/assets/v3-artifacts/manifest.json'),
  'utf8',
));
const wanted = new Set((manifest.effects ?? []).map((entry) => String(entry.id)));
const captures = new Map();
for (const name of await readdir(captureDir)) {
  if (!name.endsWith('.json')) continue;
  const file = path.join(captureDir, name);
  try {
    const capture = JSON.parse(await readFile(file, 'utf8'));
    if (capture.schema === 'vfx-live-material-capture@1' && wanted.has(capture.effectId)) {
      captures.set(capture.effectId, { file, capture });
    }
  } catch {
    // Ignore unrelated or partial diagnostic files.
  }
}
const missing = [...wanted].filter((id) => !captures.has(id));
if (missing.length) {
  throw new Error(`Manual approval missing ${missing.length} captures: ${missing.slice(0, 12).join(', ')}`);
}

const context = await currentQualificationContext(root);
const digestPayload = (capture) => {
  const { qualification: _qualification, ...payload } = capture;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};
for (const id of [...wanted].sort()) {
  const { file, capture } = captures.get(id);
  capture.runtimeFingerprint = context.runtimeFingerprint;
  const capturePayloadSha256 = digestPayload(capture);
  capture.qualification = {
    schema: 'vfx-capture-qualification@1',
    status: 'manual-qualified',
    runtimeFingerprint: context.runtimeFingerprint,
    corpusSha256: context.corpusSha256,
    oracleSha256: context.oracleSha256,
    capturePayloadSha256,
    manualApproval: {
      schema: 'vfx-manual-visual-approval@1',
      approvedAt,
      approvedBy,
      ...(note ? { note } : {}),
    },
  };
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(capture, null, 2)}\n`);
  await rename(temporary, file);
}
console.log(
  `MANUAL_CAPTURE_APPROVAL_OK effects=${wanted.size} approvedBy=${approvedBy} `
  + `runtime=${context.runtimeFingerprint}`,
);
