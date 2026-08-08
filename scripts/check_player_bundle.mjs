import { readFile } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve('dist/assets');
const html = await readFile(path.resolve('dist/index.html'), 'utf8');
const entryMatch = html.match(/<script[^>]+src="([^"]+\.js)"/);
if (!entryMatch) throw new Error('Cannot locate production entry chunk in dist/index.html');
const entry = path.basename(entryMatch[1]);
const forbidden = [
  'compileLegacyQuarksSource',
  'unity-vfx-compiler',
  'ShaderGraphAnalyzer',
  // three.quarks is the deliberately retained online render kernel. The gate
  // rejects compiler/lowering/legacy modules, not the renderer itself.
  'cfxrQuarksFidelity',
];
const violations = [];
const visited = new Set();
const staticImports = /(?:from|import)\s*["']\.\/([^"']+\.js)["']/g;
const productionDynamicImports = /import\(\s*[`"']\.\/([^`"']+\.js)[`"']\s*\)/g;
const audit = async (file) => {
  if (visited.has(file)) return;
  visited.add(file);
  const source = await readFile(path.join(dist, file), 'utf8');
  // Names inside `import()` destructuring are allowed: they identify an explicit comparison
  // symbol but do not pull its implementation into the entry chunk. Only static module
  // code/imports are forbidden here; comparison chunks are audited separately by their
  // explicit lazy-boundary naming.
  const staticSource = source.replace(/import\(`[^`]+`\)/g, 'import(`lazy`)');
  for (const token of forbidden) {
    if (new RegExp(`from[\\"'][^\\"']*${token}`).test(staticSource)
        || new RegExp(`(?:class|function)\\s+${token}`).test(staticSource)) {
      violations.push(`${file}: ${token}`);
    }
  }
  for (const match of source.matchAll(staticImports)) await audit(match[1]);
  // Artifact runtime is dynamically loaded in production and must be audited;
  // legacy comparison chunks are intentionally excluded by name.
  for (const match of source.matchAll(productionDynamicImports)) {
    if (!match[1].startsWith('legacy-runtime-')) await audit(match[1]);
  }
};
await audit(entry);
if (violations.length) {
  console.error(`Player bundle dependency gate failed:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log(`Player entry bundle dependency gate passed (${visited.size} static chunk(s); legacy comparison chunks are dynamic and excluded).`);
