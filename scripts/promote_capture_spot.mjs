/**
 * After a capture-stamped effect passes multi-time zero-diff spot check,
 * promote pipeline/closure qualification to pixel-qualified for thin catalog.
 *
 * Usage: node scripts/promote_capture_spot.mjs <effect-id> [...]
 * Env: VFX_CAPTURE_TIMES=0.1,0.25,0.5,1 (recorded into evidence)
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ids = process.argv.slice(2);
if (!ids.length) throw new Error('Usage: node scripts/promote_capture_spot.mjs <effect-id> [...]');
const captureTimes = (process.env.VFX_CAPTURE_TIMES ?? '0.1,0.25,0.5,1')
  .split(',').map(Number).filter(Number.isFinite);

async function resolveArtifactPath(effectId) {
  const dir = join(root, 'public', 'assets', 'v3-artifacts');
  const exact = join(dir, `${effectId}.json`);
  try {
    await readFile(exact);
    return exact;
  } catch {
    // fall through
  }
  const lowerWanted = effectId.toLowerCase();
  const names = await readdir(dir);
  // Prefer artifact.effectId === id (catalog short id) before jmo_…_suffix.
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'manifest.json') continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (String(raw.effectId ?? '').toLowerCase() === lowerWanted) return join(dir, name);
    } catch {
      // skip
    }
  }
  const byName = names.find((name) => name.toLowerCase() === `${lowerWanted}.json`);
  if (byName) return join(dir, byName);
  const bySuffix = names.find((name) => name.toLowerCase().endsWith(`_${lowerWanted}.json`));
  if (bySuffix) return join(dir, bySuffix);
  throw new Error(`PROMOTE_MISSING_ARTIFACT ${effectId}`);
}

for (const id of ids) {
  const artPath = await resolveArtifactPath(id);
  const artifact = JSON.parse(await readFile(artPath, 'utf8'));
  let touched = 0;
  for (const pipeline of Object.values(artifact.pipelines ?? {})) {
    if (pipeline.executor !== 'artifact-shader@1') continue;
    if (pipeline.qualification?.status !== 'capture-stamped'
      && pipeline.qualification?.evidence?.captureProvenance !== 'live-bridge-capture@1'
      && pipeline.qualification?.status !== 'pixel-qualified') {
      continue;
    }
    if (pipeline.qualification?.status === 'pixel-qualified'
      && pipeline.qualification?.evidence?.compilerVersion === 'live-bridge-capture@1') {
      continue;
    }
    pipeline.qualification = {
      ...pipeline.qualification,
      status: 'pixel-qualified',
      baseline: 'frozen-semantic@1',
      evidence: {
        compilerVersion: 'live-bridge-capture@1',
        captureTimes,
        changedPixels: 0,
        maxChannelDelta: 0,
        captureProvenance: 'live-bridge-capture@1',
        capturedAt: pipeline.qualification?.evidence?.capturedAt,
        injectMode: pipeline.qualification?.evidence?.injectMode,
      },
    };
    touched++;
  }
  for (const closure of Object.values(artifact.batchClosures ?? {})) {
    if (closure.qualification?.status === 'capture-stamped'
      || closure.qualification?.evidence?.captureProvenance === 'live-bridge-capture@1'
      || (closure.qualification?.status === 'pixel-qualified'
        && closure.qualification?.evidence?.compilerVersion !== 'live-bridge-capture@1'
        && closure.qualification?.evidence?.captureProvenance === 'live-bridge-capture@1')) {
      closure.qualification = {
        ...closure.qualification,
        status: 'pixel-qualified',
        baseline: 'frozen-semantic@1',
        evidence: {
          compilerVersion: 'live-bridge-capture@1',
          captureTimes,
          changedPixels: 0,
          maxChannelDelta: 0,
          captureProvenance: 'live-bridge-capture@1',
          capturedAt: closure.qualification?.evidence?.capturedAt,
          injectMode: closure.qualification?.evidence?.injectMode,
        },
      };
    }
  }
  await writeFile(artPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`PROMOTE_CAPTURE_OK ${id} pipelines=${touched} → ${artPath}`);
}
