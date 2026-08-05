import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const baseUrl = process.env.VFX_URL ?? 'http://127.0.0.1:5173';
const manifestPath = process.env.VFX_RUNTIME_MANIFEST ?? 'public/assets/runtime-v2/manifest.json';
const runtimeRoot = process.env.VFX_RUNTIME_ROOT ?? '/assets/runtime-v2';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const compiled = manifest.effects.filter((effect) => effect.status === 'compiled');
const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  for (const effect of compiled) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => message.type() === 'error' && errors.push(`console: ${message.text()}`));
    const url = new URL(baseUrl);
    url.searchParams.set('runtime', 'v2-artifact');
    url.searchParams.set('artifact', `${runtimeRoot}/${effect.artifact}`);
    url.searchParams.set('freeze', process.env.VFX_FREEZE ?? '0.15');
    url.searchParams.set('post', '0');
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForFunction(() => (document.querySelector('#status')?.textContent ?? '').includes('runtime=v2'), undefined, { timeout: 15_000 });
    const status = await page.locator('#status').textContent();
    if (!status?.includes('Frozen') || errors.length) failures.push(`${effect.id}: ${status ?? 'missing status'} ${errors.join('; ')}`);
    await page.close();
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${compiled.length} runtime@2 artifact playback regression(s).`);
}
