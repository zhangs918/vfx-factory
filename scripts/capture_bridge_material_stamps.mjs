/**
 * Thick-path live material capture factory.
 *
 * Loads each effect on QuarksEffectPlayer (v3, not thin), dumps the final
 * GLSL + blend/uniforms/texture bindings after inject/bind, and writes
 * tmp/material-captures/<effectId>.json.
 *
 * This is the production half of offline stamp — not pixel qualification.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFingerprint } from './runtime_fingerprint.mjs';

const ids = process.argv.slice(2);
if (!ids.length) {
  throw new Error('Usage: node scripts/capture_bridge_material_stamps.mjs <effect-id> [...]');
}

const origin = process.env.VFX_ORIGIN ?? 'http://127.0.0.1:5174';
const outDir = process.env.VFX_CAPTURE_OUT ?? join(process.cwd(), 'tmp', 'material-captures');
const freeze = Number(process.env.VFX_CAPTURE_FREEZE ?? '0.25');
const forceBridgeFragment = process.env.VFX_FORCE_BRIDGE_FRAGMENT !== '0';
const captureRuntimeFingerprint = runtimeFingerprint(process.cwd());

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});

let failed = false;
for (const id of ids) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const force = forceBridgeFragment ? '&cfxrFragment=force' : '';
  const url = `${origin}/?candidate=1&effect=${encodeURIComponent(id)}`
    + `&freeze=${freeze}&post=0&regression=1&frozen=1&v3=1${force}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  try {
    await page.waitForFunction(
      () => document.querySelector('#status')?.textContent?.includes('Frozen'),
      null,
      { timeout: 60_000 },
    );
  } catch (waitError) {
    const dump = await page.evaluate(() => ({
      status: document.querySelector('#status')?.textContent || '',
      body: (document.body?.innerText || '').slice(0, 800),
    }));
    console.error(`CAPTURE_FROZEN_FAIL ${id}`, JSON.stringify({ dump, errors }, null, 2));
    failed = true;
    await page.close();
    continue;
  }

  const loadedId = await page.evaluate(() => {
    const select = document.querySelector('#effectSelect');
    return select instanceof HTMLSelectElement ? select.value : '';
  });
  if (!loadedId || loadedId.toLowerCase() !== id.toLowerCase()) {
    console.error(`CAPTURE_ID_MISMATCH ${id}: loaded='${loadedId}'`);
    failed = true;
    await page.close();
    continue;
  }

  const capture = await page.evaluate(() => {
    const api = window.__VFX_REGRESSION__;
    if (typeof api?.dumpLiveMaterialStamp !== 'function') {
      throw new Error('__VFX_REGRESSION__.dumpLiveMaterialStamp missing (thick QuarksEffectPlayer required)');
    }
    return api.dumpLiveMaterialStamp();
  });

  if (!capture?.batches?.length) {
    console.error(`CAPTURE_EMPTY ${id}`);
    failed = true;
    await page.close();
    continue;
  }

  const recordedCapture = {
    ...capture,
    runtimeFingerprint: captureRuntimeFingerprint,
  };
  const outPath = join(outDir, `${id}.json`);
  await writeFile(outPath, `${JSON.stringify(recordedCapture, null, 2)}\n`);
  const modes = [...new Set(capture.batches.map((b) => b.injectMode))].join(',');
  const sizes = capture.batches.map((b) => ({
    batch: b.batchIndex,
    fragBytes: b.fragmentShader.length,
    vertBytes: b.vertexShader.length,
    injectMode: b.injectMode,
    executor: b.artifactExecutor ?? null,
  }));
  console.log(`CAPTURE_OK ${id} → ${outPath} modes=${modes} batches=${JSON.stringify(sizes)}`);
  if (errors.length) {
    console.warn(`CAPTURE_CONSOLE_ERRORS ${id}: ${errors.join(' | ')}`);
  }
  await page.close();
}

await browser.close();
if (failed) process.exitCode = 1;
