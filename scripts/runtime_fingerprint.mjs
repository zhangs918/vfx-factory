import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const runtimeFingerprintFiles = [
  'src/effects/cfxrQuarksFidelity.ts',
  'src/effects/QuarksEffectPlayer.ts',
  'src/main.ts',
  'package.json',
  'package-lock.json',
];

/** Fingerprint every source/dependency input that can change qualified WebGL pixels. */
export function runtimeFingerprint(root) {
  const hash = crypto.createHash('sha256');
  for (const relative of runtimeFingerprintFiles) {
    const file = path.join(root, relative);
    hash.update(`${relative}\0`);
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
