import { readFile } from 'node:fs/promises';
import {
  atomicWriteJson,
  applyQualificationLedger,
  currentQualificationContext,
  loadQualificationLedger,
} from './lib/runtime_v3_qualification.mjs';
import path from 'node:path';
const artifactDir = process.env.VFX_V3_ARTIFACT_DIR
  ? path.resolve(process.env.VFX_V3_ARTIFACT_DIR)
  : path.resolve('public/assets/v3-artifacts');
const manifestPath = path.join(artifactDir, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const ledger = await loadQualificationLedger();
const context = await currentQualificationContext();
const restored = applyQualificationLedger(manifest, ledger, context);
await atomicWriteJson(manifestPath, restored);
const counts = restored.effects.reduce((result, entry) => {
  result[entry.disposition] = (result[entry.disposition] ?? 0) + 1;
  return result;
}, {});
console.log(`restored runtime-v3 qualification ${JSON.stringify(counts)}`);
