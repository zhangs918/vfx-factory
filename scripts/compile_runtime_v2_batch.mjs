import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifestArg = process.argv.find((arg) => arg.startsWith('--manifest='))?.slice('--manifest='.length)
  ?? 'public/assets/quarks/manifest.json';
const outputArg = process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'public/assets/runtime-v2';
const manifestPath = path.resolve(root, manifestArg);
const outputDir = path.resolve(root, outputArg);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
await mkdir(outputDir, { recursive: true });

function safeName(id) { return String(id).replace(/[^a-zA-Z0-9._-]+/g, '_'); }
function runCompiler(source, target) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/compile_runtime_v2.ts', source, target], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

const effects = [];
for (const entry of manifest.effects ?? []) {
  const source = path.resolve(root, 'public/assets/quarks', entry.file);
  const file = `${safeName(entry.id)}.runtime.json`;
  const target = path.join(outputDir, file);
  const result = await runCompiler(source, target);
  const ok = result.code === 0;
  effects.push({
    id: entry.id,
    label: entry.label,
    source: entry.file,
    artifact: ok ? file : undefined,
    status: ok ? 'compiled' : 'rejected',
    diagnostics: ok ? [] : result.output.split('\n').filter(Boolean).slice(-20),
  });
  console.log(`${ok ? 'COMPILED' : 'REJECTED'} ${entry.id}`);
}

const report = {
  schema: 'vfx-runtime-v2-manifest@1',
  compiler: 'unity-vfx-compiler@0.2',
  sourceManifest: manifestArg,
  effects,
};
await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
const rejected = effects.filter((effect) => effect.status !== 'compiled');
console.log(`Runtime v2 batch: ${effects.length - rejected.length}/${effects.length} compiled.`);
if (rejected.length) process.exitCode = 1;
