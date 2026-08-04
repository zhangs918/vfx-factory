import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(
  path.join(root, 'public/assets/quarks/manifest.candidates.json'), 'utf8',
));
const requestedEffects = process.argv.find((arg) => arg.startsWith('--effects='))
  ?.slice('--effects='.length).split(',').map((value) => value.trim()).filter(Boolean);
const limitArg = Number(process.argv.find((arg) => arg.startsWith('--limit='))
  ?.slice('--limit='.length));
// Exporters may preserve the candidate manifest with either the historical
// `Cartoon FX/...` note or the newer `existing strict candidate` annotation.
// Both are candidate assets and must participate in the same regression set.
let effects = (manifest.effects ?? [])
  .filter((entry) => {
    const note = String(entry.note ?? '');
    return note.startsWith('Cartoon FX/')
      || note.includes('strict candidate')
      || note === 'existing';
  });
if (requestedEffects?.length) {
  const requested = new Set(requestedEffects);
  effects = effects.filter((entry) => requested.has(entry.id));
  const missing = requestedEffects.filter((id) => !effects.some((entry) => entry.id === id));
  if (missing.length) throw new Error(`Unknown candidate effect(s): ${missing.join(', ')}`);
}
if (Number.isInteger(limitArg) && limitArg > 0) effects = effects.slice(0, limitArg);
if (effects.length > 5 && !process.argv.includes('--allow-large-batch')) {
  throw new Error(`Refusing unbounded visual regression of ${effects.length} effects; select --effects or --limit<=5`);
}
const times = process.argv.find((arg) => arg.startsWith('--times='));
const requestedTimes = times?.slice('--times='.length).split(',').map(Number).filter(Number.isFinite);
const baseUrl = process.env.VFX_URL ?? 'http://127.0.0.1:5173';
const summary = [];

function legalTimes(entry) {
  const oracle = JSON.parse(fs.readFileSync(
    path.join(root, 'public/assets/quarks/oracles', path.basename(entry.file)), 'utf8',
  ));
  const available = oracle.vfxIR?.captureTimes ?? [];
  if (!requestedTimes?.length) return available;
  return [...new Set(requestedTimes.map((target) => available.reduce((best, candidate) =>
    Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best, available[0])))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function run(entry, captureTimes) {
  return new Promise((resolve) => {
    const args = [path.join(root, 'scripts/compare_live_to_oracle.mjs'), `--effect=${entry.id}`];
    if (captureTimes.length) args.push(`--times=${captureTimes.join(',')}`);
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, VFX_URL: baseUrl },
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

for (let index = 0; index < effects.length; index++) {
  const entry = effects[index];
  const reportFile = path.join(root, 'tmp-oracle-comparison', entry.id, 'report.json');
  fs.rmSync(reportFile, { force: true });
  const captureTimes = legalTimes(entry);
  const code = await run(entry, captureTimes);
  let report;
  try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch {}
  const checks = [
    ...(report?.frames ?? []),
    ...(report?.layers ?? []).flatMap((layer) => layer.frames ?? []),
  ].filter((check) => check.liveBounds?.some(Boolean) || check.oracleBounds?.some(Boolean));
  const worstF1 = checks.length ? Math.min(...checks.map((check) => check.silhouetteF1Within4px)) : 1;
  const result = {
    id: entry.id,
    passed: code === 0 && report?.passed === true,
    worstF1,
    failedChecks: checks.filter((check) => !(check.liveArea < 64 && check.oracleArea < 64
        && check.liveMaxDelta <= 32 && check.oracleMaxDelta <= 32) && (check.silhouetteF1Within4px < 0.65
      || check.areaRatio < 0.65 || check.areaRatio > 1.55
      || check.energyRatio < 0.5 || check.energyRatio > 2
      || !check.placementPassed)).length,
    captureTimes,
  };
  summary.push(result);
  console.log(`[${index + 1}/${effects.length}] ${entry.id}: ${result.passed ? 'PASS' : 'FAIL'} f1=${worstF1.toFixed(3)} checks=${result.failedChecks}`);
}

const output = {
  schema: 'candidate-oracle-regression-summary@1',
  times: times?.slice('--times='.length) ?? 'all',
  passed: summary.filter((entry) => entry.passed).length,
  failed: summary.filter((entry) => !entry.passed).length,
  effects: summary,
};
fs.mkdirSync(path.join(root, 'tmp-oracle-comparison'), { recursive: true });
fs.writeFileSync(path.join(root, 'tmp-oracle-comparison/summary.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Summary: ${output.passed}/${summary.length} passed; ${output.failed} failed.`);
if (output.failed) process.exitCode = 1;
