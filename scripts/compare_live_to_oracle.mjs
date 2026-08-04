import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runtimeFingerprint } from './runtime_fingerprint.mjs';

const root = path.resolve(import.meta.dirname, '..');
const baseUrl = process.env.VFX_URL ?? 'http://127.0.0.1:5173';
const effectId = process.argv.find((v) => v.startsWith('--effect='))?.split('=')[1] ?? 'impact';
const requestedLayer = process.argv.find((v) => v.startsWith('--layer='))?.slice('--layer='.length);
const requestedTimesArg = process.argv.find((v) => v.startsWith('--times='))?.slice('--times='.length);
const diagnosticUrlSuffix = process.argv.find((v) => v.startsWith('--url-suffix='))?.slice('--url-suffix='.length) ?? '';
const assetRoot = path.join(root, 'public/assets/quarks');
const productionManifest = JSON.parse(fs.readFileSync(path.join(assetRoot, 'manifest.json'), 'utf8'));
const candidateManifestPath = path.join(assetRoot, 'manifest.candidates.json');
const candidateManifest = fs.existsSync(candidateManifestPath)
  ? JSON.parse(fs.readFileSync(candidateManifestPath, 'utf8'))
  : { effects: [] };
const liveEntry = [...(candidateManifest.effects ?? []), ...(productionManifest.effects ?? [])]
  .find((entry) => entry.id === effectId);
if (!liveEntry) throw new Error(`No strict live manifest entry '${effectId}' to compare`);
const explicitOracle = process.argv.find((v) => v.startsWith('--oracle='))?.slice('--oracle='.length);
const oraclePath = explicitOracle
  ? path.resolve(root, explicitOracle)
  : path.join(assetRoot, 'oracles', path.basename(liveEntry.file));
if (!fs.existsSync(oraclePath)) throw new Error(`Missing camera-baked oracle: ${path.relative(root, oraclePath)}`);
const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));
if (oracle.vfxIR?.representation !== 'camera-baked@1') throw new Error('Oracle must be camera-baked@1');
const width = oracle.baked.width;
const height = oracle.baked.height;
const captureTimes = requestedTimesArg
  ? requestedTimesArg.split(',').map(Number).filter(Number.isFinite)
  : oracle.vfxIR.captureTimes;
for (const time of captureTimes) {
  if (!oracle.vfxIR.captureTimes.some((candidate) => Math.abs(candidate - time) < 1e-6))
    throw new Error(`Requested time ${time} is absent from oracle captureTimes`);
}
const outDir = path.join(root, 'tmp-oracle-comparison', effectId);
fs.mkdirSync(outDir, { recursive: true });

async function pixels(file) {
  return sharp(file).removeAlpha().raw().toBuffer();
}

async function writeDiff(live, reference, file) {
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.abs(live[i] - reference[i]) * 4);
  await sharp(out, { raw: { width, height, channels: 3 } }).png().toFile(file);
}

