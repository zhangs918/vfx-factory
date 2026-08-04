/**
 * Capture WebGL explosion frames and build side-by-side vs Unity reference.
 * Exit 0 always; writes score + images under tmp-cfxr-compare/
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'tmp-cfxr-compare');
const refPath = path.join(root, 'public/assets/quarks/ref-cfxr3-fire-explosion-b.png');
fs.mkdirSync(outDir, { recursive: true });

const times = [0.08, 0.18, 0.32, 0.5];

function decodePng(file) {
  // minimal PNG via sharp if present, else skip metrics
  try {
    const require = createRequire(import.meta.url);
    const sharp = require('sharp');
    return sharp(file);
  } catch {
    return null;
  }
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`http://localhost:5173/?cmp=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(800);
  // Single restart from t=0, then wall-clock sample (play() restarts if already loaded)
  const shots = [];
  await page.click('#playBtn');
  await page.waitForTimeout(80);
  await page.click('#playBtn');
  const t0 = Date.now();
  for (const t of times) {
    while (Date.now() - t0 < t * 1000) await page.waitForTimeout(16);
    const file = path.join(outDir, `web-t${String(t).replace('.', 'p')}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  }

  // Prefer ~0.18s — matches Unity ref still (bright nested fire + embers); 0.32 is already dissipating
  const mid = shots[1] || shots[2] || shots[0];
  const report = {
    status: await page.textContent('#status'),
    errs: errs.slice(0, 5),
    shots,
    ref: refPath,
    mid,
    notes: [],
  };

  // Side-by-side with sharp if available
  try {
    const require = createRequire(import.meta.url);
    const sharp = require('sharp');
    const ref = sharp(refPath).resize(640, 720, { fit: 'contain', background: '#1a1a1a' });
    const web = sharp(mid).resize(640, 720, { fit: 'cover' });
    const refBuf = await ref.png().toBuffer();
    const webBuf = await web.png().toBuffer();
    await sharp({
      create: { width: 1280, height: 720, channels: 3, background: '#111' },
    })
      .composite([
        { input: refBuf, left: 0, top: 0 },
        { input: webBuf, left: 640, top: 0 },
      ])
      .png()
      .toFile(path.join(outDir, 'side-by-side.png'));

    // Rough metric: mean luminance of non-bg region in web mid frame
    const { data, info } = await sharp(mid)
      .resize(160, 90)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let sum = 0,
      n = 0,
      dark = 0,
      warm = 0;
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      // skip near-black bg / checker-ish
      if (r + g + b < 40) continue;
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += y;
      n++;
      if (y < 80) dark++;
      if (r > g + 20 && r > b + 20) warm++;
    }
    report.metrics = {
      meanLuma: n ? Math.round(sum / n) : 0,
      darkRatio: n ? +(dark / n).toFixed(3) : 0,
      warmRatio: n ? +(warm / n).toFixed(3) : 0,
      sampleN: n,
    };
    // Heuristics vs reference look: want dark smoke (high darkRatio) + warm fire
    report.score = Math.round(
      Math.min(100, report.metrics.darkRatio * 80 + report.metrics.warmRatio * 120),
    );
    report.notes.push(
      `darkRatio=${report.metrics.darkRatio} (want >0.35 charcoal smoke)`,
      `warmRatio=${report.metrics.warmRatio} (want >0.2 orange fire)`,
      `meanLuma=${report.metrics.meanLuma} (smoke-heavy should be mid-low)`,
    );
  } catch (e) {
    report.notes.push('sharp not available: ' + e.message);
    // still copy mid next to ref label file
    fs.copyFileSync(mid, path.join(outDir, 'web-mid.png'));
    fs.copyFileSync(refPath, path.join(outDir, 'ref.png'));
  }

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
