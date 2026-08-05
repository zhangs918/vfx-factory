import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { compileSourceJson, serializeRuntimeV2 } from '../packages/unity-vfx-compiler/src/index.ts';

const [input, output] = process.argv.slice(2);
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
const resourceDir = `${target}.resources`;
await (await import('node:fs/promises')).mkdir(resourceDir, { recursive: true });
for (const resource of result.artifact.resources) {
  if (resource.kind !== 'texture' || !resource.uri.startsWith('data:')) continue;
  const match = resource.uri.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match) continue;
  const ext = match[1].includes('jpeg') || match[1].includes('jpg') ? 'jpg' : 'png';
  const fileName = `${resource.id}.${ext}`;
  await writeFile(resolve(resourceDir, fileName), Buffer.from(match[2], 'base64'));
  resource.uri = `${output.split('/').pop()}.resources/${fileName}`;
}
await writeFile(target, serializeRuntimeV2(result.artifact), 'utf8');
console.log(`Wrote ${target} (${result.artifact.systems.length} systems, ${result.artifact.materials.length} materials, ${result.artifact.resources.length} resources).`);
