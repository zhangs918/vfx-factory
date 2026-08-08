import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const runtimeFingerprintRoots = [
  'packages/unity-vfx-compiler/src',
  'packages/vfx-artifact-schema/src',
  'packages/vfx-artifact-schema/index.mjs',
  'packages/vfx-artifact-schema/runtime-v3.mjs',
  'packages/vfx-web-runtime/src',
  // Qualification ledgers are evidence, not executable runtime input. Artifact
  // bytes are fingerprinted separately by the regression harness, so adding
  // evidence for an unrelated family must not invalidate every proven effect.
  'config/semantic-adapters.json',
  'scripts/build_frozen_material_index.ts',
  'scripts/compile_runtime_v3.ts',
  'scripts/extract_v3_resources.ts',
  'scripts/split_runtime_v3_code.mjs',
  'scripts/strip_runtime_v3_embedded.mjs',
  'src/main.ts',
  'vite.config.ts',
  'package.json',
  'package-lock.json',
];

function collectFiles(root, relative) {
  const absolute = path.join(root, relative);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative];
  return fs.readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => collectFiles(root, path.join(relative, entry.name)));
}

/**
 * Fingerprint every checked-in compiler/runtime input that can change WebGL
 * pixels. Directories are expanded in stable path order so adding a new runtime
 * module automatically invalidates old evidence instead of relying on a manual
 * allowlist that can silently miss it.
 */
export function runtimeFingerprint(root) {
  const hash = crypto.createHash('sha256');
  const files = runtimeFingerprintRoots.flatMap((relative) => collectFiles(root, relative)).sort();
  for (const relative of files) {
    hash.update(`${relative}\0`);
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
