import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(
  path.join(root, 'public/assets/quarks/manifest.candidates.json'), 'utf8',
));
const effects = (manifest.effects ?? [])
  .filter((entry) => {
    const note = String(entry.note ?? '');
    return note.startsWith('Cartoon FX/')
      || note.includes('strict candidate')
      || note === 'existing'
      || note === 'Slash'
      || note.startsWith('Slash/')
      || note.startsWith('Assets/');
  });
const limit = Number(process.env.VFX_LIMIT ?? 0);
const newOnly = process.env.VFX_NEW_ONLY === '1';
const pool = newOnly ? effects.filter((entry) => String(entry.note ?? '').startsWith('Assets/')) : effects;
const offset = Math.max(0, Number(process.env.VFX_OFFSET ?? 0));
const selectedEffects = limit > 0 ? pool.slice(offset, offset + limit) : pool.slice(offset);
const baseUrl = process.env.VFX_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const failures = [];
let activeId = '';
page.on('pageerror', (error) => failures.push(`${activeId}: pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // Browser extensions/dev-server transport noise is not an effect failure; renderer and
  // contract errors are. Keep this deliberately narrow and deterministic.
  if (!text.includes('favicon.ico')) failures.push(`${activeId}: console: ${text}`);
});

try {
  for (const entry of selectedEffects) {
    activeId = entry.id;
    const url = new URL(baseUrl);
    url.searchParams.set('candidate', '1');
    url.searchParams.set('effect', entry.id);
    url.searchParams.set('freeze', '0.25');
    url.searchParams.set('post', '0');
    url.searchParams.set('regression', '1');
    try {
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await page.waitForFunction(() => {
        const status = document.querySelector('#status')?.textContent ?? '';
        return status.includes('t=0.25') || status.startsWith('Error');
      }, undefined, { timeout: 10_000 });
      const status = await page.locator('#status').textContent();
      if (!status?.includes('t=0.25')) failures.push(`${entry.id}: ${status ?? 'missing status'}`);
    } catch (error) {
      failures.push(`${entry.id}: timeout/navigation: ${error.message}`);
    }
  }
} finally {
  await page.close({ runBeforeUnload: false }).catch(() => {});
  await browser.close();
}

if (failures.length) {
  console.error([...new Set(failures)].join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Loaded and fixed-stepped ${selectedEffects.length}/${effects.length} selected candidate effect(s).`);
}
