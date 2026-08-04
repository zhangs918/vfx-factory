import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const url = process.env.VFX_URL ?? 'http://127.0.0.1:5173';
const limit = Math.max(1, Number(process.env.VFX_LIMIT ?? 3));
const manifestPath = path.join(root, 'public/assets/quarks/manifest.candidates.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const effects = (manifest.effects ?? [])
  .filter((entry) => String(entry.note ?? '').startsWith('Assets/'))
  .slice(0, limit);
if (!effects.length) throw new Error('No candidate effects available for loop validation');

function run(label, command, args, env = {}) {
  console.log(`\n[loop] ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}

run('build', 'npm', ['run', 'build']);
run('production artifact contract', 'npm', ['run', 'validate:artifact-contract']);
run('explicit material IR', 'npm', ['run', 'validate:material-ir'], { VFX_LIMIT: String(limit) });
run('candidate runtime smoke', 'npm', ['run', 'smoke:candidate-runtime'], {
  VFX_LIMIT: String(limit), VFX_NEW_ONLY: '1',
});

let server;
async function reachable() {
  try { return (await fetch(url)).ok; } catch { return false; }
}
if (!(await reachable())) {
  server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], {
    cwd: root,
    env: process.env,
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 40 && !(await reachable()); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 250));
  if (!(await reachable())) throw new Error('Vite server did not become reachable');
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const failures = [];
try {
  for (const entry of effects) {
    const target = new URL(url);
    target.searchParams.set('candidate', '1');
    target.searchParams.set('effect', entry.id);
    target.searchParams.set('freeze', '0.25');
    target.searchParams.set('post', '0');
    target.searchParams.set('regression', '1');
    const errors = [];
    const onError = (message) => errors.push(message.text());
    page.on('console', onError);
    try {
      await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForFunction(() => {
        const text = document.querySelector('#status')?.textContent ?? '';
        return text.includes('t=0.25') || text.startsWith('Error');
      }, undefined, { timeout: 15_000 });
      const status = (await page.locator('#status').textContent())?.trim() ?? '';
      if (!status.includes('t=0.25')) failures.push(`${entry.id}: ${status}`);
      if (errors.some((text) => text.includes('Error') || text.includes('lacks ')))
        failures.push(`${entry.id}: ${errors.join(' | ')}`);
      const canvasCount = await page.locator('canvas').count();
      if (canvasCount !== 1) failures.push(`${entry.id}: expected one WebGL canvas, got ${canvasCount}`);
      console.log(`[loop] screenshot gate PASS ${entry.id} @ t=0.25`);
    } catch (error) {
      failures.push(`${entry.id}: ${error.message}`);
    } finally {
      page.off('console', onError);
    }
  }
} finally {
  await page.close().catch(() => {});
  await browser.close();
  if (server) server.kill('SIGTERM');
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`\n[loop] PASS: ${effects.length} deterministic candidate stage(s) completed`);
}
