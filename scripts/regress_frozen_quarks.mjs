import { chromium } from 'playwright';
import sharp from 'sharp';

const ids = process.argv.slice(2);
if (!ids.length) throw new Error('Usage: npm run regression:frozen-quarks -- <effect-id> [...]');
const origin = process.env.VFX_ORIGIN ?? 'http://127.0.0.1:5174';
const browser = await chromium.launch({ headless: true });
let failed = false;

for (const id of ids) {
  const base = `${origin}/?candidate=1&effect=${encodeURIComponent(id)}&freeze=0.25&post=0&regression=1`;
  const files = [];
  for (const [kind, suffix] of [['live', ''], ['frozen', '&frozen=1']]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(base + suffix, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Frozen'), null, { timeout: 30_000 });
    const file = `/tmp/frozen-quarks-${id}-${kind}.png`;
    await page.screenshot({ path: file });
    files.push(file);
    if (errors.length) throw new Error(`${id}/${kind}: ${errors.join('\n')}`);
    await page.close();
  }
  const live = await sharp(files[0]).raw().toBuffer();
  const frozen = await sharp(files[1]).raw().toBuffer();
  let changed = 0;
  let maximum = 0;
  for (let index = 0; index < live.length; index++) {
    const difference = Math.abs(live[index] - frozen[index]);
    if (difference) changed++;
    maximum = Math.max(maximum, difference);
  }
  const exact = changed === 0;
  failed ||= !exact;
  console.log(`${exact ? 'PASS' : 'FAIL'} ${id}: changed=${changed}, max=${maximum}`);
}

await browser.close();
if (failed) process.exitCode = 1;
