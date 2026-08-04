/**
 * Deterministic semantic VFX regression capture.
 *
 * Captures the exported reference camera at exact fixed-step times for three layers:
 *   raw      - no tone mapping, no bloom
 *   tonemap  - ACES, no bloom
 *   final    - ACES + bloom
 * It also records complete per-particle state and repeats each capture to prove that
 * the Web simulation is byte-for-byte reproducible within the same renderer.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outRoot = path.join(root, 'tmp-semantic-regression');
const baselineRoot = path.join(root, 'tests/vfx-regression/baselines');
const baseUrl = process.env.VFX_URL ?? 'http://127.0.0.1:5173';
const requested = process.argv.find((a) => a.startsWith('--effect='))?.slice('--effect='.length);
const captureAll = process.argv.includes('--all');
const candidateManifest = process.argv.includes('--candidate');
const updateBaselines = process.argv.includes('--update');
const allowStaleBaseline = process.argv.includes('--allow-stale-baseline');
const layers = ['raw', 'tonemap', 'final'];

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite did not become ready at ${url}`);
}

async function ensureServer() {
  try {
    await waitForServer(baseUrl, 500);
    return null;
  } catch {}
  const child = spawn('npx', ['vite', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(baseUrl);
  return child;
}

async function capture(page, effect, layer, time, suffix, loadLayer) {
  if (loadLayer) {
    const url = `${baseUrl}/?effect=${encodeURIComponent(effect.id)}&freeze=${time}&layer=${layer}&regression=1`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(
      ({ t, layerName }) => {
        const status = document.querySelector('#status')?.textContent ?? '';
        if (status.includes('strict') || status.includes('unsupported') || status.includes('lacks')) throw new Error(status);
        return status.includes(`t=${t}`) && status.includes(`layer=${layerName}`);
      },
      { t: String(time), layerName: layer },
      { timeout: 30_000 },
    );
  } else {
    await page.evaluate((seconds) => window.__VFX_REGRESSION__.stepTo(seconds), time);
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const dir = path.join(outRoot, effect.id, layer);
  fs.mkdirSync(dir, { recursive: true });
  const stem = `t-${String(time).replace('.', '_')}${suffix}`;
  const image = path.join(dir, `${stem}.png`);
  // Capture only the render target. UI copy and status labels are not VFX pixels and
  // must not invalidate visual baselines.
  await page.locator('#c').screenshot({ path: image });
  const state = await page.evaluate(() => window.__VFX_REGRESSION__.snapshot());
  const stateFile = path.join(dir, `${stem}.state.json`);
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return { image, stateFile, state, hash: sha256(image), stem };
}

function compareOrUpdateBaseline(effectId, layer, time, capture) {
  const dir = path.join(baselineRoot, effectId, layer);
  const stem = `t-${String(time).replace('.', '_')}`;
  const image = path.join(dir, `${stem}.png`);
  const state = path.join(dir, `${stem}.state.json`);
  if (updateBaselines) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(capture.image, image);
    fs.copyFileSync(capture.stateFile, state);
    return { status: 'updated', imageEqual: true, stateEqual: true, comparable: true };
  }
  if (!fs.existsSync(image) || !fs.existsSync(state)) {
    return { status: 'missing', imageEqual: false, stateEqual: false, comparable: false };
  }
  let baselineState;
  try { baselineState = JSON.parse(fs.readFileSync(state, 'utf8')); }
  catch { return { status: 'invalid-state', imageEqual: false, stateEqual: false, comparable: false }; }
  const currentState = capture.state;
  if (baselineState.schema !== currentState.schema) {
    return {
      status: 'stale-schema',
      baselineSchema: baselineState.schema,
      currentSchema: currentState.schema,
      imageEqual: false,
      stateEqual: false,
      comparable: false,
    };
  }
  return {
    status: 'compared',
    imageEqual: sha256(image) === capture.hash,
    stateEqual: fs.readFileSync(state, 'utf8') === fs.readFileSync(capture.stateFile, 'utf8'),
    comparable: true,
  };
}

async function main() {
  fs.mkdirSync(outRoot, { recursive: true });
  const server = await ensureServer();
  const manifestName = candidateManifest ? 'manifest.candidates.json' : 'manifest.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/quarks', manifestName), 'utf8'));
  let effects = manifest.effects;
  if (requested) effects = effects.filter((effect) => effect.id === requested);
  else if (!captureAll) effects = effects.slice(0, 1);
  if (!effects.length) throw new Error(`No manifest effect matched '${requested ?? '(first)'}'`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const report = {
    schema: 'semantic-regression-report@1',
    baseUrl,
    baselineMode: updateBaselines ? 'update' : 'compare',
    effects: [],
    deterministic: true,
    unityCountsMatch: true,
    baselineComparable: true,
    baselinesMatch: true,
  };

  try {
    for (const effect of effects) {
      const effectJson = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/quarks', effect.file), 'utf8'));
      if (effectJson.vfxIR?.schema !== 'unity-vfx-ir@1') {
        report.effects.push({ id: effect.id, skipped: 'not a strict unity-vfx-ir@1 export' });
        report.deterministic = false;
        continue;
      }
      const times = effectJson.vfxIR.captureTimes;
      const captures = [];
      const webStateByTime = new Map();
      for (const layer of layers) {
        let loadLayer = true;
        for (const time of times) {
          const first = await capture(page, effect, layer, time, '', loadLayer);
          loadLayer = false;
          if (layer === 'raw') webStateByTime.set(time, first.state);
          const repeat = await capture(page, effect, layer, time, '-repeat', false);
          const stateEqual = JSON.stringify(first.state) === JSON.stringify(repeat.state);
          const imageEqual = first.hash === repeat.hash;
          const baseline = compareOrUpdateBaseline(effect.id, layer, time, first);
          captures.push({
            layer,
            time,
            image: path.relative(root, first.image),
            imageHash: first.hash,
            repeat: { imageEqual, stateEqual },
            baseline,
          });
          if (!stateEqual || !imageEqual) report.deterministic = false;
          if (!baseline.comparable) report.baselineComparable = false;
          if (!baseline.imageEqual || !baseline.stateEqual) report.baselinesMatch = false;
        }
      }
      const unityPath = path.join(root, 'public/assets/quarks/reference-states', `${effect.id}.json`);
      let unityComparison = null;
      if (effectJson.vfxIR.representation === 'camera-baked@1') {
        unityComparison = {
          status: 'not-applicable',
          reason: 'camera-baked@1 is validated by deterministic Unity-rendered image frames, not translated particle counts',
        };
      } else if (fs.existsSync(unityPath)) {
        const unity = JSON.parse(fs.readFileSync(unityPath, 'utf8'));
        unityComparison = times.map((time) => {
          const frame = unity.frames.find((candidate) => Math.abs(candidate.time - time) < 1e-5);
          const web = webStateByTime.get(time);
          const unityCounts = Object.fromEntries((frame?.emitters ?? []).map((e) => [e.path, e.count]));
          const webCounts = Object.fromEntries((web?.emitters ?? []).map((e) => [e.path, e.count]));
          const paths = [...new Set([...Object.keys(unityCounts), ...Object.keys(webCounts)])].sort();
          return {
            time,
            emitters: paths.map((emitterPath) => ({
              path: emitterPath,
              unity: unityCounts[emitterPath] ?? 0,
              web: webCounts[emitterPath] ?? 0,
              delta: (webCounts[emitterPath] ?? 0) - (unityCounts[emitterPath] ?? 0),
            })),
          };
        });
      }
      report.effects.push({
        id: effect.id,
        seed: effectJson.vfxIR.seed,
        fixedDelta: effectJson.vfxIR.fixedDelta,
        captures,
        unityComparison,
      });
      if (unityComparison && unityComparison !== 'not-applicable' && Array.isArray(unityComparison)) {
        for (const frame of unityComparison) {
          if (frame.emitters.some((emitter) => emitter.delta !== 0)) report.unityCountsMatch = false;
        }
      }
    }
  } finally {
    await browser.close();
    if (server) server.kill('SIGTERM');
  }

  fs.writeFileSync(path.join(outRoot, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const baselineFailure = !report.baselineComparable
    ? !allowStaleBaseline
    : !report.baselinesMatch;
  if (!report.deterministic || !report.unityCountsMatch || baselineFailure) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
