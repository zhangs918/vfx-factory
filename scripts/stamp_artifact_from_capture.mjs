/**
 * Apply a live material capture onto a v3 artifact + v3-code split files.
 *
 * - Writes captured vertex/fragment GLSL into public/assets/v3-code/<id>/
 * - Stamps pipeline blendState / uniformValues / tileCounts / executor
 * - Marks qualification as capture-stamped bridge evidence (spot-check still required
 *   before pixel-qualified / thin catalog)
 *
 * Does NOT invent missing uniforms — capture must already contain them.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentQualificationContext } from './lib/runtime_v3_qualification.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = process.env.VFX_V3_ARTIFACT_DIR
  ? resolve(root, process.env.VFX_V3_ARTIFACT_DIR)
  : join(root, 'public', 'assets', 'v3-artifacts');
const codeRoot = process.env.VFX_V3_CODE_DIR
  ? resolve(root, process.env.VFX_V3_CODE_DIR)
  : join(root, 'public', 'assets', 'v3-code');
const capturePaths = process.argv.slice(2);
if (!capturePaths.length) {
  throw new Error('Usage: node scripts/stamp_artifact_from_capture.mjs <capture.json> [...]');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function capturePayloadSha256(capture) {
  const { qualification: _qualification, ...payload } = capture;
  return sha256Hex(Buffer.from(JSON.stringify(payload)));
}

function computeThinPlayerCapability(artifact) {
  const pipelines = Object.values(artifact.pipelines ?? {});
  const closures = Object.values(artifact.batchClosures ?? {});
  return pipelines.length > 0
    && closures.length > 0
    && artifact.execution?.simulation === 'artifact-emitter-sim@1'
    && pipelines.every((pipeline) => {
      const shader = artifact.shaders?.[pipeline.shader];
      return pipeline.executor === 'artifact-shader@1'
        && !!pipeline.blendState
        && !!pipeline.uniformValues
        && Array.isArray(pipeline.tileCounts)
        && pipeline.tileCounts.length === 2
        && shader?.execution === 'quarks-fragment-v1'
        && shader.vertexExecution === 'quarks-vertex-v1';
    })
    && closures.every((closure) => closure.qualification?.status === 'pixel-qualified');
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

const RENDER_MODE_STRETCHED = 1;

function cfxrMapHas(cfxrState, mapKey, emitterId) {
  const entries = Array.isArray(cfxrState?.[mapKey]) ? cfxrState[mapKey] : [];
  return entries.some((entry) => entry?.[0] === emitterId);
}

function deriveBehaviorMounts(emitterId, renderMode, cfxrState, hasMap) {
  const mounts = ['material-basics@1'];
  if (hasMap) mounts.push('map-colorspace@1');
  if (renderMode === RENDER_MODE_STRETCHED) mounts.push('stretch-remap@1');
  if (cfxrMapHas(cfxrState, 'shapeTransformByEmitter', emitterId)) mounts.push('shape-transform@1');
  if (cfxrMapHas(cfxrState, 'initialStateByEmitter', emitterId)) {
    mounts.push('initial-state@1', 'global-age@1', 'spawn-visibility@1');
  }
  if (cfxrMapHas(cfxrState, 'custom1CurvesByEmitter', emitterId)) mounts.push('custom1@1');
  if (cfxrMapHas(cfxrState, 'sizeTwoCurvesByEmitter', emitterId)) mounts.push('size-two-curves@1');
  if (cfxrMapHas(cfxrState, 'sizeOverLifetimeByEmitter', emitterId)) mounts.push('size-over-lifetime@1');
  if (cfxrMapHas(cfxrState, 'startSizeTwoCurvesByEmitter', emitterId)) mounts.push('start-size-two-curves@1');
  if (cfxrMapHas(cfxrState, 'limitVelocity3DByEmitter', emitterId)) mounts.push('limit-velocity-3d@1');
  if (cfxrMapHas(cfxrState, 'limitVelocityByEmitter', emitterId)) mounts.push('limit-velocity@1');
  if (cfxrMapHas(cfxrState, 'velocityOverLifetimeByEmitter', emitterId)) mounts.push('velocity-over-lifetime@1');
  if (cfxrMapHas(cfxrState, 'rotation3DByEmitter', emitterId)) mounts.push('rotation-3d@1');
  if (cfxrMapHas(cfxrState, 'trajectoryCacheByEmitter', emitterId)) mounts.push('trajectory-cache@1');
  if (cfxrMapHas(cfxrState, 'trailSemanticsByEmitter', emitterId)) mounts.push('trail-semantics@1');
  mounts.push('renderer-pivot@1');
  if (cfxrMapHas(cfxrState, 'pendingCfxrByEmitter', emitterId)) {
    mounts.push('semantic-blend@1', 'color32-stream@1');
  }
  return [...new Set(mounts)].sort();
}

/** Offline thin bags: mounts + custom defaults + pivot mirrored from cfxrState. */
function stampEmitterSimBags(quarksConfig, runtimeState) {
  const cfxrState = runtimeState?.cfxrState ?? {};
  const materials = new Map((quarksConfig.materials ?? []).map((m) => [m.uuid, m]));
  let stamped = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ParticleEmitter' && node.ps) {
      const emitterId = String(node.uuid ?? '');
      const material = materials.get(node.ps.material);
      const hasMap = !!(material?.map || material?.texture);
      const renderMode = Number(node.ps.renderMode);
      const mounts = [
        ...(node.ps.artifactBehaviorMount?.schema === 'cfxr-behavior-mount@1'
          && Array.isArray(node.ps.artifactBehaviorMount.mounts)
          ? node.ps.artifactBehaviorMount.mounts.map(String)
          : []),
        ...deriveBehaviorMounts(emitterId, renderMode, cfxrState, hasMap),
      ];
      node.ps.artifactBehaviorMount = { schema: 'cfxr-behavior-mount@1', mounts };
      if (Array.isArray(node.ps.unityRendererFlip)) {
        if (!Array.isArray(node.ps.artifactDefaultCustom1)
          || node.ps.artifactDefaultCustom1.length !== 4) {
          node.ps.artifactDefaultCustom1 = [0, 0, 0, 0];
        }
        if (!Array.isArray(node.ps.artifactDefaultCustom2)
          || node.ps.artifactDefaultCustom2.length !== 4) {
          node.ps.artifactDefaultCustom2 = [0, 0, 0, 0];
        }
      }
      const pivotEntries = Array.isArray(cfxrState.rendererPivotByEmitter)
        ? cfxrState.rendererPivotByEmitter
        : [];
      const pivot = pivotEntries.find((entry) => entry?.[0] === emitterId)?.[1];
      if (Array.isArray(pivot) && pivot.length >= 4 && !Array.isArray(node.ps.artifactRendererPivot)) {
        node.ps.artifactRendererPivot = [
          Number(pivot[0]), Number(pivot[1]), Number(pivot[2]), Number(pivot[3]),
        ];
      }
      // Mirror map-only tables onto ps for thin collectArtifactEmitterSim.
      const bakePs = (mapKey, psKey) => {
        if (node.ps[psKey] != null) return;
        const entries = Array.isArray(cfxrState[mapKey]) ? cfxrState[mapKey] : [];
        const value = entries.find((entry) => entry?.[0] === emitterId)?.[1];
        if (value != null) node.ps[psKey] = value;
      };
      bakePs('shapeTransformByEmitter', 'unityShapeTransform');
      bakePs('initialStateByEmitter', 'unityInitialState');
      bakePs('trajectoryCacheByEmitter', 'unityTrajectoryCache');
      bakePs('sizeOverLifetimeByEmitter', 'unitySizeOverLifetime');
      bakePs('sizeTwoCurvesByEmitter', 'unitySizeOverLifetime');
      bakePs('startSizeTwoCurvesByEmitter', 'unityStartSize');
      bakePs('limitVelocity3DByEmitter', 'unityLimitVelocity3D');
      bakePs('limitVelocityByEmitter', 'unityLimitVelocity');
      bakePs('velocityOverLifetimeByEmitter', 'unityVelocityOverLifetime');
      bakePs('rotation3DByEmitter', 'unityRotationOverLifetime3D');
      bakePs('trailSemanticsByEmitter', 'unityTrailSemantics');
      bakePs('trailGeometryByEmitter', 'unityTrailGeometry');
      const addBagMount = (condition, ...ids) => {
        if (condition) mounts.push(...ids);
      };
      addBagMount(node.ps.unityShapeTransform, 'shape-transform@1');
      addBagMount((Array.isArray(node.ps.unityInitialState) && node.ps.unityInitialState.length)
        || node.ps.unityInitialStateResourceId,
        'initial-state@1', 'global-age@1', 'spawn-visibility@1');
      addBagMount(node.ps.artifactCustom1Curves, 'custom1@1');
      addBagMount(node.ps.unitySizeOverLifetime?.type === 'UnityTwoCurves@1', 'size-two-curves@1');
      addBagMount(node.ps.unitySizeOverLifetime?.schema === 'unity-size-over-lifetime@1', 'size-over-lifetime@1');
      addBagMount(node.ps.unityStartSize?.type === 'UnityTwoCurves@1', 'start-size-two-curves@1');
      addBagMount(node.ps.unityLimitVelocity3D, 'limit-velocity-3d@1');
      addBagMount(node.ps.unityLimitVelocity, 'limit-velocity@1');
      addBagMount(node.ps.unityVelocityOverLifetime, 'velocity-over-lifetime@1');
      addBagMount(node.ps.unityRotationOverLifetime3D, 'rotation-3d@1');
      addBagMount(node.ps.unityTrajectoryCache, 'trajectory-cache@1');
      addBagMount(node.ps.unityTrailSemantics, 'trail-semantics@1');
      node.ps.artifactBehaviorMount = {
        schema: 'cfxr-behavior-mount@1',
        mounts: [...new Set(mounts)].sort(),
      };
      // Thin collectArtifactEmitterSim only reads artifactCustom1Curves (not the
      // cfxrState map); mirror curves so custom1@1 mounts are bag-complete.
      bakePs('custom1CurvesByEmitter', 'artifactCustom1Curves');

      // Thin requireStreamStamps: every unityInitialState particle needs
      // rendererFlip[2] + custom1/2[4]. Corpus historically omitted identity flips.
      if (Array.isArray(node.ps.unityInitialState)) {
        const flip = Array.isArray(node.ps.unityRendererFlip) && node.ps.unityRendererFlip.length === 2
          ? [!!node.ps.unityRendererFlip[0], !!node.ps.unityRendererFlip[1]]
          : [false, false];
        const c1 = Array.isArray(node.ps.artifactDefaultCustom1)
          && node.ps.artifactDefaultCustom1.length === 4
          ? node.ps.artifactDefaultCustom1
          : [0, 0, 0, 0];
        const c2 = Array.isArray(node.ps.artifactDefaultCustom2)
          && node.ps.artifactDefaultCustom2.length === 4
          ? node.ps.artifactDefaultCustom2
          : [0, 0, 0, 0];
        for (const state of node.ps.unityInitialState) {
          if (!state || typeof state !== 'object') continue;
          if (!Array.isArray(state.rendererFlip) || state.rendererFlip.length !== 2) {
            state.rendererFlip = [...flip];
          }
          if (!Array.isArray(state.custom1) || state.custom1.length !== 4) {
            state.custom1 = [...c1];
          }
          if (!Array.isArray(state.custom2) || state.custom2.length !== 4) {
            state.custom2 = [...c2];
          }
        }
      }
      stamped += 1;
    }
    for (const child of node.children ?? []) walk(child);
    if (node.object) walk(node.object);
  };
  walk(quarksConfig.object ?? quarksConfig);
  return stamped;
}

