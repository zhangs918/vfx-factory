import fs from 'node:fs/promises';
import path from 'node:path';

function diagnostic(severity, code, message) {
  return { severity, code, path: '$', message };
}

async function main() {
  const [input, output = `${input}.compile.diagnostics.json`] = process.argv.slice(2);
  if (!input) throw new Error('Usage: node scripts/compile_source_check.mjs <source.json> [diagnostics.json]');
  const source = JSON.parse(await fs.readFile(input, 'utf8'));
  const diagnostics = [];
  if (!source?.vfxIR) diagnostics.push(diagnostic('error', 'MISSING_SOURCE_CONTRACT', 'Missing vfxIR contract.'));
  if (!source?.object) diagnostics.push(diagnostic('error', 'MISSING_OBJECT', 'Missing Object3D hierarchy.'));
  if (!Array.isArray(source?.materials)) diagnostics.push(diagnostic('error', 'MISSING_MATERIALS', 'Missing materials.'));
  if (!Array.isArray(source?.textures)) diagnostics.push(diagnostic('error', 'MISSING_TEXTURES', 'Missing textures.'));
  diagnostics.push(diagnostic('info', 'LOWERING_REQUIRED', 'Source is accepted for compiler lowering, but no runtime@2 artifact was emitted.'));
  const report = { schema: 'vfx-source-compile-report@1', input: path.basename(input), diagnostics };
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (diagnostics.some((entry) => entry.severity === 'error')) process.exitCode = 1;
  console.log(`${input}: ${diagnostics.length} diagnostic(s); runtime@2 emission is intentionally gated.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
