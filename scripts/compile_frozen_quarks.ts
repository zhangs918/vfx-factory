import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeUnityQuarksJson } from '../packages/vfx-web-runtime/src/quarks-lowering.ts';
import { setCfxrPropsFromJson } from '../packages/vfx-web-runtime/src/cfxr-props-from-json.ts';
import { setDissolveCurvesFromJson } from '../packages/vfx-web-runtime/src/cfxr-custom1-from-json.ts';
import { extractStartDelays } from '../packages/vfx-web-runtime/src/extract-start-delays.ts';
import { exportCfxrRuntimeState } from '../packages/vfx-web-runtime/src/cfxr-runtime-state.ts';
import { compileRuntimeArtifact } from '../packages/unity-vfx-compiler/src/index.ts';

const root = process.cwd();
const sourceRoot = path.join(root, 'public/assets/quarks');
const outputRoot = path.join(root, 'public/assets/frozen-quarks');
const requested = process.argv.slice(2);

const candidateManifest = JSON.parse(await readFile(path.join(sourceRoot, 'manifest.candidates.json'), 'utf8'));
const productionManifest = JSON.parse(await readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
const entries = [...candidateManifest.effects, ...productionManifest.effects]
  .filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index)
  .filter((entry) => requested.length === 0 || requested.includes(entry.id));

if (!entries.length) throw new Error(`No effects matched: ${requested.join(', ')}`);
await mkdir(outputRoot, { recursive: true });
const results: Array<Record<string, unknown>> = [];

for (const entry of entries) {
  try {
    const source = JSON.parse(await readFile(path.join(sourceRoot, entry.file), 'utf8'));
    const payload = structuredClone(source);

  // Preserve the exact order used by the validated live player. These calls compile
  // Unity/ShaderGraph semantics into JSON-safe runtime tables; normalization then lowers
  // renderer coordinates and Quarks configuration without browser participation.
    setCfxrPropsFromJson(payload);
    setDissolveCurvesFromJson(payload);
    normalizeUnityQuarksJson(payload);
    const startDelays = [...extractStartDelays(payload).entries()];
    const cfxrState = exportCfxrRuntimeState();
    const runtimeConfig = {
      startDelays,
      controllers: Array.isArray(payload.controllers) ? payload.controllers : [],
      cfxrEffect: payload.cfxrEffect,
    };
    const webRuntime = compileRuntimeArtifact({
      effectId: source.vfxIR?.effectId ?? entry.id,
      sourceSchema: source.vfxIR?.schema,
      payload,
      cfxrState,
      runtimeConfig,
    });
    const artifact = { vfxIR: source.vfxIR, artifact: source.artifact, webRuntime };
    const target = path.join(outputRoot, entry.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(artifact));
    results.push({ ...entry, status: 'compiled' });
    process.stdout.write(`compiled ${entry.id}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ ...entry, status: 'rejected', error: message });
    process.stderr.write(`rejected ${entry.id}: ${message}\n`);
  }
}

await writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify({ effects: results }, null, 2));
const compiled = results.filter((entry) => entry.status === 'compiled').length;
process.stdout.write(`summary compiled=${compiled} rejected=${results.length - compiled}\n`);
