import { chromium } from 'playwright';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_REGRESSION_REPORT,
  REGRESSION_REPORT_SCHEMA,
} from './lib/runtime_v3_regression_report.mjs';
import { runtimeFingerprint } from './runtime_fingerprint.mjs';

const ids = process.argv.slice(2);
if (!ids.length) throw new Error('Usage: npm run regression:runtime-v3 -- <effect-id> [...]');
const origin = process.env.VFX_ORIGIN ?? 'http://127.0.0.1:5174';
const captureTimes = (process.env.VFX_CAPTURE_TIMES ?? '0.25')
  .split(',').map(Number).filter(Number.isFinite);
if (!captureTimes.length) throw new Error('VFX_CAPTURE_TIMES must contain at least one finite number.');
const reportPath = process.env.VFX_REGRESSION_REPORT ?? DEFAULT_REGRESSION_REPORT;
const solo = process.env.VFX_SOLO?.trim() ?? '';
const dumpUniforms = process.env.VFX_DUMP_UNIFORMS === '1';
// Thin is the only production path under test. Set VFX_THIN_PLAYER=0 only for
// emergency opt-out (should not be needed after the two-path preview cutover).
const thinPlayer = process.env.VFX_THIN_PLAYER !== '0';
if (process.env.VFX_THIN_PLAYER === '0') {
  console.warn('VFX_THIN_PLAYER=0 disables thin; regression still loads the default thin preview URL');
}

const regressionRuntimeFingerprint = runtimeFingerprint(process.cwd());
const artifactManifest = JSON.parse(await readFile(
  join(process.cwd(), 'public/assets/v3-artifacts/manifest.json'),
  'utf8',
));
const artifactFingerprints = {};
for (const id of ids) {
  const entry = artifactManifest.effects?.find((candidate) => candidate.id === id);
  if (!entry?.file) throw new Error(`No exact runtime-v3 artifact manifest entry for '${id}'`);
  const bytes = await readFile(join(process.cwd(), 'public/assets/v3-artifacts', entry.file));
  artifactFingerprints[id] = createHash('sha256').update(bytes).digest('hex');
}

const results = [];
let failed = false;
let fatalError;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const id of ids) {
    for (const captureTime of captureTimes) {
      const base = `${origin}/?candidate=1&effect=${encodeURIComponent(id)}&freeze=${captureTime}&post=0&regression=1&frozen=1`
        + (solo ? `&solo=${encodeURIComponent(solo)}` : '');
      const files = [];
      // Oracle = legacy source player. Tested side = default thin offline player.
      for (const [kind, suffix] of [['legacy', '&compare=legacy'], ['thin', '']]) {
        let page;
        let lastWaitError;
        for (let attempt = 1; attempt <= 3; attempt++) {
          page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
          const errors = [];
          page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
          page.on('pageerror', (error) => { errors.push(String(error?.message ?? error)); });
          await page.goto(base + suffix, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          try {
            await page.waitForFunction(
              () => document.querySelector('#status')?.textContent?.includes('Frozen'),
              null,
              { timeout: 30_000 },
            );
            const loadedId = await page.evaluate(() => {
              const select = document.querySelector('#effectSelect');
              return select instanceof HTMLSelectElement ? select.value : '';
            });
            if (!loadedId || loadedId.toLowerCase() !== id.toLowerCase()) {
              throw new Error(`${id}/${kind}: loaded effect '${loadedId || '(empty)'}' does not match requested id`);
            }
            if (dumpUniforms) {
              const audit = await page.evaluate(() => {
                const api = window.__VFX_REGRESSION__;
                let materials = null;
                try {
                  materials = typeof api?.dumpLiveMaterialStamp === 'function'
                    ? api.dumpLiveMaterialStamp()
                    : null;
                } catch {}
                return {
                  lifecycle: typeof api?.debugLifecycleState === 'function'
                    ? api.debugLifecycleState()
                    : null,
                  snapshot: typeof api?.snapshot === 'function' ? api.snapshot() : null,
                  materials,
                };
              });
              await writeFile(
                `/tmp/v3-uniforms-${id}-t${captureTime}-${kind}.json`,
                JSON.stringify(audit, null, 2),
              );
            }
            const file = `/tmp/runtime-v3-${id}-t${captureTime}-${kind}.png`;
            await page.screenshot({ path: file });
            files.push(file);
            if (errors.length) throw new Error(`${id}/${kind}: ${errors.join('\n')}`);
            await page.close();
            page = null;
            lastWaitError = null;
            break;
          } catch (waitError) {
            lastWaitError = waitError;
            const dump = await page.evaluate(() => ({
              status: document.querySelector('#status')?.textContent || '',
              effect: document.querySelector('#effectSelect') instanceof HTMLSelectElement
                ? document.querySelector('#effectSelect').value
                : '',
              life: window.__VFX_DEBUG__?.lifecycle ?? null,
              body: (document.body?.innerText || '').slice(0, 600),
            })).catch(() => ({ status: '', effect: '', life: null, body: '' }));
            await page.close().catch(() => {});
            page = null;
            const transient = /Unknown effect id/i.test(String(dump.status))
              || /Unknown effect id/i.test(errors.join('\n'))
              || /Unknown effect id/i.test(String(waitError));
            if (!transient || attempt === 3) {
              console.error(`FROZEN_WAIT_FAIL ${id}/${kind}@${captureTime}`, JSON.stringify({ dump, errors, attempt }, null, 2));
              throw waitError;
            }
            console.warn(`RETRY ${id}/${kind}@${captureTime} attempt=${attempt} reason=catalog-race`);
            await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
          }
        }
        if (lastWaitError) throw lastWaitError;
      }
      const left = await sharp(files[0]).raw().toBuffer();
      const right = await sharp(files[1]).raw().toBuffer();
      let changedPixels = 0;
      let maxChannelDelta = 0;
      for (let index = 0; index < left.length; index++) {
        const difference = Math.abs(left[index] - right[index]);
        if (difference) changedPixels++;
        maxChannelDelta = Math.max(maxChannelDelta, difference);
      }
      const exact = changedPixels === 0;
      failed ||= !exact;
      results.push({
        id,
        captureTime,
        status: exact ? 'PASS' : 'FAIL',
        changedPixels,
        maxChannelDelta,
      });
      console.log(`${exact ? 'PASS' : 'FAIL'} ${id}@${captureTime}: changed=${changedPixels}, max=${maxChannelDelta}`);
    }
  }
} catch (error) {
  failed = true;
  fatalError = error;
} finally {
  await browser?.close().catch(() => {});
  const expectedRows = ids.length * captureTimes.length;
  await writeFile(reportPath, `${JSON.stringify({
    schema: REGRESSION_REPORT_SCHEMA,
    createdAt: new Date().toISOString(),
    runtimeFingerprint: regressionRuntimeFingerprint,
    artifactFingerprints,
    origin,
    thinPlayer,
    captureTimes,
    requestedIds: ids,
    complete: !fatalError && results.length === expectedRows,
    results,
    ...(fatalError ? { harnessError: String(fatalError?.message ?? fatalError) } : {}),
  }, null, 2)}\n`);
  console.log(`REPORT ${reportPath}`);
}

if (fatalError) throw fatalError;
if (failed) process.exitCode = 1;
