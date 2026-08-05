import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { compileSourceJson, serializeRuntimeV2 } from '../packages/unity-vfx-compiler/src/index.ts';

const args = process.argv.slice(2);
const split = args.includes('--split');
const [input, output] = args.filter((arg) => arg !== '--split');
if (!input || !output) {
  console.error('Usage: npm run compile:runtime-v2 -- <source.json> <runtime.json>');
  process.exit(2);
}

const source = JSON.parse(await readFile(resolve(input), 'utf8')) as unknown;
const result = compileSourceJson(source);
for (const diagnostic of result.diagnostics) {
  const stream = diagnostic.severity === 'error' ? console.error : console.warn;
  stream(`[${diagnostic.severity}] ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`);
}
if (!result.artifact || result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
  process.exit(1);
}

const target = resolve(output);
const bundleDir = split ? dirname(target) : '';
const resourceDir = split ? resolve(bundleDir, 'resources') : `${target}.resources`;
await (await import('node:fs/promises')).mkdir(resourceDir, { recursive: true });
const shaderFiles: Record<string, { vertex: string; fragment: string }> = {};
if (split) await (await import('node:fs/promises')).mkdir(resolve(bundleDir, 'shaders'), { recursive: true });
if (split) {
  for (const material of result.artifact.materials) {
    const vertex = `shaders/${material.id}.vert.glsl`;
    const fragment = `shaders/${material.id}.frag.glsl`;
    await writeFile(resolve(bundleDir, vertex), material.vertexShader, 'utf8');
    await writeFile(resolve(bundleDir, fragment), material.fragmentShader, 'utf8');
    shaderFiles[material.id] = { vertex, fragment };
    material.vertexShader = '';
    material.fragmentShader = '';
  }
}
for (const resource of result.artifact.resources) {
  if (resource.kind !== 'texture' || !resource.uri.startsWith('data:')) continue;
  const match = resource.uri.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match) continue;
  const ext = match[1].includes('jpeg') || match[1].includes('jpg') ? 'jpg' : 'png';
  const fileName = `${resource.id}.${ext}`;
  await writeFile(resolve(resourceDir, fileName), Buffer.from(match[2], 'base64'));
  resource.uri = split ? `resources/${fileName}` : `${output.split('/').pop()}.resources/${fileName}`;
  if (split) resource.metadata = undefined;
}
if (split) {
  for (const resource of result.artifact.resources) {
    if (resource.kind !== 'geometry' || !resource.metadata) continue;
    const fileName = `resources/${resource.id}.geometry.json`;
    await writeFile(resolve(bundleDir, fileName), JSON.stringify(resource.metadata), 'utf8');
    resource.metadata = { externalUri: fileName };
  }
  result.artifact.metadata = {
    ...(result.artifact.metadata ?? {}),
    bundle: { version: 1, shaders: shaderFiles },
  };
}
await writeFile(target, serializeRuntimeV2(result.artifact), 'utf8');
console.log(`Wrote ${target} (${result.artifact.systems.length} systems, ${result.artifact.materials.length} materials, ${result.artifact.resources.length} resources).`);
