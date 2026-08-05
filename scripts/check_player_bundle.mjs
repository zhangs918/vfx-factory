import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve('dist/assets');
const files = (await readdir(dist)).filter((file) => file.endsWith('.js'));
const forbidden = [
  'QuarksEffectPlayer',
  'compileLegacyQuarksSource',
  'unity-vfx-compiler',
  'ShaderGraphAnalyzer',
  'three.quarks',
  'cfxrQuarksFidelity',
];
const violations = [];
for (const file of files) {
  const source = await readFile(path.join(dist, file), 'utf8');
  for (const token of forbidden) if (source.includes(token)) violations.push(`${file}: ${token}`);
}
if (violations.length) {
  console.error(`Player bundle dependency gate failed:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log(`Player bundle dependency gate passed (${files.length} JS chunk(s)).`);