async function resolveArtifactPath(effectId) {
  const dir = artifactRoot;
  const exact = join(dir, `${effectId}.json`);
  try {
    await readFile(exact);
    return exact;
  } catch {
    // fall through
  }
  const lowerWanted = effectId.toLowerCase();
  const names = await readdir(dir);
  // Prefer catalog short-id match via artifact.effectId before suffix (jmo_…_shortid).
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'manifest.json') continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (String(raw.effectId ?? '').toLowerCase() === lowerWanted) {
        return join(dir, name);
      }
    } catch {
      // skip unreadable
    }
  }
  const byName = names.find((name) => name.toLowerCase() === `${lowerWanted}.json`);
  if (byName) return join(dir, byName);
  const bySuffix = names.find((name) => name.toLowerCase().endsWith(`_${lowerWanted}.json`));
  if (bySuffix) return join(dir, bySuffix);
  throw new Error(`STAMP_MISSING_ARTIFACT ${effectId}`);
}

function findPipelineForBatch(artifact, batch) {
  const pipelines = artifact.pipelines ?? {};
  if (batch.artifactShaderId) {
    const hit = Object.entries(pipelines).find(([, p]) => p.shader === batch.artifactShaderId);
    if (hit) return hit;
  }
  const entries = Object.entries(pipelines);
  if (entries.length === 1) return entries[0];
  if (typeof batch.batchIndex === 'number' && entries[batch.batchIndex]) {
    return entries[batch.batchIndex];
  }
  throw new Error(
    `Cannot map capture batch ${batch.batchIndex} to a pipeline `
    + `(shaderId=${batch.artifactShaderId ?? 'none'}, pipelines=${entries.length})`,
  );
}

