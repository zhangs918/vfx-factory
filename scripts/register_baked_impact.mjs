import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const oracle = path.join(root, 'public/assets/quarks/oracles/Impact.json');
if (!fs.existsSync(oracle)) throw new Error(`Missing baked comparison oracle: ${oracle}`);
const json = JSON.parse(fs.readFileSync(oracle, 'utf8'));
if (json.vfxIR?.representation !== 'camera-baked@1') throw new Error('Impact oracle has the wrong representation');
process.stdout.write(`Oracle ready: ${path.relative(root, oracle)}\n`);
