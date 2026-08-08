/**
 * Offline walk of Quarks JSON → pending CFXR props / runtime tables.
 * Production QuarksEffectPlayer calls this before load; thin player skips it
 * and relies on artifact-emitter-sim bags + mounts.
 */
import { isParticleMaterialProgram } from '@vfx-factory/artifact-schema';
import adapterRegistry from './semantic-adapters';
import { type CfxrMaterialProps } from './cfxr-material-profile';
import { decodeUnityTrailGeometry } from './cfxr-sim-trail-geometry';

/** Both u/v tile counts absent → 1×1 sheet (no flipbook frame domain). */
const CFXR_TRAJECTORY_TILE_COUNT_SOFT = 1;
/** Age denominators / firstAbsent ordering slack (matches sim-initial). */
const CFXR_TRAJECTORY_AGE_EPS = 1e-6;
/** Terminal age equality tolerance for trajectory-cache@6 contract. */
const CFXR_TRAJECTORY_TERMINAL_AGE_TOL = 1e-3;
import {
  childDurationSubEmitterIds,
  flipbookTimingByEmitter,
  initialStateByEmitter,
  limitVelocity3DByEmitter,
  limitVelocityByEmitter,
  pendingCfxrByEmitter,
  rendererPivotByEmitter,
  resetCfxrRuntimeTables,
  rotation3DByEmitter,
  shapeTransformByEmitter,
  sizeOverLifetimeByEmitter,
  sizeTwoCurvesByEmitter,
  startSizeTwoCurvesByEmitter,
  subEmitterInheritanceByEmitter,
  trajectoryCacheByEmitter,
  trailGeometryByEmitter,
  trailSemanticsByEmitter,
  velocityOverLifetimeByEmitter,
} from './cfxr-runtime-state';

type TextureSamplerSpec = {
  wrap?: [number, number];
  magFilter?: number;
  minFilter?: number;
};

/** Resolve exporter texture uuid → embedded image URL. */
function resolveMapUrl(
  uuid: string | undefined,
  texByUuid: Map<string, any>,
  imgByUuid: Map<string, any>,
): string | undefined {
  if (!uuid) return undefined;
  const tex = texByUuid.get(uuid);
  if (!tex?.image) return undefined;
  const img = imgByUuid.get(tex.image);
  return img?.url && typeof img.url === 'string' ? img.url : undefined;
}

function resolveCfxrMapRefs(
  props: CfxrMaterialProps,
  texByUuid: Map<string, any>,
  imgByUuid: Map<string, any>,
): CfxrMaterialProps {
  const out: CfxrMaterialProps = { ...props };
  const samplerOf = (tex: any): TextureSamplerSpec | undefined => tex ? {
    wrap: Array.isArray(tex.wrap) && tex.wrap.length >= 2
      ? [Number(tex.wrap[0]), Number(tex.wrap[1])]
      : undefined,
    magFilter: Number.isFinite(tex.magFilter) ? Number(tex.magFilter) : undefined,
    minFilter: Number.isFinite(tex.minFilter) ? Number(tex.minFilter) : undefined,
  } : undefined;
  if (!out.dissolveMapUrl && out.dissolveMap) {
    const tex = texByUuid.get(out.dissolveMap);
    if (tex?.name && !out.dissolveTextureName) out.dissolveTextureName = String(tex.name);
    out.dissolveMapUrl = resolveMapUrl(out.dissolveMap, texByUuid, imgByUuid);
    out.dissolveMapSrgb = !!tex?.sRGB;
    out.dissolveSampler = samplerOf(tex);
  }
  if (!out.maskMapUrl && out.maskMap) {
    const tex = texByUuid.get(out.maskMap);
    out.maskMapUrl = resolveMapUrl(out.maskMap, texByUuid, imgByUuid);
    out.maskMapSrgb = !!tex?.sRGB;
    out.maskSampler = samplerOf(tex);
  }
  if (!out.distortionMapUrl && out.distortionMap) {
    const tex = texByUuid.get(out.distortionMap);
    out.distortionMapUrl = resolveMapUrl(out.distortionMap, texByUuid, imgByUuid);
    out.distortionMapSrgb = !!tex?.sRGB;
    out.distortionSampler = samplerOf(tex);
  }
  if (!out.heightMapUrl && out.heightMap) {
    const tex = texByUuid.get(out.heightMap);
    out.heightMapUrl = resolveMapUrl(out.heightMap, texByUuid, imgByUuid);
    out.heightMapSrgb = !!tex?.sRGB;
    out.heightSampler = samplerOf(tex);
  }
  if (!out.orbAlphaMapUrl && out.orbAlphaMap) {
    const tex = texByUuid.get(out.orbAlphaMap);
    out.orbAlphaMapUrl = resolveMapUrl(out.orbAlphaMap, texByUuid, imgByUuid);
    out.orbAlphaMapSrgb = !!tex?.sRGB;
    out.orbAlphaSampler = samplerOf(tex);
  }
  if (!out.orbNoiseMapUrl && out.orbNoiseMap) {
    const tex = texByUuid.get(out.orbNoiseMap);
    out.orbNoiseMapUrl = resolveMapUrl(out.orbNoiseMap, texByUuid, imgByUuid);
    out.orbNoiseMapSrgb = !!tex?.sRGB;
    out.orbNoiseSampler = samplerOf(tex);
  }
  return out;
}

