/**
 * Static import-graph gate: ArtifactQuarksPlayer must not pull production CFXR
 * bridge / runtime-state maps. Run without a built dist/.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('packages/vfx-web-runtime/src');
const start = path.join(root, 'artifact-quarks-player.ts');
const forbidden = [
  'cfxr-runtime-state',
  'cfxr-before-batch-full',
  'cfxr-after-batch',
  'cfxr-full-inject',
  'cfxr-slim-inject',
  'cfxr-ubershader-fragment',
  'cfxr-inject-defines',
  'cfxr-inject-uniforms',
  'cfxr-texture-cache',
  'cfxr-dual-path-vertex',
  'cfxr-props-from-json',
  'cfxr-simulation-mounts',
  'cfxr-mount-policy',
  'cfxr-host-effect-time',
  'cfxr-scene-inputs',
  'cfxr-material-profile',
  'cfxr-blend-state',
  'cfxr-constant-uniforms',
  'QuarksEffectPlayer',
  'cfxrQuarksFidelity',
];
const required = [
  'cfxr-emitter-mount-core',
  'cfxr-sim-initial',
  'artifact-emitter-sim',
  'cfxr-blend-apply',
  'cfxr-constant-uniforms-apply',
  'batch-stepper',
];

const seen = new Set();
const queue = [start];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const match of src.matchAll(/from '\.\/([^']+)'/g)) {
    let rel = path.join(root, match[1]);
    if (!rel.endsWith('.ts')) rel += '.ts';
    if (existsSync(rel)) queue.push(rel);
  }
}

const names = [...seen].map((file) => path.basename(file, '.ts'));
const hits = names.filter((name) => forbidden.includes(name));
const missing = required.filter((name) => !names.includes(name));

if (hits.length || missing.length) {
  const lines = [];
  if (hits.length) lines.push(`forbidden:\n${hits.map((h) => `  ${h}`).join('\n')}`);
  if (missing.length) lines.push(`missing required:\n${missing.map((h) => `  ${h}`).join('\n')}`);
  console.error(`Thin player import graph gate failed:\n${lines.join('\n')}`);
  process.exit(1);
}

console.log(`Thin player import graph OK (${seen.size} modules, no forbidden hits)`);