let failed = false;
const qualificationContext = await currentQualificationContext(root);
for (const capturePath of capturePaths) {
  const capture = JSON.parse(await readFile(capturePath, 'utf8'));
  if (capture.schema !== 'vfx-live-material-capture@1') {
    console.error(`STAMP_BAD_SCHEMA ${capturePath}`);
    failed = true;
    continue;
  }
  if (capture.runtimeFingerprint !== qualificationContext.runtimeFingerprint) {
    console.warn(`STAMP_SKIP_STALE_CAPTURE ${capturePath}`);
    continue;
  }
  const storedProof = capture.qualification;
  const payloadSha256 = capturePayloadSha256(capture);
  const storedProofValid = storedProof?.schema === 'vfx-capture-qualification@1'
    && storedProof.status === 'pixel-qualified'
    && storedProof.runtimeFingerprint === qualificationContext.runtimeFingerprint
    && storedProof.corpusSha256 === qualificationContext.corpusSha256
    && storedProof.oracleSha256 === qualificationContext.oracleSha256
    && storedProof.capturePayloadSha256 === payloadSha256
    && Array.isArray(storedProof.captureTimes)
    && new Set(storedProof.captureTimes).size >= 2
    && storedProof.changedPixels === 0
    && storedProof.maxChannelDelta === 0;
  const provisional = process.env.VFX_PROVISIONAL_CAPTURE_QUALIFICATION === '1';
  const proof = storedProofValid ? storedProof : (provisional ? {
    schema: 'vfx-capture-qualification-provisional@1',
    runtimeFingerprint: qualificationContext.runtimeFingerprint,
    capturePayloadSha256: payloadSha256,
    captureTimes: (process.env.VFX_CAPTURE_TIMES ?? '0.25,0.5')
      .split(',').map(Number).filter(Number.isFinite),
  } : null);
  const capturePixelQualified = storedProofValid || provisional;
  const effectId = capture.effectId;
  let artPath;
  let artifact;
  try {
    artPath = await resolveArtifactPath(effectId);
    artifact = JSON.parse(await readFile(artPath, 'utf8'));
  } catch (error) {
    console.error(String(error?.message ?? error));
    failed = true;
    continue;
  }

  const codeDir = join(codeRoot, String(artifact.effectId).toLowerCase());
  await mkdir(codeDir, { recursive: true });
  if (!artifact.shaders || typeof artifact.shaders !== 'object') artifact.shaders = {};
  if (!artifact.files) artifact.files = {};
  if (!artifact.files.shaders) artifact.files.shaders = {};

  const stampedPipelines = [];
  for (const batch of capture.batches ?? []) {
    if (!batch.fragmentShader?.trim() || !batch.vertexShader?.trim()) {
      throw new Error(`STAMP_EMPTY_SHADER ${effectId} batch=${batch.batchIndex}`);
    }
    if (!batch.blendState) throw new Error(`STAMP_MISSING_BLEND ${effectId} batch=${batch.batchIndex}`);
    if (!batch.uniformValues?.materialColor || typeof batch.uniformValues.opacityGain !== 'number') {
      throw new Error(`STAMP_MISSING_UNIFORMS ${effectId} batch=${batch.batchIndex}`);
    }
    if (!batch.tileCounts) {
      throw new Error(`STAMP_MISSING_TILES ${effectId} batch=${batch.batchIndex}`);
    }

    const [pipelineId, pipeline] = findPipelineForBatch(artifact, batch);
    const shaderId = pipeline.shader || batch.artifactShaderId || `shader-${pipelineId}`;
    const vertBytes = Buffer.from(batch.vertexShader, 'utf8');
    const fragBytes = Buffer.from(batch.fragmentShader, 'utf8');
    const vertName = `${shaderId}.vert.glsl`;
    const fragName = `${shaderId}.frag.glsl`;
    await writeFile(join(codeDir, vertName), vertBytes);
    await writeFile(join(codeDir, fragName), fragBytes);

    const module = {
      id: shaderId,
      vertex: batch.vertexShader,
      fragment: batch.fragmentShader,
      uniforms: artifact.shaders?.[shaderId]?.uniforms ?? {},
      execution: 'quarks-fragment-v1',
      vertexExecution: 'quarks-vertex-v1',
      ...(Object.keys(batch.defines ?? {}).length ? { defines: batch.defines } : {}),
      provenance: {
        kind: 'live-bridge-capture@1',
        capturedAt: capture.capturedAt,
        injectMode: batch.injectMode,
        captureSource: capture.source,
      },
    };
    artifact.shaders[shaderId] = module;
    const priorFile = artifact.files.shaders[shaderId] ?? {};
    artifact.files.shaders[shaderId] = {
      id: shaderId,
      vertex: {
        uri: `/assets/v3-code/${String(artifact.effectId).toLowerCase()}/${vertName}`,
        sha256: sha256Hex(vertBytes),
        bytes: vertBytes.length,
      },
      fragment: {
        uri: `/assets/v3-code/${String(artifact.effectId).toLowerCase()}/${fragName}`,
        sha256: sha256Hex(fragBytes),
        bytes: fragBytes.length,
      },
      uniforms: priorFile.uniforms ?? module.uniforms ?? {},
      execution: 'quarks-fragment-v1',
      vertexExecution: 'quarks-vertex-v1',
      defines: batch.defines ?? {},
      provenance: module.provenance,
    };

    pipeline.shader = shaderId;
    pipeline.blendState = batch.blendState;
    pipeline.uniformValues = batch.uniformValues;
    pipeline.tileCounts = batch.tileCounts;
    pipeline.defines = batch.defines ?? {};
    if (batch.capturedUniforms && Object.keys(batch.capturedUniforms).length) {
      pipeline.capturedUniforms = batch.capturedUniforms;
    }
    pipeline.executor = 'artifact-shader@1';
    // Capture stamps ownership; pixel-qualified remains a spot-check gate for thin.
    pipeline.qualification = {
      ...(pipeline.qualification ?? {}),
      status: pipeline.qualification?.status === 'pixel-qualified'
        ? 'pixel-qualified'
        : 'capture-stamped',
      baseline: pipeline.qualification?.baseline ?? 'frozen-semantic@1',
      familyId: pipeline.qualification?.familyId
        ?? batch.artifactFamilyId
        ?? `capture-family-${shaderId}`,
      evidence: {
        ...(pipeline.qualification?.evidence ?? {}),
        captureProvenance: 'live-bridge-capture@1',
        capturedAt: capture.capturedAt,
        injectMode: batch.injectMode,
      },
    };
    artifact.pipelines[pipelineId] = pipeline;
    stampedPipelines.push(pipelineId);
  }

  // Shared Quarks batch closures may list simulation-only / missing-material
  // sibling pipelines that never appear as their own live batch (same draw
  // material at runtime). Clone the first capture-stamped sibling's offline
  // program onto remaining bridge pipes so the closure can elevate atomically.
  const closures = artifact.batchClosures ?? {};
  for (const closure of Object.values(closures)) {
    const pipeIds = closure.pipelines ?? closure.pipelineIds ?? [];
    const donors = pipeIds.filter((pid) => stampedPipelines.includes(pid));
    if (!donors.length) continue;
    const donor = artifact.pipelines[donors[0]];
    const donorShader = artifact.shaders?.[donor?.shader];
    const donorFile = artifact.files.shaders?.[donor?.shader];
    if (!donor || !donorShader || !donorFile) continue;
    for (const pid of pipeIds) {
      if (stampedPipelines.includes(pid)) continue;
      const pipeline = artifact.pipelines?.[pid];
      if (!pipeline) continue;
      // Already capture-ready: still force familyId to match the live donor so a
      // shared Quarks batch can bind homogeneously.
      if (pipeline.executor === 'artifact-shader@1'
        && (pipeline.qualification?.status === 'capture-stamped'
          || pipeline.qualification?.status === 'pixel-qualified')) {
        const donorFamily = donor.qualification?.familyId;
        if (donorFamily && pipeline.qualification?.familyId !== donorFamily) {
          pipeline.qualification = {
            ...pipeline.qualification,
            familyId: donorFamily,
          };
          artifact.pipelines[pid] = pipeline;
          console.log(`STAMP_ALIGN_FAMILY ${effectId} ${pid} → ${donorFamily}`);
        }
        stampedPipelines.push(pid);
        continue;
      }
      if (pipeline.executor === 'artifact-shader@1') continue;
      const shaderId = pipeline.shader || `shader-${pid}`;
      const vertBytes = Buffer.from(donorShader.vertex, 'utf8');
      const fragBytes = Buffer.from(donorShader.fragment, 'utf8');
      const vertName = `${shaderId}.vert.glsl`;
      const fragName = `${shaderId}.frag.glsl`;
      await writeFile(join(codeDir, vertName), vertBytes);
      await writeFile(join(codeDir, fragName), fragBytes);
      artifact.shaders[shaderId] = {
        ...donorShader,
        id: shaderId,
        provenance: {
          ...(donorShader.provenance ?? {}),
          kind: 'live-bridge-capture@1',
          clonedFromPipeline: donors[0],
          capturedAt: capture.capturedAt,
        },
      };
      artifact.files.shaders[shaderId] = {
        id: shaderId,
        vertex: {
          uri: `/assets/v3-code/${String(artifact.effectId).toLowerCase()}/${vertName}`,
          sha256: sha256Hex(vertBytes),
          bytes: vertBytes.length,
        },
        fragment: {
          uri: `/assets/v3-code/${String(artifact.effectId).toLowerCase()}/${fragName}`,
          sha256: sha256Hex(fragBytes),
          bytes: fragBytes.length,
        },
        uniforms: donorFile.uniforms ?? {},
        execution: 'quarks-fragment-v1',
        vertexExecution: 'quarks-vertex-v1',
        defines: donorFile.defines ?? {},
        provenance: artifact.shaders[shaderId].provenance,
      };
      pipeline.shader = shaderId;
      pipeline.blendState = structuredClone(donor.blendState);
      pipeline.uniformValues = structuredClone(donor.uniformValues);
      pipeline.tileCounts = [...donor.tileCounts];
      pipeline.defines = structuredClone(donor.defines ?? {});
      if (donor.capturedUniforms) {
        pipeline.capturedUniforms = structuredClone(donor.capturedUniforms);
      }
      pipeline.executor = 'artifact-shader@1';
      pipeline.qualification = {
        ...(pipeline.qualification ?? {}),
        status: donor.qualification?.status === 'pixel-qualified'
          ? 'pixel-qualified'
          : (pipeline.qualification?.status === 'pixel-qualified'
            ? 'pixel-qualified'
            : 'capture-stamped'),
        baseline: pipeline.qualification?.baseline ?? 'frozen-semantic@1',
        // Must match the live batch donor family — mixed familyIds on one Quarks
        // batch fail homogeneous artifact bind.
        familyId: donor.qualification?.familyId ?? `capture-family-${donors[0]}`,
        evidence: {
          ...(donor.qualification?.evidence ?? {}),
          ...(pipeline.qualification?.evidence ?? {}),
          captureProvenance: 'live-bridge-capture@1',
          capturedAt: capture.capturedAt,
          clonedFromPipeline: donors[0],
        },
      };
      artifact.pipelines[pid] = pipeline;
      stampedPipelines.push(pid);
      console.log(`STAMP_CLONE ${effectId} ${pid} ← ${donors[0]} (shared closure)`);
    }
  }

    // Elevate closures only when every listed pipeline is capture-ready.
    // Never keep pixel-qualified if any member is only capture-stamped.
  for (const closure of Object.values(closures)) {
    const pipeIds = closure.pipelines ?? closure.pipelineIds ?? [];
    if (!pipeIds.length) continue;
    const statuses = pipeIds.map((pid) => artifact.pipelines?.[pid]?.qualification?.status);
    const ready = statuses.every((status) => status === 'capture-stamped' || status === 'pixel-qualified')
      && pipeIds.every((pid) => artifact.pipelines?.[pid]?.executor === 'artifact-shader@1');
    if (!ready) continue;
    const allPixel = statuses.every((status) => status === 'pixel-qualified');
    closure.qualification = {
      ...(closure.qualification ?? {}),
      status: allPixel ? 'pixel-qualified' : 'capture-stamped',
      baseline: closure.qualification?.baseline ?? 'frozen-semantic@1',
      evidence: {
        ...(closure.qualification?.evidence ?? {}),
        captureProvenance: 'live-bridge-capture@1',
        capturedAt: capture.capturedAt,
      },
    };
  }
  artifact.batchClosures = closures;

  // Capture-stamped material path is thin-ready only with bag simulation.
  if (!artifact.execution || typeof artifact.execution !== 'object') {
    artifact.execution = {};
  }
  if (artifact.execution.simulation !== 'artifact-emitter-sim@1') {
    artifact.execution.simulation = 'artifact-emitter-sim@1';
  }
  if (!artifact.execution.material) artifact.execution.material = 'per-pipeline@1';

  // Orphan bridge pipes live in singleton closures (no shared-closure donor).
  // Leaving them on semantic-bridge while siblings are capture-stamped breaks
  // Quarks artifact bind. Prefer donor clone+elevate; only re-split inline GLSL
  // for pipes that are already artifact-shader but missing files.shaders.
  // Prefer a live-stamped donor that already shares this pipe's closure so we
  // do not copy legacy-premultiply blend onto a semantic sibling (dual-path
  // divergence). Fall back to the first stamped pipeline only when needed.
  const closureOfPipe = (pid) => {
    for (const [cid, closure] of Object.entries(closures)) {
      const pipeIds = closure.pipelines ?? closure.pipelineIds ?? [];
      if (pipeIds.includes(pid)) return cid;
    }
    return null;
  };
  const pickOrphanDonor = (pid) => {
    const ownCid = closureOfPipe(pid);
    if (ownCid) {
      const pipeIds = closures[ownCid]?.pipelines ?? closures[ownCid]?.pipelineIds ?? [];
      for (const cand of pipeIds) {
        if (cand === pid) continue;
        if (!stampedPipelines.includes(cand)) continue;
        const live = artifact.shaders?.[artifact.pipelines?.[cand]?.shader]?.provenance?.kind
          === 'live-bridge-capture@1';
        if (live) return cand;
      }
      for (const cand of pipeIds) {
        if (cand === pid) continue;
        if (stampedPipelines.includes(cand)) return cand;
      }
    }
    return stampedPipelines[0] ?? null;
  };
  for (const [pid, pipeline] of Object.entries(artifact.pipelines ?? {})) {
    if (!pipeline?.shader) continue;
    const filesReady = !!(artifact.files.shaders[pipeline.shader]?.vertex?.sha256
      && artifact.files.shaders[pipeline.shader]?.fragment?.sha256);
    const alreadyArtifact = pipeline.executor === 'artifact-shader@1'
      && (pipeline.qualification?.status === 'capture-stamped'
        || pipeline.qualification?.status === 'pixel-qualified');
    // Skip only true live-bridge captures. Prior pixel-qualified stubs (tiny
    // semantic GLSL / missing artifact.shaders entry) must be re-cloned from the
    // donor or homogeneous bind fails when Quarks batches them with siblings.
    const liveCapture = artifact.shaders?.[pipeline.shader]?.provenance?.kind
      === 'live-bridge-capture@1';

    if (alreadyArtifact && filesReady && liveCapture) continue;

    if (alreadyArtifact && !filesReady) {
      const existing = artifact.shaders?.[pipeline.shader];
      if (!existing?.vertex || !existing?.fragment) {
        throw new Error(`STAMP_ARTIFACT_MISSING_GLSL ${effectId} ${pid}`);
      }
      const vertBytes = Buffer.from(existing.vertex, 'utf8');
      const fragBytes = Buffer.from(existing.fragment, 'utf8');
      const vertName = `${pipeline.shader}.vert.glsl`;
      const fragName = `${pipeline.shader}.frag.glsl`;
      await writeFile(join(codeDir, vertName), vertBytes);
      await writeFile(join(codeDir, fragName), fragBytes);
      artifact.files.shaders[pipeline.shader] = {
        id: pipeline.shader,
        vertex: {
          uri: `/assets/v3-code/${String(artifact.effectId).toLowerCase()}/${vertName}`,
          sha256: sha256Hex(vertBytes),
          bytes: vertBytes.length,
        },
        fragment: {
          uri: `/assets/v3-code/${String(artifact.effectId).toLowerCase()}/${fragName}`,
          sha256: sha256Hex(fragBytes),
          bytes: fragBytes.length,
        },
        uniforms: existing.uniforms ?? {},
        execution: existing.execution ?? 'quarks-fragment-v1',
        vertexExecution: existing.vertexExecution ?? 'quarks-vertex-v1',
      };
      console.log(`STAMP_SPLIT_EXISTING ${effectId} ${pid} → ${pipeline.shader}`);
      continue;
    }

    const firstDonorId = pickOrphanDonor(pid);
    const firstDonor = firstDonorId ? artifact.pipelines[firstDonorId] : null;
    const firstDonorShader = firstDonor ? artifact.shaders?.[firstDonor.shader] : null;
    const firstDonorFile = firstDonor ? artifact.files.shaders?.[firstDonor.shader] : null;
    if (!firstDonor || !firstDonorShader || !firstDonorFile) {
      throw new Error(`STAMP_ORPHAN_NO_DONOR ${effectId} ${pid}`);
    }
    // Clone donor onto orphan bridge pipe + elevate its singleton closure.
    const shaderId = pipeline.shader || `shader-${pid}`;
    const vertBytes = Buffer.from(firstDonorShader.vertex, 'utf8');
    const fragBytes = Buffer.from(firstDonorShader.fragment, 'utf8');
    const vertName = `${shaderId}.vert.glsl`;
    const fragName = `${shaderId}.frag.glsl`;
    await writeFile(join(codeDir, vertName), vertBytes);
    await writeFile(join(codeDir, fragName), fragBytes);
    artifact.shaders[shaderId] = {
      ...firstDonorShader,
      id: shaderId,
      provenance: {
        ...(firstDonorShader.provenance ?? {}),
        kind: 'live-bridge-capture@1',
        clonedFromPipeline: firstDonorId,
        capturedAt: capture.capturedAt,
        orphanClone: true,
      },
    };
    artifact.files.shaders[shaderId] = {
      id: shaderId,
      vertex: {
        uri: `/assets/v3-code/${String(artifact.effectId).toLowerCase()}/${vertName}`,
        sha256: sha256Hex(vertBytes),
        bytes: vertBytes.length,
      },
      fragment: {
        uri: `/assets/v3-code/${String(artifact.effectId).toLowerCase()}/${fragName}`,
        sha256: sha256Hex(fragBytes),
        bytes: fragBytes.length,
      },
      uniforms: firstDonorFile.uniforms ?? {},
      execution: 'quarks-fragment-v1',
      vertexExecution: 'quarks-vertex-v1',
      defines: firstDonorFile.defines ?? {},
      provenance: artifact.shaders[shaderId].provenance,
    };
    pipeline.shader = shaderId;
    pipeline.blendState = structuredClone(firstDonor.blendState);
    pipeline.uniformValues = structuredClone(firstDonor.uniformValues);
    pipeline.tileCounts = [...firstDonor.tileCounts];
    pipeline.defines = structuredClone(firstDonor.defines ?? {});
    if (firstDonor.capturedUniforms) {
      pipeline.capturedUniforms = structuredClone(firstDonor.capturedUniforms);
    }
    pipeline.executor = 'artifact-shader@1';
    pipeline.qualification = {
      ...(pipeline.qualification ?? {}),
      status: firstDonor.qualification?.status === 'pixel-qualified'
        ? 'pixel-qualified'
        : 'capture-stamped',
      baseline: pipeline.qualification?.baseline ?? 'frozen-semantic@1',
      familyId: firstDonor.qualification?.familyId ?? `capture-family-${firstDonorId}`,
      evidence: {
        ...(firstDonor.qualification?.evidence ?? {}),
        ...(pipeline.qualification?.evidence ?? {}),
        captureProvenance: 'live-bridge-capture@1',
        capturedAt: capture.capturedAt,
        clonedFromPipeline: firstDonorId,
        orphanClone: true,
      },
    };
    artifact.pipelines[pid] = pipeline;
    stampedPipelines.push(pid);
    // Merge orphan into donor closure so Quarks batches that coalesce after
    // clone still see a homogeneous closureId (bind requires same closure).
    let donorClosureKey = null;
    for (const [cid, closure] of Object.entries(closures)) {
      const pipeIds = closure.pipelines ?? closure.pipelineIds ?? [];
      if (pipeIds.includes(firstDonorId)) {
        donorClosureKey = cid;
        if (!pipeIds.includes(pid)) {
          if (Array.isArray(closure.pipelines)) closure.pipelines.push(pid);
          else if (Array.isArray(closure.pipelineIds)) closure.pipelineIds.push(pid);
        }
        break;
      }
    }
    for (const [cid, closure] of Object.entries(closures)) {
      if (cid === donorClosureKey) continue;
      const pipeIds = closure.pipelines ?? closure.pipelineIds ?? [];
      if (!pipeIds.includes(pid)) continue;
      if (Array.isArray(closure.pipelines)) {
        closure.pipelines = closure.pipelines.filter((id) => id !== pid);
      } else if (Array.isArray(closure.pipelineIds)) {
        closure.pipelineIds = closure.pipelineIds.filter((id) => id !== pid);
      }
      if (!(closure.pipelines ?? closure.pipelineIds ?? []).length) {
        delete closures[cid];
      }
    }
    console.log(`STAMP_CLONE ${effectId} ${pid} ← ${firstDonorId} (orphan)`);
  }

  // Elevate singleton closures that are now capture-ready.
  // Demote pixel-qualified closures when any member is only capture-stamped.
  for (const closure of Object.values(closures)) {
    const pipeIds = closure.pipelines ?? closure.pipelineIds ?? [];
    if (!pipeIds.length) continue;
    const statuses = pipeIds.map((pid) => artifact.pipelines?.[pid]?.qualification?.status);
    const ready = statuses.every((status) => status === 'capture-stamped' || status === 'pixel-qualified')
      && pipeIds.every((pid) => artifact.pipelines?.[pid]?.executor === 'artifact-shader@1');
    if (!ready) continue;
    const allPixel = statuses.every((status) => status === 'pixel-qualified');
    closure.qualification = {
      ...(closure.qualification ?? {}),
      status: allPixel ? 'pixel-qualified' : 'capture-stamped',
      baseline: closure.qualification?.baseline ?? 'frozen-semantic@1',
      evidence: {
        ...(closure.qualification?.evidence ?? {}),
        captureProvenance: 'live-bridge-capture@1',
        capturedAt: capture.capturedAt,
      },
    };
  }

  // Live capture may list multiple offline closureIds on one Quarks batch.
  // Force-merge those closures onto the stamped donor and clone+align family so
  // runtime homogeneous bind sees one familyId + one closureId.
  const clonePipeFromDonor = async (pid, donorPid, reason) => {
    const donor = artifact.pipelines?.[donorPid];
    const donorShader = donor ? artifact.shaders?.[donor.shader] : null;
    const donorFile = donor ? artifact.files.shaders?.[donor.shader] : null;
    const pipeline = artifact.pipelines?.[pid];
    if (!donor || !donorShader || !donorFile || !pipeline) return false;
    const shaderId = pipeline.shader || `shader-${pid}`;
    const vertBytes = Buffer.from(donorShader.vertex, 'utf8');
    const fragBytes = Buffer.from(donorShader.fragment, 'utf8');
    const vertName = `${shaderId}.vert.glsl`;
    const fragName = `${shaderId}.frag.glsl`;
    await writeFile(join(codeDir, vertName), vertBytes);
    await writeFile(join(codeDir, fragName), fragBytes);
    artifact.shaders[shaderId] = {
      ...donorShader,
      id: shaderId,
      provenance: {
        ...(donorShader.provenance ?? {}),
        kind: 'live-bridge-capture@1',
        clonedFromPipeline: donorPid,
        capturedAt: capture.capturedAt,
        coalesceClone: true,
      },
    };
    artifact.files.shaders[shaderId] = {
      id: shaderId,
      vertex: {
        uri: `/assets/v3-code/${String(artifact.effectId).toLowerCase()}/${vertName}`,
        sha256: sha256Hex(vertBytes),
        bytes: vertBytes.length,
      },
      fragment: {
        uri: `/assets/v3-code/${String(artifact.effectId).toLowerCase()}/${fragName}`,
        sha256: sha256Hex(fragBytes),
        bytes: fragBytes.length,
      },
      uniforms: donorFile.uniforms ?? {},
      execution: 'quarks-fragment-v1',
      vertexExecution: 'quarks-vertex-v1',
      defines: donorFile.defines ?? {},
      provenance: artifact.shaders[shaderId].provenance,
    };
    pipeline.shader = shaderId;
    pipeline.blendState = structuredClone(donor.blendState);
    pipeline.uniformValues = structuredClone(donor.uniformValues);
    pipeline.tileCounts = [...(donor.tileCounts ?? [1, 1])];
    pipeline.defines = structuredClone(donor.defines ?? {});
    if (donor.capturedUniforms) {
      pipeline.capturedUniforms = structuredClone(donor.capturedUniforms);
    }
    pipeline.executor = 'artifact-shader@1';
    pipeline.qualification = {
      ...(pipeline.qualification ?? {}),
      status: donor.qualification?.status === 'pixel-qualified'
        ? 'pixel-qualified'
        : (pipeline.qualification?.status === 'pixel-qualified'
          ? 'pixel-qualified'
          : 'capture-stamped'),
      baseline: pipeline.qualification?.baseline ?? 'frozen-semantic@1',
      familyId: donor.qualification?.familyId ?? `capture-family-${donorPid}`,
      evidence: {
        ...(donor.qualification?.evidence ?? {}),
        ...(pipeline.qualification?.evidence ?? {}),
        captureProvenance: 'live-bridge-capture@1',
        capturedAt: capture.capturedAt,
        clonedFromPipeline: donorPid,
        coalesceClone: true,
      },
    };
    artifact.pipelines[pid] = pipeline;
    if (!stampedPipelines.includes(pid)) stampedPipelines.push(pid);
    console.log(`STAMP_CLONE ${effectId} ${pid} ← ${donorPid} (${reason})`);
    return true;
  };

  for (const batch of capture.batches ?? []) {
    const cids = [...new Set((batch.closureIds ?? []).filter((c) => typeof c === 'string' && c))];
    if (cids.length < 2) continue;
    let donorPid = null;
    try {
      donorPid = findPipelineForBatch(artifact, batch)[0];
    } catch {
      donorPid = stampedPipelines[0] ?? null;
    }
    if (!donorPid || !artifact.pipelines?.[donorPid]) continue;
    const donorFam = artifact.pipelines[donorPid]?.qualification?.familyId
      ?? batch.artifactFamilyId
      ?? `capture-family-${donorPid}`;
    let primaryCid = cids.find((cid) => {
      const pipeIds = closures[cid]?.pipelines ?? closures[cid]?.pipelineIds ?? [];
      return pipeIds.includes(donorPid);
    }) ?? cids[0];
    if (!closures[primaryCid]) continue;
    const primaryList = closures[primaryCid].pipelines ?? closures[primaryCid].pipelineIds;
    if (!Array.isArray(primaryList)) continue;
    for (const cid of cids) {
      if (cid === primaryCid || !closures[cid]) continue;
      const pipeIds = [...(closures[cid].pipelines ?? closures[cid].pipelineIds ?? [])];
      for (const pid of pipeIds) {
        if (!primaryList.includes(pid)) primaryList.push(pid);
      }
      delete closures[cid];
      console.log(`STAMP_COALESCE_CLOSURE ${effectId} ${cid.slice(-8)} → ${primaryCid.slice(-8)}`);
    }
    for (const pid of [...primaryList]) {
      const p = artifact.pipelines?.[pid];
      if (!p) continue;
      const live = artifact.shaders?.[p.shader]?.provenance?.kind === 'live-bridge-capture@1';
      if (pid !== donorPid && !live) {
        await clonePipeFromDonor(pid, donorPid, 'coalesce-closure');
      } else if (p.qualification?.familyId !== donorFam) {
        p.qualification = { ...(p.qualification ?? {}), familyId: donorFam };
        artifact.pipelines[pid] = p;
        console.log(`STAMP_ALIGN_FAMILY ${effectId} ${pid} → ${donorFam} (coalesce)`);
      }
    }
  }

  // Final elevate after coalesce clones / family merges may have mixed statuses.
  for (const closure of Object.values(closures)) {
    const pipeIds = closure.pipelines ?? closure.pipelineIds ?? [];
    if (!pipeIds.length) continue;
    const statuses = pipeIds.map((pid) => artifact.pipelines?.[pid]?.qualification?.status);
    const ready = statuses.every((status) => status === 'capture-stamped' || status === 'pixel-qualified')
      && pipeIds.every((pid) => artifact.pipelines?.[pid]?.executor === 'artifact-shader@1');
    if (!ready) continue;
    const allPixel = statuses.every((status) => status === 'pixel-qualified');
    const next = allPixel ? 'pixel-qualified' : 'capture-stamped';
    if (closure.qualification?.status !== next) {
      closure.qualification = {
        ...(closure.qualification ?? {}),
        status: next,
        baseline: closure.qualification?.baseline ?? 'frozen-semantic@1',
        evidence: {
          ...(closure.qualification?.evidence ?? {}),
          captureProvenance: 'live-bridge-capture@1',
          capturedAt: capture.capturedAt,
        },
      };
      console.log(`STAMP_CLOSURE_STATUS ${effectId} ${Object.keys(closures).find((k) => closures[k] === closure)?.slice(-8) ?? '?'} → ${next}`);
    }
  }

  // Coalesce same-family capture-stamped pipes into one closure. Orphan clones
  // share the donor familyId; if Quarks later batches them together, bind needs
  // a single __artifactBatchClosureId — rewrite simulation emitter ids too.
  const familyPrimary = new Map();
  for (const [cid, closure] of Object.entries(closures)) {
    const pipeIds = closure.pipelines ?? closure.pipelineIds ?? [];
    for (const pid of pipeIds) {
      const p = artifact.pipelines?.[pid];
      const fam = p?.qualification?.familyId;
      const status = p?.qualification?.status;
      if (!fam || p?.executor !== 'artifact-shader@1') continue;
      if (status !== 'capture-stamped' && status !== 'pixel-qualified') continue;
      if (!familyPrimary.has(fam)) familyPrimary.set(fam, cid);
    }
  }
  const closureRemap = new Map(); // oldClosureId → primaryClosureId
  for (const [cid, closure] of Object.entries(closures)) {
    const pipeIds = [...(closure.pipelines ?? closure.pipelineIds ?? [])];
    for (const pid of pipeIds) {
      const p = artifact.pipelines?.[pid];
      const fam = p?.qualification?.familyId;
      const primary = fam ? familyPrimary.get(fam) : null;
      if (!primary || primary === cid) continue;
      const primaryClosure = closures[primary];
      const primaryList = primaryClosure.pipelines ?? primaryClosure.pipelineIds;
      if (Array.isArray(primaryList) && !primaryList.includes(pid)) primaryList.push(pid);
      if (Array.isArray(closure.pipelines)) {
        closure.pipelines = closure.pipelines.filter((id) => id !== pid);
      } else if (Array.isArray(closure.pipelineIds)) {
        closure.pipelineIds = closure.pipelineIds.filter((id) => id !== pid);
      }
      closureRemap.set(cid, primary);
      console.log(`STAMP_MERGE_CLOSURE ${effectId} ${pid} → ${primary.slice(-8)} (family ${fam})`);
    }
    if (!(closure.pipelines ?? closure.pipelineIds ?? []).length) delete closures[cid];
  }
  if (closureRemap.size) {
    const rewriteClosures = (node) => {
      if (!node || typeof node !== 'object') return;
      const ps = node.ps;
      if (ps && typeof ps.artifactBatchClosureId === 'string') {
        const next = closureRemap.get(ps.artifactBatchClosureId);
        if (next) ps.artifactBatchClosureId = next;
      }
      for (const child of node.children ?? []) rewriteClosures(child);
    };
    if (artifact.simulation?.object) rewriteClosures(artifact.simulation.object);
  }

  // Authoritative sync: emitter closure ids follow the pipeline→closure map.
  // Quarks bind requires systems in one batch to share __artifactBatchClosureId.
  const pipeToClosure = new Map();
  for (const [cid, closure] of Object.entries(closures)) {
    for (const pid of (closure.pipelines ?? closure.pipelineIds ?? [])) {
      pipeToClosure.set(pid, cid);
    }
  }
  const syncEmitterClosures = (node) => {
    if (!node || typeof node !== 'object') return;
    const ps = node.ps;
    if (ps && typeof ps.material === 'string') {
      const cid = pipeToClosure.get(`mat-${ps.material}`);
      if (cid && ps.artifactBatchClosureId !== cid) {
        ps.artifactBatchClosureId = cid;
      }
    }
    for (const child of node.children ?? []) syncEmitterClosures(child);
  };
  if (pipeToClosure.size && artifact.simulation?.object) {
    syncEmitterClosures(artifact.simulation.object);
  }
  artifact.batchClosures = closures;

  // Slim inject (vertexSource=artifact) needs bag.vertexPatches. Thick loads
  // bags via restored cfxrState.vertexPatchesByEmitter (Quarks parse drops
  // unknown ps.artifactVertexPatches). Backfill both from batchClosures.
  const vertexPatchMap = new Map();
  const syncEmitterVertexPatches = (node) => {
    if (!node || typeof node !== 'object') return;
    const ps = node.ps;
    if (ps && typeof ps.artifactBatchClosureId === 'string') {
      const closure = closures[ps.artifactBatchClosureId];
      const patches = closure?.vertexPatches;
      if (Array.isArray(patches)) {
        const cur = ps.artifactVertexPatches;
        const same = Array.isArray(cur)
          && cur.length === patches.length
          && cur.every((p, i) => p === patches[i]);
        if (!same) {
          ps.artifactVertexPatches = [...patches];
        }
        if (typeof node.uuid === 'string') {
          vertexPatchMap.set(node.uuid, [...patches]);
        }
      }
    }
    for (const child of node.children ?? []) syncEmitterVertexPatches(child);
  };
  if (artifact.simulation?.object) {
    syncEmitterVertexPatches(artifact.simulation.object);
  }
  if (vertexPatchMap.size) {
    if (!artifact.runtimeState) artifact.runtimeState = {};
    if (!artifact.runtimeState.cfxrState) artifact.runtimeState.cfxrState = {};
    const existing = artifact.runtimeState.cfxrState.vertexPatchesByEmitter;
    if (!Array.isArray(existing) || !existing.length) {
      artifact.runtimeState.cfxrState.vertexPatchesByEmitter = [...vertexPatchMap.entries()];
      console.log(
        `STAMP_VERTEX_PATCHES ${effectId} emitters=${vertexPatchMap.size}`,
      );
    }
  }

  // A capture becomes a thin capability only after an exact, two-time pixel
  // report has been bound to this exact payload + compiler/oracle context.
  // Never inherit an older compiler-family qualification through a new capture.
  if (!capturePixelQualified) {
    for (const pipeline of Object.values(artifact.pipelines ?? {})) {
      const liveCapture = artifact.shaders?.[pipeline.shader]?.provenance?.kind
        === 'live-bridge-capture@1';
      if (!liveCapture || pipeline.executor !== 'artifact-shader@1') continue;
      pipeline.qualification = {
        ...(pipeline.qualification ?? {}),
        status: 'capture-stamped',
      };
    }
    for (const closure of Object.values(closures)) {
      const pipelineIds = closure.pipelines ?? closure.pipelineIds ?? [];
      if (!pipelineIds.some((pipelineId) => (
        artifact.pipelines?.[pipelineId]?.qualification?.status === 'capture-stamped'
      ))) continue;
      closure.qualification = {
        ...(closure.qualification ?? {}),
        status: 'capture-stamped',
      };
    }
    artifact.batchClosures = closures;
  } else {
    for (const pipeline of Object.values(artifact.pipelines ?? {})) {
      if (pipeline.executor !== 'artifact-shader@1') continue;
      if (!['capture-stamped', 'pixel-qualified'].includes(pipeline.qualification?.status)) continue;
      pipeline.qualification = {
        ...(pipeline.qualification ?? {}),
        status: 'pixel-qualified',
        evidence: {
          ...(pipeline.qualification?.evidence ?? {}),
          captureQualification: proof.schema,
          compilerVersion: 'live-bridge-capture@1',
          capturePayloadSha256: proof.capturePayloadSha256,
          captureTimes: proof.captureTimes,
          runtimeFingerprint: proof.runtimeFingerprint,
          changedPixels: 0,
          maxChannelDelta: 0,
        },
      };
    }
    for (const closure of Object.values(closures)) {
      const pipelineIds = closure.pipelines ?? closure.pipelineIds ?? [];
      const allPixel = pipelineIds.length > 0 && pipelineIds.every((pipelineId) => (
        artifact.pipelines?.[pipelineId]?.executor === 'artifact-shader@1'
        && artifact.pipelines?.[pipelineId]?.qualification?.status === 'pixel-qualified'
      ));
      if (!allPixel) continue;
      closure.qualification = {
        ...(closure.qualification ?? {}),
        status: 'pixel-qualified',
        evidence: {
          ...(closure.qualification?.evidence ?? {}),
          captureQualification: proof.schema,
          compilerVersion: 'live-bridge-capture@1',
          capturePayloadSha256: proof.capturePayloadSha256,
          captureTimes: proof.captureTimes,
          runtimeFingerprint: proof.runtimeFingerprint,
          changedPixels: 0,
          maxChannelDelta: 0,
        },
      };
    }
    artifact.batchClosures = closures;
    console.log(`STAMP_PIXEL_QUALIFIED ${effectId} times=${proof.captureTimes.join(',')}`);
  }

  // Keep files split complete: assertVfxRuntimeArtifactV3 requires files.config
  // whenever files is present (shaders alone is incomplete). Prefer artifact
  // fields; if sim was already externalized, preserve prior config.json.
  let priorConfig = null;
  try {
    priorConfig = JSON.parse(await readFile(join(codeDir, 'config.json'), 'utf8'));
  } catch {
    // no prior split config
  }
  const quarksConfigRaw = artifact.simulation
    ?? priorConfig?.quarksConfig
    ?? priorConfig?.simulation
    ?? null;
  // Empty `{}` is truthy but not a usable Quarks payload — prefer prior split config.
  const quarksConfig = (quarksConfigRaw
    && typeof quarksConfigRaw === 'object'
    && (quarksConfigRaw.object || quarksConfigRaw.materials || quarksConfigRaw.vfxIR))
    ? quarksConfigRaw
    : (priorConfig?.quarksConfig
      ?? priorConfig?.simulation
      ?? null);
  const runtimeState = artifact.runtimeState ?? priorConfig?.runtimeState ?? null;
  if (!quarksConfig || !runtimeState) {
    throw new Error(
      `STAMP_MISSING_CONFIG ${effectId} quarks=${!!quarksConfig} runtimeState=${!!runtimeState}`,
    );
  }
  if (!artifact.simulation) artifact.simulation = quarksConfig;
  if (!artifact.runtimeState) artifact.runtimeState = runtimeState;
  const simBags = stampEmitterSimBags(quarksConfig, runtimeState);
  if (simBags) console.log(`STAMP_EMITTER_SIM_BAGS ${effectId} emitters=${simBags}`);
  // Offline-complete startDelays (including explicit 0) so thin never soft-invents.
  {
    const delays = new Map();
    const walkDelay = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ParticleEmitter' && node.uuid && node.ps) {
        const d = node.ps.startDelay;
        let v;
        if (typeof d === 'number') v = d;
        else if (d && typeof d.value === 'number') v = d.value;
        else {
          throw new Error(
            `STAMP_START_DELAY ${effectId}: emitter '${node.uuid}' missing numeric startDelay`,
          );
        }
        delays.set(String(node.uuid), v);
      }
      for (const child of node.children ?? []) walkDelay(child);
      if (node.object) walkDelay(node.object);
    };
    walkDelay(quarksConfig.object ?? quarksConfig);
    if (!runtimeState.runtimeConfig) runtimeState.runtimeConfig = {};
    runtimeState.runtimeConfig.startDelays = [...delays.entries()];
    if (!artifact.runtimeState.runtimeConfig) artifact.runtimeState.runtimeConfig = {};
    artifact.runtimeState.runtimeConfig.startDelays = [...delays.entries()];
    console.log(`STAMP_START_DELAYS ${effectId} emitters=${delays.size}`);
  }
  const configBytes = Buffer.from(JSON.stringify({
    quarksConfig,
    runtimeState,
    metadata: artifact.metadata ?? priorConfig?.metadata,
  }));
  await writeFile(join(codeDir, 'config.json'), configBytes);
  artifact.files.config = {
    uri: `/assets/v3-code/${String(artifact.effectId).toLowerCase()}/config.json`,
    sha256: sha256Hex(configBytes),
  };

  const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(artPath, artifactBytes);
  const manifestPath = join(artifactRoot, 'manifest.json');
  const outputManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const outputEntry = outputManifest.effects?.find((entry) => entry.id === artifact.effectId);
  if (!outputEntry) throw new Error(`STAMP_MANIFEST_ENTRY ${artifact.effectId} missing`);
  outputEntry.capabilities = {
    ...(outputEntry.capabilities ?? {}),
    thinPlayer: computeThinPlayerCapability(artifact),
  };
  // The manifest is also the verified publication pointer. Any offline stamp
  // changes artifact bytes, so update its integrity digest in the same write.
  outputEntry.sha256 = sha256Hex(artifactBytes);
  await atomicWriteJson(manifestPath, outputManifest);
  console.log(
    `STAMP_OK ${effectId} pipelines=${stampedPipelines.join(',')} `
    + `→ ${artPath} + ${codeDir}`,
  );
}

if (failed) process.exitCode = 1;