/** Walk Quarks JSON and index material.cfxr by emitter name. */
export function setCfxrPropsFromJson(json: any) {
  resetCfxrRuntimeTables();
  const mats = new Map<string, any>();
  for (const m of json.materials || []) mats.set(m.uuid, m);
  const texByUuid = new Map<string, any>();
  for (const t of json.textures || []) texByUuid.set(t.uuid, t);
  const imgByUuid = new Map<string, any>();
  for (const i of json.images || []) imgByUuid.set(i.uuid, i);
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.ps && o.uuid) {
      const pivot = o.ps.rendererEmitterSettings?.unityPivot;
      if (Array.isArray(pivot) && pivot.length >= 3) {
        const maxSize = o.ps.rendererEmitterSettings?.unityMaxParticleSize;
        if (typeof maxSize !== 'number') {
          throw new Error(
            `emitter '${o.uuid}': unityPivot requires unityMaxParticleSize (no 0.5 invent)`,
          );
        }
        rendererPivotByEmitter.set(o.uuid, [
          Number(pivot[0]), Number(pivot[1]), Number(pivot[2]), Number(maxSize),
        ]);
      }
      if (o.ps.unityShapeTransform) {
        shapeTransformByEmitter.set(o.uuid, o.ps.unityShapeTransform as any);
      }
      if (Array.isArray(o.ps.unityInitialState) && o.ps.unityInitialState.length) {
        initialStateByEmitter.set(o.uuid, o.ps.unityInitialState as any);
      }
      if (o.ps.unitySubEmitterLifecycle?.schema === 'unity-sub-emitter-lifecycle@1'
          && o.ps.unitySubEmitterLifecycle.termination === 'child-duration') {
        childDurationSubEmitterIds.add(o.uuid);
      }
      const inheritance = (o.ps.behaviors ?? [])
        .filter((behavior: any) => behavior?.type === 'EmitSubParticleSystem')
        .map((behavior: any) => behavior.unityInheritance)
        .filter((spec: any) => spec?.schema === 'unity-sub-emitter-inheritance@1');
      if (inheritance.length) subEmitterInheritanceByEmitter.set(o.uuid, inheritance);
      if (o.ps.unityTrajectoryCache?.schema === 'particle-trajectory-cache@4'
          || o.ps.unityTrajectoryCache?.schema === 'particle-trajectory-cache@5'
          || o.ps.unityTrajectoryCache?.schema === 'particle-trajectory-cache@6') {
        if (o.ps.unityTrajectoryCache.schema === 'particle-trajectory-cache@6') {
          const hasU = o.ps.uTileCount != null && o.ps.uTileCount !== '';
          const hasV = o.ps.vTileCount != null && o.ps.vTileCount !== '';
          if (hasU !== hasV) {
            throw new Error(
              `Emitter ${o.name ?? o.uuid} offline tileCounts incomplete: `
              + `uTileCount=${String(o.ps.uTileCount)} vTileCount=${String(o.ps.vTileCount)}`,
            );
          }
          // Both absent → treat as 1×1 (no flipbook frame domain). Do not invent
          // a missing axis as 1 when only one side is authored.
          const cachedTileCount = hasU && hasV
            ? Math.max(1, Number(o.ps.uTileCount) * Number(o.ps.vTileCount))
            : CFXR_TRAJECTORY_TILE_COUNT_SOFT;
          for (const track of o.ps.unityTrajectoryCache.tracks ?? []) {
            const last = track.samples?.[track.samples.length - 1];
            const terminal = track.termination;
            if (!last || !terminal
                || !Array.isArray(terminal.position)
                || terminal.firstAbsentAge + CFXR_TRAJECTORY_AGE_EPS < terminal.lastVisibleAge
                || Math.abs(terminal.lastVisibleAge - last.age) > CFXR_TRAJECTORY_TERMINAL_AGE_TOL) {
              throw new Error(
                `Emitter ${o.name ?? o.uuid} has an incomplete particle-trajectory-cache@6 terminal contract`,
              );
            }
            let priorAge = -Infinity;
            for (const sample of track.samples ?? []) {
              if (!(Number(sample.age) >= priorAge))
                throw new Error(`Emitter ${o.name ?? o.uuid} has non-monotonic trajectory samples`);
              priorAge = Number(sample.age);
              // Broad package discovery may intentionally omit native BakeMesh frame capture
              // for crash-prone marketplace renderers. In that case the live UnityFrameOverLife
              // behavior remains authoritative; the trajectory cache still supplies position,
              // size, color and rotation. Exact captured cells are used when present.
              if (cachedTileCount > 1 && sample.frame != null
                  && (!Number.isInteger(sample.frame)
                    || sample.frame < 0 || sample.frame >= cachedTileCount))
                throw new Error(`Emitter ${o.name ?? o.uuid} trajectory sample has an invalid flipbook frame`);
            }
          }
        }
        trajectoryCacheByEmitter.set(o.uuid, o.ps.unityTrajectoryCache as any);
      }
      if (o.ps.unityTrailSemantics?.schema === 'unity-trail-semantics@1'
          || o.ps.unityTrailSemantics?.schema === 'unity-trail-semantics@2')
        trailSemanticsByEmitter.set(o.uuid, o.ps.unityTrailSemantics as any);
      if (o.ps.unityTrailGeometry?.schema === 'unity-trail-geometry@1'
          || o.ps.unityTrailGeometry?.schema === 'unity-trail-geometry@2')
        trailGeometryByEmitter.set(
          o.uuid,
          decodeUnityTrailGeometry(o.ps.unityTrailGeometry as any),
        );
      if (o.ps.unitySizeOverLifetime?.type === 'UnityTwoCurves@1')
        sizeTwoCurvesByEmitter.set(o.uuid, o.ps.unitySizeOverLifetime);
      else if (o.ps.unitySizeOverLifetime?.schema === 'unity-size-over-lifetime@1')
        sizeOverLifetimeByEmitter.set(o.uuid, o.ps.unitySizeOverLifetime);
      if (o.ps.unityStartSize?.type === 'UnityTwoCurves@1')
        startSizeTwoCurvesByEmitter.set(o.uuid, o.ps.unityStartSize);
      if (o.ps.unityLimitVelocity3D?.schema === 'unity-limit-velocity-3d@1')
        limitVelocity3DByEmitter.set(o.uuid, o.ps.unityLimitVelocity3D);
      if (o.ps.unityLimitVelocity?.schema === 'unity-limit-velocity@1')
        limitVelocityByEmitter.set(o.uuid, o.ps.unityLimitVelocity);
      if (o.ps.unityVelocityOverLifetime?.schema === 'unity-velocity-over-lifetime@1')
        velocityOverLifetimeByEmitter.set(o.uuid, o.ps.unityVelocityOverLifetime);
      if (o.ps.unityRotationOverLifetime3D)
        rotation3DByEmitter.set(o.uuid, o.ps.unityRotationOverLifetime3D);
      const mode = o.ps.unityFlipbookTimeMode;
      const range = o.ps.unityFlipbookSpeedRange;
      if ((mode === 'lifetime' || mode === 'speed') && Array.isArray(range) && range.length >= 2) {
        flipbookTimingByEmitter.set(o.uuid, {
          mode,
          speedRange: [Number(range[0]), Number(range[1])],
        });
      }
      const mat = mats.get(o.ps.material);
      const program = mat?.vfxProgram;
      if (!isParticleMaterialProgram(program)) {
        throw new Error(`Material ${mat?.name ?? o.ps.material} lacks particle-material-program@2`);
      }
      const supportedOps = new Set([
        'sample-main', 'coverage', 'vertex-color', 'tint', 'front-back-lerp',
        'mask', 'dissolve', 'scene-refraction', 'soft-particle-depth',
        'dynamic-alpha-clip', 'hdr-multiply', 'blend', 'manual-graph-lowering', 'legacy-multiply-colored',
        'manual-material-lowering',
        'vertex-color-space',
        'legacy-particle-multiply', 'legacy-particle-premultiply', 'legacy-double-tint',
        'ambient-probe-lighting',
      ]);
      for (const instruction of program.operations) {
        if (!instruction || !supportedOps.has(instruction.op ?? '')) {
          throw new Error(
            `Material ${mat?.name ?? o.ps.material} contains unsupported IR op '${instruction?.op}'`,
          );
        }
      }
      const dynamicClip = program.operations.find(
        (instruction: any) => instruction?.op === 'dynamic-alpha-clip',
      );
      if (dynamicClip && ![
        'custom1.x', 'custom1.y', 'custom1.z', 'custom1.w', 'uv1.x', 'uv1.y',
      ].includes(dynamicClip.source ?? '')) {
        throw new Error(
          `Material ${mat?.name ?? o.ps.material} has unsupported dynamic alpha clip source '${dynamicClip.source}'`,
        );
      }
      const ambientLighting = program.operations.find(
        (instruction: any) => instruction?.op === 'ambient-probe-lighting',
      );
        if (ambientLighting && ambientLighting.model !== 'unity-urp-lit-reference@1') {
        throw new Error(
          `Material ${mat?.name ?? o.ps.material} has unsupported lighting model '${ambientLighting.model}'`,
        );
      }
      const manual = program.operations.find((instruction: any) => instruction?.op === 'manual-graph-lowering');
      if (manual) {
        const match = /^(.*)@(\d+)$/.exec(String(manual.id ?? ''));
        const adapter = match
          ? adapterRegistry.adapters.find((candidate) => candidate.kind === 'material'
              && candidate.id === match[1] && candidate.version === Number(match[2]))
          : undefined;
        if (!adapter || adapter.sourceGraphHash !== program.sourceGraphHash
            || manual.sourceGraphHash !== program.sourceGraphHash) {
          throw new Error(
            `Unreviewed manual graph lowering '${manual.id}' for source ${program.sourceGraphHash}`,
          );
        }
      }
      const manualMaterial = program.operations.find(
        (instruction: any) => instruction?.op === 'manual-material-lowering',
      );
      if (manualMaterial) {
        const match = /^(.*)@(\d+)$/.exec(String(manualMaterial.id ?? ''));
        const adapter = match
          ? adapterRegistry.adapters.find((candidate: any) => candidate.kind === 'material'
              && candidate.id === match[1] && candidate.version === Number(match[2])) as any
          : undefined;
        const registered = adapter?.semantics?.materials?.find(
          (entry: any) => entry.sourceMaterialGuid === program.sourceMaterialGuid,
        );
        if (!adapter || !registered
            || Number(registered.alphaFactor) !== Number(manualMaterial.alphaFactor)
            || manualMaterial.sourceMaterialGuid !== program.sourceMaterialGuid) {
          throw new Error(
            `Unreviewed manual material lowering '${manualMaterial.id}' for material ${program.sourceMaterialGuid}`,
          );
        }
      }
      const vertexColorSpace = program.operations.find(
        (instruction: any) => instruction?.op === 'vertex-color-space',
      );
      if (vertexColorSpace) {
        const match = /^(.*)@(\d+)$/.exec(String(vertexColorSpace.id ?? ''));
        const adapter = match
          ? adapterRegistry.adapters.find((candidate: any) => candidate.kind === 'material'
              && candidate.id === match[1] && candidate.version === Number(match[2])) as any
          : undefined;
        const registered = adapter?.semantics?.materials?.some(
          (entry: any) => entry.sourceMaterialGuid === program.sourceMaterialGuid,
        );
        if (!registered || vertexColorSpace.sourceMaterialGuid !== program.sourceMaterialGuid
            || vertexColorSpace.space !== 'raw-linear-attribute') {
          throw new Error(
            `Unreviewed vertex color space '${vertexColorSpace.id}' for material ${program.sourceMaterialGuid}`,
          );
        }
      }
      if (program?.profile) {
        const resolved = resolveCfxrMapRefs(
          program.profile as CfxrMaterialProps,
          texByUuid,
          imgByUuid,
        );
        // `particle-material-program@2.blend` is the authoritative blend semantic.
        // Do not rely on the legacy profile duplicating it: reviewed shader-family
        // compilers intentionally emit a minimal profile.  Without this lowering,
        // patchCfxrBeforeBatch() replaces the correctly parsed material state with
        // NormalBlending, turning black additive texels into opaque rectangles.
        switch (program.blend) {
          case 'opaque':
            resolved.blendMode = 'opaque';
            resolved.additive = false;
            resolved.legacyMultiplyColored = false;
            resolved.legacyPremultiply = false;
            resolved.zWrite = true;
            break;
          case 'alpha-test':
            resolved.blendMode = 'alpha-test';
            resolved.additive = false;
            resolved.legacyMultiplyColored = false;
            resolved.legacyPremultiply = false;
            break;
          case 'additive':
            resolved.blendMode = 'additive';
            resolved.additive = true;
            resolved.legacyMultiplyColored = false;
            resolved.legacyPremultiply = false;
            break;
          case 'alpha':
            resolved.blendMode = 'alpha';
            resolved.additive = false;
            resolved.legacyMultiplyColored = false;
            resolved.legacyPremultiply = false;
            break;
          case 'multiply':
            resolved.blendMode = 'multiply';
            resolved.additive = false;
            resolved.legacyMultiplyColored = true;
            resolved.legacyPremultiply = false;
            break;
          case 'premultiplied-alpha':
            resolved.blendMode = 'premultiplied-alpha';
            resolved.additive = false;
            resolved.legacyMultiplyColored = false;
            resolved.legacyPremultiply = true;
            break;
          default:
            throw new Error(
              `Unsupported particle-material-program blend '${String(program.blend)}' on ${mat.name ?? mat.uuid}`,
            );
        }
        if (Array.isArray(o.ps.unityRendererFlip)) {
          resolved.flipX = !!o.ps.unityRendererFlip[0];
          resolved.flipY = !!o.ps.unityRendererFlip[1];
        }
        if (program.coverageSource === 'alpha') resolved.coverageChannel = 'alpha';
        else if (program.coverageSource === 'red') resolved.coverageChannel = 'red';
        else if (program.coverageSource === 'green') resolved.coverageChannel = 'green';
        else if (program.coverageSource === 'luminance') resolved.coverageChannel = 'luminance';
        if (dynamicClip) {
          resolved.dynamicAlphaClip = true;
          resolved.dynamicAlphaClipSource = dynamicClip.source as NonNullable<CfxrMaterialProps['dynamicAlphaClipSource']>;
          if (dynamicClip.scale == null || dynamicClip.scale === '') {
            throw new Error(
              `Material ${mat?.name ?? o.ps.material} dynamic alpha clip missing scale (no 1 invent)`,
            );
          }
          resolved.dynamicAlphaClipScale = Number(dynamicClip.scale);
        }
        const mainTexture = texByUuid.get(mat.map ?? mat.texture);
        if (typeof mainTexture?.sRGB === 'boolean') resolved.mainMapSrgb = mainTexture.sRGB;
        pendingCfxrByEmitter.set(o.uuid, resolved);
      }
    }
    if (Array.isArray(o.children)) o.children.forEach(walk);
    if (o.object) walk(o.object);
  };
  walk(json);
}