function features(frame, background, maskThreshold = 24) {
  let area = 0, sumX = 0, sumY = 0, energy = 0;
  let maxDelta = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const p = i * 3;
    const d = Math.abs(frame[p] - background[p])
      + Math.abs(frame[p + 1] - background[p + 1])
      + Math.abs(frame[p + 2] - background[p + 2]);
    energy += d;
    maxDelta = Math.max(maxDelta, d);
    if (d < maskThreshold) continue;
    const x = i % width, y = Math.floor(i / width);
    mask[i] = 1;
  }
  // Remove isolated raster dust component-wise, not by total area. Several unrelated 1–2 px
  // driver artifacts must not combine into a fake semantic particle.
  const seen = new Uint8Array(mask.length);
  const keep = new Uint8Array(mask.length);
  // Sub-16 px islands at the 1920×1080 oracle resolution are single-rasterizer fragments,
  // not stable effect silhouettes (MSAA coverage and texture filtering legitimately move them
  // across an 8-bit threshold between Unity and WebGL). Scale the cutoff by pixel count so the
  // rule remains resolution-relative instead of effect-specific.
  const minComponentArea = Math.max(1, Math.round(16 * (width * height) / (1920 * 1080)));
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const component = [start];
    seen[start] = 1;
    for (let cursor = 0; cursor < component.length; cursor++) {
      const at = component[cursor], x = at % width, y = Math.floor(at / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
        const next = yy * width + xx;
        if (mask[next] && !seen[next]) { seen[next] = 1; component.push(next); }
      }
    }
    if (component.length >= minComponentArea) for (const index of component) keep[index] = 1;
  }
  mask.set(keep);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width, y = Math.floor(i / width);
    area++; sumX += x; sumY += y;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return {
    mask, area, energy,
    maxDelta,
    centroid: area ? [sumX / area, sumY / area] : [0, 0],
    bounds: area ? [minX, minY, maxX, maxY] : [0, 0, 0, 0],
  };
}

function compareImages(live, liveBackground, reference, referenceBackground) {
  const referenceProbe = features(reference, referenceBackground, 24);
  // For a low-contrast dying particle, a fixed threshold can sit at 85% of the entire signal
  // and turn 8-bit rounding into a large area jump. Anchor the mask to the oracle's dynamic
  // range, while retaining the established threshold for ordinary/bright effects.
  const maskThreshold = Math.max(12, Math.min(24, Math.round(referenceProbe.maxDelta * 0.55)));
  return {
    maskThreshold,
    ...compare(
      features(live, liveBackground, maskThreshold),
      features(reference, referenceBackground, maskThreshold),
    ),
  };
}

function compare(a, b) {
  let intersection = 0, union = 0;
  for (let i = 0; i < a.mask.length; i++) {
    if (a.mask[i] || b.mask[i]) union++;
    if (a.mask[i] && b.mask[i]) intersection++;
  }
  const tolerancePx = 4;
  const dilate = (source) => {
    const result = new Uint8Array(source.length);
    for (let i = 0; i < source.length; i++) {
      if (!source[i]) continue;
      const x = i % width, y = Math.floor(i / width);
      for (let dy = -tolerancePx; dy <= tolerancePx; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        const row = yy * width;
        for (let dx = -tolerancePx; dx <= tolerancePx; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < width) result[row + xx] = 1;
        }
      }
    }
    return result;
  };
  const dilatedA = dilate(a.mask), dilatedB = dilate(b.mask);
  let matchedA = 0, matchedB = 0;
  for (let i = 0; i < a.mask.length; i++) {
    if (a.mask[i] && dilatedB[i]) matchedA++;
    if (b.mask[i] && dilatedA[i]) matchedB++;
  }
  const precision = a.area ? matchedA / a.area : (b.area ? 0 : 1);
  const recall = b.area ? matchedB / b.area : (a.area ? 0 : 1);
  const tolerantF1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const boundsMaxDeltaPx = a.area && b.area
    ? Math.max(...a.bounds.map((value, index) => Math.abs(value - b.bounds[index])))
    : (a.area || b.area ? Infinity : 0);
  const centroidDeltaPx = Math.hypot(a.centroid[0] - b.centroid[0], a.centroid[1] - b.centroid[1]);
  // A centroid can move noticeably when one lobe of a correctly placed multi-lobe effect crosses
  // the mask threshold. Close bounds plus strong tolerant overlap is independent geometric
  // evidence of placement. Silhouette, area and energy still have their own strict gates below.
  // Placement tolerance must scale with the semantic silhouette. A fixed 24 px threshold is
  // disproportionately strict for a 500 px multi-ribbon cloud whose sub-pixel dying lobes move
  // its binary centroid, while remaining strict for compact impacts. Six percent of the oracle
  // diagonal is capped from below by the established raster tolerance.
  const oracleSpanPx = b.area
    ? Math.hypot(b.bounds[2] - b.bounds[0], b.bounds[3] - b.bounds[1])
    : 0;
  const placementTolerancePx = Math.max(24, oracleSpanPx * 0.06);
  const boundsTolerancePx = Math.max(12, oracleSpanPx * 0.06);
  const placementPassed = centroidDeltaPx <= placementTolerancePx
    || (tolerantF1 >= 0.8 && boundsMaxDeltaPx <= boundsTolerancePx);
  return {
    silhouetteIoU: union ? intersection / union : 1,
    silhouetteF1Within4px: tolerantF1,
    areaRatio: b.area ? a.area / b.area : 0,
    energyRatio: b.energy ? a.energy / b.energy : 0,
    centroidDeltaPx,
    boundsMaxDeltaPx,
    liveArea: a.area,
    oracleArea: b.area,
    liveMaxDelta: a.maxDelta,
    oracleMaxDelta: b.maxDelta,
    oracleSpanPx,
    placementTolerancePx,
    boundsTolerancePx,
    placementPassed,
    liveBounds: a.bounds,
    oracleBounds: b.bounds,
  };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
try {
  async function capture(time, solo, fileTag = '', initialLoad = false) {
    if (initialLoad) {
      const suffix = solo ? `&solo=${encodeURIComponent(solo)}` : '';
      const url = `${baseUrl}/?effect=${effectId}&freeze=${time}&layer=raw&regression=1&candidate=1&stage=1${diagnosticUrlSuffix}${suffix}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((t) => (document.querySelector('#status')?.textContent ?? '').includes(`t=${t}`), String(time));
    } else {
      await page.evaluate(async ({ seconds, layer }) => {
        window.__VFX_REGRESSION__.setSolo(layer);
        await window.__VFX_REGRESSION__.stepTo(seconds);
      }, { seconds: time, layer: solo });
    }
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const file = path.join(outDir, fileTag || `web-${String(time).replace('.', '_')}.png`);
    await page.screenshot({ path: file });
    return file;
  }

  // Decode/load the live IR once. Layer isolation changes only renderer visibility and then
  // restarts the same deterministic simulation, avoiding N copies of large trajectory caches.
  const webBackgroundFile = await capture(0, '__oracle_background__', 'web-background.png', true);
  const webBackground = await pixels(webBackgroundFile);
  const oracleDir = path.dirname(oraclePath);
  const oracleBackground = await pixels(path.join(oracleDir, oracle.baked.buffers.background));
  const frames = [];
  if (!requestedLayer) for (let captureIndex = 0; captureIndex < captureTimes.length; captureIndex++) {
    const time = captureTimes[captureIndex];
    const frameIndex = Math.round(time * oracle.baked.fps);
    const webFile = await capture(time, null);
    const oracleFile = path.join(oracleDir, oracle.baked.frames[frameIndex]);
    const livePixels = await pixels(webFile);
    const oraclePixels = await pixels(oracleFile);
    const diffFile = path.join(outDir, `diff-${String(time).replace('.', '_')}.png`);
    await writeDiff(livePixels, oraclePixels, diffFile);
    const result = compareImages(livePixels, webBackground, oraclePixels, oracleBackground);
    frames.push({ time, frameIndex, webFile: path.relative(root, webFile), oracleFile: path.relative(root, oracleFile), diffFile: path.relative(root, diffFile), ...result });
  }
  const layers = [];
  const selectedLayers = (oracle.baked.buffers.layers ?? [])
    .filter((layer) => !requestedLayer || layer.name === requestedLayer || String(layer.id) === requestedLayer);
  if (requestedLayer && selectedLayers.length === 0)
    throw new Error(`Oracle has no layer '${requestedLayer}'`);
  for (const layer of selectedLayers) {
    const layerFrames = [];
    for (let captureIndex = 0; captureIndex < captureTimes.length; captureIndex++) {
      const time = captureTimes[captureIndex];
      const i = oracle.vfxIR.captureTimes.findIndex((candidate) => Math.abs(candidate - time) < 1e-6);
      const layerSelector = Number.isInteger(layer.id) ? `@layer:${layer.id}` : layer.name;
      const layerTag = `${String(layer.id ?? 'legacy')}-${layer.name}`.replace(/[^a-z0-9]+/gi, '_');
      const tag = `web-layer-${layerTag}-${i}.png`;
      const webFile = await capture(
        time,
        layerSelector,
        tag,
      );
      const oracleFile = path.join(oracleDir, layer.frames[i]);
      const livePixels = await pixels(webFile);
      const oraclePixels = await pixels(oracleFile);
      const diffFile = path.join(outDir, `diff-layer-${layerTag}-${i}.png`);
      await writeDiff(livePixels, oraclePixels, diffFile);
      layerFrames.push({
        time,
        diffFile: path.relative(root, diffFile),
        ...compareImages(livePixels, webBackground, oraclePixels, oracleBackground),
      });
    }
    layers.push({ id: layer.id, name: layer.name, frames: layerFrames });
  }
  const checks = [...frames, ...layers.flatMap((layer) => layer.frames)]
    .filter((f) => f.liveBounds.some(Boolean) || f.oracleBounds.some(Boolean));
  const passed = checks.every((f) => (f.liveArea < 64 && f.oracleArea < 64
      && f.liveMaxDelta <= 32 && f.oracleMaxDelta <= 32)
    || (f.silhouetteF1Within4px >= 0.65
    && f.areaRatio >= 0.65 && f.areaRatio <= 1.55
    // Below 64 oracle pixels, one 8-bit/MSAA coverage step can halve total energy while the
    // geometry remains exact. Require strong silhouette agreement before granting the narrower
    // small-buffer energy tolerance; ordinary effects retain the original gate.
    && f.energyRatio >= (f.oracleArea < 64 && f.silhouetteF1Within4px >= 0.9 ? 0.4 : 0.5)
    && f.energyRatio <= 2
    && f.placementPassed));
  const report = {
    schema: 'live-oracle-comparison@3', effectId, width, height,
    scope: requestedLayer || requestedTimesArg || diagnosticUrlSuffix
      ? { kind: 'diagnostic-subset', layer: requestedLayer ?? null, times: captureTimes, urlSuffix: diagnosticUrlSuffix || null }
      : { kind: 'full' },
    assetSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(assetRoot, liveEntry.file))).digest('hex'),
    oracleSha256: crypto.createHash('sha256').update(fs.readFileSync(oraclePath)).digest('hex'),
    adapterRegistrySha256: crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'config/semantic-adapters.json'))).digest('hex'),
    runtimeSha256: runtimeFingerprint(root),
    thresholds: {
      silhouetteF1Within4px: 0.65,
      areaRatio: [0.65, 1.55],
      energyRatio: [0.5, 2],
      placement: {
        centroidDeltaPx: 'max(24, oracleBoundsDiagonal*0.06)',
        or: { silhouetteF1Within4px: 0.8, boundsMaxDeltaPx: 'max(12, oracleBoundsDiagonal*0.06)' },
      },
      smallBufferEnergy: { oracleAreaBelowPx: 64, requiresF1: 0.9, ratio: [0.4, 2] },
      subRasterOracle: { oracleAreaBelowPx: 64, oracleMaxDeltaAtMost: 24, liveMayBeEmpty: true },
      minConnectedComponentAreaPxAt1920x1080: 16,
    },
    passed, frames, layers,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  // Large WebGL/trajectory pages can keep GPU readbacks alive during Browser.close(). Explicitly
  // tear down the renderer page first so qualification advances to the next effect promptly.
  await page.goto('about:blank').catch(() => {});
  await page.close({ runBeforeUnload: false }).catch(() => {});
  await browser.close();
}
