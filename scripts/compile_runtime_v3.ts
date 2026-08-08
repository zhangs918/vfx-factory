import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  bakeBridgeBlendState,
  bakeBridgeConstantUniforms,
  emitMaterialShader,
} from '../packages/unity-vfx-compiler/src/index.ts';
import { assertVfxRuntimeArtifactV3, type VfxRuntimeArtifactV3 } from '../packages/vfx-artifact-schema/src/index.ts';
import {
  bakeQuarksVertexModule,
  quarksVertexBakeKey,
} from './lib/bake_quarks_vertex.ts';
import { extractStartDelays } from '../packages/vfx-web-runtime/src/extract-start-delays.ts';

const root = process.cwd();
const frozen = path.join(root, 'public/assets/frozen-quarks');
const out = process.env.VFX_V3_ARTIFACT_DIR
  ? path.resolve(root, process.env.VFX_V3_ARTIFACT_DIR)
  : path.join(root, 'public/assets/v3-artifacts');
const requested = new Set(
  process.argv.slice(2)
    .filter((arg) => !arg.startsWith('-'))
    .map((id) => String(id).toLowerCase()),
);
const manifest = JSON.parse(await readFile(path.join(frozen, 'manifest.json'), 'utf8'));
const resourceIndex = JSON.parse(await readFile(path.join(frozen, 'resources.manifest.json'), 'utf8'));
const materialIndex = JSON.parse(await readFile(path.join(frozen, 'materials.manifest.json'), 'utf8'));
const materialQualification = JSON.parse(await readFile(
  path.join(root, 'config/material-family-qualification.json'), 'utf8',
));
// A qualification proves pixels for both a material family and this exact
// emitter ABI. Bump it whenever emitMaterialShader's executable semantics
// change; stale evidence then deterministically falls back to the bridge.
const MATERIAL_EMITTER_VERSION = 'unity-vfx-material-emitter@10';
const allResources = Object.fromEntries(resourceIndex.resources.map((resource: any) => [resource.id, {
  id: resource.id,
  kind: resource.kind,
  uri: `/assets/v3-resources/${resource.id}${resource.kind === 'geometry' ? '.json' : ''}`,
  sha256: resource.sha256, bytes: resource.bytes,
}]));
const materialById = new Map(materialIndex.materials.map((material: any) => [material.id, material]));
await mkdir(out, { recursive: true });
const compiled: any[] = [];

function computeThinPlayerCapability(artifact: VfxRuntimeArtifactV3): boolean {
  const pipelines = Object.values(artifact.pipelines ?? {});
  const closures = Object.values(artifact.batchClosures ?? {});
  return pipelines.length > 0
    && closures.length > 0
    && artifact.execution.simulation === 'artifact-emitter-sim@1'
    && artifact.execution.trajectory === 'artifact-trajectory@1'
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
    && closures.every((closure) => (
      closure.qualification.status === 'pixel-qualified'
      || closure.qualification.status === 'manual-qualified'
    ));
}

const semanticProfileFingerprint = (value: any): any => {
  if (Array.isArray(value)) return value.map(semanticProfileFingerprint);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    // Embedded/data URLs and resource UUIDs are bindings, not shader-family
    // semantics. Their slot/presence remains represented by the property key.
    .filter(([key]) => !key.endsWith('Url') && !key.endsWith('Map'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, semanticProfileFingerprint(nested)]));
};

const materialFamilyId = (material: any, emitterProfiles: any[], textureSemantics: any) => {
  const normalizedOperations = (material.operations ?? []).map((operation: any) => {
    const copy = { ...operation };
    delete copy.texture;
    delete copy.sourceMaterialGuid;
    delete copy.sourceGraphHash;
    return copy;
  });
  if (material.alphaTest == null || material.alphaTest === '') {
    throw new Error('compile materialFamilyId: alphaTest missing (no invent)');
  }
  const signature = JSON.stringify({
    shaderFamily: material.shaderFamily ?? 'unknown', // corpus omits shaderFamily; keep for family-id stability.
    blend: material.blend,
    srcBlend: material.srcBlend,
    dstBlend: material.dstBlend,
    zWrite: material.zWrite,
    alphaTest: material.alphaTest,
    operations: normalizedOperations,
    // A serialized Unity material is not the complete executable semantic unit:
    // the exporter may attach an emitter-specific profile (coverage channel,
    // dissolve, HDR, graph lowering, etc.) before Quarks batching. Including all
    // profiles that use this material prevents unrelated shaders from sharing a
    // false pixel-qualification proof.
    emitterProfiles: emitterProfiles.map(semanticProfileFingerprint)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    textureSemantics,
  });
  return `material-family-${createHash('sha256').update(signature).digest('hex').slice(0, 16)}`;
};

/** Mirrors the render-state inputs used by BatchedRenderer.equals().  This is
 * deliberately independent from a material-family fingerprint: two authored
 * materials may share one live transparent draw batch, and must be qualified
 * as a unit before either can replace its bridge fragment program. */
const quarksBatchSignature = (node: any, material: any, pipeline: any) => JSON.stringify({
  material: {
    type: (() => {
      if (!material?.type) {
        throw new Error('compile batch signature: material.type missing (no invent)');
      }
      return material.type;
    })(),
    // Quarks source materials omit side; invent FrontSide(0) for signature stability.
    side: material?.side ?? 0,
    blending: pipeline.blend,
    srcBlend: pipeline.srcBlend,
    dstBlend: pipeline.dstBlend,
    premultipliedAlpha: pipeline.blend === 'premultiplied-alpha',
    transparent: !['opaque', 'alpha-test'].includes(pipeline.blend),
    depthTest: (() => {
      if (typeof material?.depthTest !== 'boolean') {
        throw new Error('compile batch signature: material.depthTest missing (no invent)');
      }
      return material.depthTest;
    })(),
    alphaTest: pipeline.blend === 'alpha-test'
      ? (() => {
        if (pipeline.alphaTest == null || pipeline.alphaTest === '') {
          throw new Error('compile batch signature: alpha-test pipeline missing alphaTest (no invent)');
        }
        return Math.max(0.001, Number(pipeline.alphaTest));
      })()
      : 0,
    // Quarks compares texture object identity, not a texture's visual content.
    map: material?.map ?? null,
  },
  renderMode: (() => {
    if (node?.ps?.renderMode == null || node?.ps?.renderMode === '') {
      throw new Error('compile batch signature: emitter renderMode missing (no invent)');
    }
    return Number(node.ps.renderMode);
  })(),
  blendTiles: !!node?.ps?.blendTiles,
  softParticles: !!node?.ps?.softParticles,
  // softFar/Near never authored in current quarks corpus; invent 0 for signature stability.
  softFarFade: Number(node?.ps?.softFarFade ?? 0),
  softNearFade: Number(node?.ps?.softNearFade ?? 0),
  ...(() => {
    const hasU = node?.ps?.uTileCount != null && node?.ps?.uTileCount !== '';
    const hasV = node?.ps?.vTileCount != null && node?.ps?.vTileCount !== '';
    if (hasU !== hasV) {
      throw new Error(
        `compile batch signature: emitter tileCounts incomplete: `
        + `uTileCount=${String(node?.ps?.uTileCount)} vTileCount=${String(node?.ps?.vTileCount)}`,
      );
    }
    // Both absent → 1×1 for signature stability (matches historical ?? 1).
    return {
      uTileCount: hasU ? Number(node.ps.uTileCount) : 1,
      vTileCount: hasV ? Number(node.ps.vTileCount) : 1,
    };
  })(),
  instancingGeometry: node?.ps?.instancingGeometry ?? null,
  renderOrder: (() => {
    if (node?.ps?.renderOrder == null || node?.ps?.renderOrder === '') {
      throw new Error('compile batch signature: emitter renderOrder missing (no invent)');
    }
    return Number(node.ps.renderOrder);
  })(),
  layers: (() => {
    if (node?.ps?.layers == null || node?.ps?.layers === '') {
      throw new Error('compile batch signature: emitter layers missing (no invent)');
    }
    return node.ps.layers;
  })(),
});

const batchClosureId = (signature: string) =>
  `quarks-batch-${createHash('sha256').update(signature).digest('hex').slice(0, 16)}`;

/** three.quarks RenderMode numeric values used by the exporter. */
const RENDER_MODE_STRETCHED = 1;
const RENDER_MODE_VERTICAL = 5;

const cfxrMapHas = (cfxrState: any, key: string, emitterId: string) => {
  const entries = cfxrState?.[key];
  return Array.isArray(entries) && entries.some((entry: any) => entry?.[0] === emitterId);
};

const deriveVertexPatches = (renderMode: number): string[] => {
  const patches = ['cfxr-custom-attrs@1'];
  if (renderMode === RENDER_MODE_STRETCHED) patches.push('unity-centered-stretch@1');
  if (renderMode === RENDER_MODE_VERTICAL) patches.push('unity-vertical-billboard@1');
  return patches;
};

/** Mirror patchCfxrBeforeBatch's conditional mounts for audit-only dual-path. */
const deriveBehaviorMounts = (emitterId: string, renderMode: number, cfxrState: any, hasMap: boolean) => {
  const mounts: string[] = ['material-basics@1'];
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
};

for (const entry of manifest.effects.filter((item: any) => item.status === 'compiled')) {
  if (requested.size && !requested.has(String(entry.id).toLowerCase())) continue;
  const source = JSON.parse(await readFile(path.join(frozen, entry.file), 'utf8'));
  const payload = source.webRuntime.payload;
  const effectIndex = resourceIndex.effects.find((item: any) => item.id === entry.id);
  const effectResourceIds = new Set(Object.values(effectIndex?.resources ?? {}) as string[]);
  // Artifacts are physically self-contained: only resources reachable from this
  // effect are emitted. The global frozen index is an input, never an artifact
  // payload (otherwise a single stale URI invalidates every artifact).
  const resources = Object.fromEntries(Object.entries(allResources)
    .filter(([id]) => effectResourceIds.has(id)));
  const effectMaterials = materialIndex.effects.find((item: any) => item.id === entry.id)?.materials ?? {};
  const shaders: Record<string, any> = {};
  const pipelines: Record<string, any> = {};
  const textureByUuid = new Map((payload.textures ?? []).map((texture: any) => [texture.uuid, texture]));
  const profileByEmitter = new Map(source.webRuntime.cfxrState?.pendingCfxrByEmitter ?? []);
  const normalizedProfileByEmitter = new Map<string, any>();
  const materialProfiles = new Map<string, any[]>();
  const materialTileCounts = new Map<string, Array<[number, number]>>();
  const collectEmitterProfiles = (node: any) => {
    if (node?.type === 'ParticleEmitter' && node?.ps?.material) {
      // Frozen semantic maps are keyed by the stable exported node UUID
      // (`node-0`, ...), not the human-readable emitter name.
      const profileKey = profileByEmitter.has(node.uuid) ? node.uuid : node.name;
      const profile = profileByEmitter.get(profileKey);
      if (profile) {
        const indexedMaterialId = effectMaterials[node.ps.material];
        const indexedMaterial = indexedMaterialId ? materialById.get(indexedMaterialId) as any : undefined;
        // Older frozen exports predate the complete HDR sibling stamp. The
        // material index still contains exporter-resolved depth/cutoff state;
        // carry those explicit values into the compiled profile instead of
        // falling back online. Current exports already provide both fields.
        const normalized = typeof profile.hdrMultiply === 'number'
          ? {
            ...profile,
            zWrite: typeof profile.zWrite === 'boolean'
              ? profile.zWrite
              : indexedMaterial?.zWrite,
            cutoff: typeof profile.cutoff === 'number'
              ? profile.cutoff
              : indexedMaterial?.alphaTest,
          }
          : profile;
        if (typeof normalized.hdrMultiply === 'number'
          && (typeof normalized.zWrite !== 'boolean' || !Number.isFinite(normalized.cutoff))) {
          throw new Error(
            `compile: effect '${entry.id}' emitter '${node.uuid}' cannot resolve HDR zWrite/cutoff from material '${node.ps.material}'`,
          );
        }
        normalizedProfileByEmitter.set(String(profileKey), normalized);
        const profiles = materialProfiles.get(node.ps.material) ?? [];
        profiles.push(normalized);
        materialProfiles.set(node.ps.material, profiles);
      }
      const hasU = node.ps.uTileCount != null && node.ps.uTileCount !== '';
      const hasV = node.ps.vTileCount != null && node.ps.vTileCount !== '';
      if (hasU !== hasV) {
        throw new Error(
          `compile: emitter '${node.uuid}' offline tileCounts incomplete: `
          + `uTileCount=${String(node.ps.uTileCount)} vTileCount=${String(node.ps.vTileCount)}`,
        );
      }
      if (hasU && hasV) {
        const tiles: [number, number] = [
          Math.max(1, Number(node.ps.uTileCount)),
          Math.max(1, Number(node.ps.vTileCount)),
        ];
        const tileList = materialTileCounts.get(node.ps.material) ?? [];
        tileList.push(tiles);
        materialTileCounts.set(node.ps.material, tileList);
      }
    }
    for (const child of node?.children ?? []) collectEmitterProfiles(child);
  };
  collectEmitterProfiles(payload.object);
  for (const material of payload.materials ?? []) {
    const materialId = effectMaterials[material.uuid];
    const indexed = materialId ? materialById.get(materialId) : undefined;
    if (!indexed) continue;
    const shaderId = `shader-${materialId}`;
    const textures: Record<string, string> = {};
    const textureSemantics: Record<string, unknown> = {};
    // Preserve semantic texture slot names in the artifact. The runtime must bind
    // `main`, `mask`, `distortion`, etc. deterministically; taking the first map
    // is incorrect for materials that expose multiple textures.
    for (const [slot, resourceUuid] of Object.entries(indexed.textureSlots ?? {})) {
      const texture = textureByUuid.get(resourceUuid as string) as any;
      const sourceUuid = texture?.image ?? resourceUuid;
      const ref = effectIndex?.resources?.[sourceUuid as string];
      if (ref) {
        textures[String(slot)] = ref;
        const resource = allResources[ref];
        textureSemantics[String(slot)] = {
          sha256: resource?.sha256,
          colorSpace: texture?.colorSpace ?? 'unknown',
          wrapS: texture?.wrap?.[0] ?? texture?.wrapS,
          wrapT: texture?.wrap?.[1] ?? texture?.wrapT,
          minFilter: texture?.minFilter,
          magFilter: texture?.magFilter,
          flipY: texture?.flipY,
        };
      }
    }
    const familyId = materialFamilyId(
      indexed,
      materialProfiles.get(material.uuid) ?? [],
      textureSemantics,
    );
    const evidence = materialQualification.families?.[familyId];
    if (!shaders[shaderId]) {
      shaders[shaderId] = { id: shaderId, ...emitMaterialShader({
        operations: indexed.operations,
        emitterProfiles: materialProfiles.get(material.uuid) ?? [],
        // Profile carries flags the op list does not (e.g. singleChannel /
        // Alpha8). Prefer the first live emitter profile for this material.
        profile: (materialProfiles.get(material.uuid) ?? [])[0],
        lowering: indexed.lowering,
      }) };
      if (evidence?.status === 'pixel-qualified'
        && evidence?.evidence?.compilerVersion === MATERIAL_EMITTER_VERSION
        && shaders[shaderId].profileCompatible) {
        shaders[shaderId].execution = 'quarks-fragment-v1';
      }
    }
    const executable = evidence?.status === 'pixel-qualified'
      && evidence?.evidence?.compilerVersion === MATERIAL_EMITTER_VERSION
      && shaders[shaderId].profileCompatible;
    // Bake constant fragment uniforms + effective blend state from the same
    // CFXR props the bridge uses. Only emit when every emitter profile that
    // shares this material agrees — otherwise the live batch would also be
    // ambiguous and must stay bridge-owned.
    const profiles = materialProfiles.get(material.uuid) ?? [];
    const baked = profiles.length
      ? bakeBridgeConstantUniforms(profiles[0])
      : bakeBridgeConstantUniforms({});
    const bakedBlend = profiles.length
      ? bakeBridgeBlendState(profiles[0])
      : bakeBridgeBlendState({});
    const profilesAgree = profiles.every((profile: any) => {
      const candidate = bakeBridgeConstantUniforms(profile);
      return JSON.stringify(candidate) === JSON.stringify(baked);
    });
    const blendProfilesAgree = profiles.every((profile: any) => (
      JSON.stringify(bakeBridgeBlendState(profile)) === JSON.stringify(bakedBlend)
    ));
    const tileCandidates = materialTileCounts.get(material.uuid) ?? [];
    const bakedTiles = tileCandidates[0];
    const tileCountsAgree = !!bakedTiles && tileCandidates.every(
      (tiles) => tiles[0] === bakedTiles[0] && tiles[1] === bakedTiles[1],
    );
    pipelines[materialId] = {
      materialId: material.uuid,
      blend: indexed.blend,
      srcBlend: indexed.srcBlend,
      dstBlend: indexed.dstBlend,
      zWrite: indexed.zWrite,
      alphaTest: indexed.alphaTest,
      shader: shaderId,
      textures,
      ...(profilesAgree ? { uniformValues: baked } : {}),
      ...(blendProfilesAgree ? { blendState: bakedBlend } : {}),
      ...(tileCountsAgree ? { tileCounts: bakedTiles } : {}),
      executor: executable ? 'artifact-shader@1' : 'semantic-bridge@1',
      qualification: {
        status: executable ? 'pixel-qualified' : 'bridge',
        familyId,
        baseline: 'frozen-semantic@1',
        ...(evidence?.evidence ? { evidence: evidence.evidence } : {}),
      },
    };
  }
  const sourceMaterials = new Map((payload.materials ?? []).map((material: any) => [material.uuid, material]));
  const batchClosures: Record<string, any> = {};
  const vertexPatchesByEmitter: Array<[string, string[]]> = [];
  const behaviorMountByEmitter: Array<[string, { schema: string; mounts: string[] }]> = [];
  const sourceCfxrState = source.webRuntime.cfxrState ?? {};
  const cfxrState = {
    ...sourceCfxrState,
    pendingCfxrByEmitter: (sourceCfxrState.pendingCfxrByEmitter ?? []).map(
      ([emitterId, profile]: [string, any]) => [
        emitterId,
        normalizedProfileByEmitter.get(String(emitterId)) ?? profile,
      ],
    ),
  };
  const collectBatchClosures = (node: any) => {
    if (node?.type === 'ParticleEmitter' && node?.ps?.material) {
      const pipelineId = effectMaterials[node.ps.material];
      const pipeline = pipelineId ? pipelines[pipelineId] : undefined;
      const material = sourceMaterials.get(node.ps.material);
      if (pipeline && material) {
        const renderSignature = quarksBatchSignature(node, material, pipeline);
        const id = batchClosureId(renderSignature);
        if (node?.ps?.renderMode == null || node?.ps?.renderMode === '') {
          throw new Error(`compile: emitter '${String(node.uuid)}' missing renderMode (no invent)`);
        }
        const renderMode = Number(node.ps.renderMode);
        const vertexPatches = deriveVertexPatches(renderMode);
        const closure = batchClosures[id] ??= {
          id,
          emitterIds: [],
          pipelineIds: [],
          renderSignature,
          vertexPatches,
          qualification: { status: 'bridge', baseline: 'frozen-semantic@1' },
        };
        closure.emitterIds.push(String(node.uuid));
        if (!closure.pipelineIds.includes(pipelineId)) closure.pipelineIds.push(pipelineId);
        // Persist the offline closure binding so the player can audit live
        // Quarks batches and gate artifact-shader replacement on closure
        // pixel qualification.
        node.ps.artifactBatchClosureId = id;
        node.ps.artifactVertexPatches = vertexPatches;
        const mounts = deriveBehaviorMounts(
          String(node.uuid),
          renderMode,
          cfxrState,
          !!material.map,
        );
        node.ps.artifactBehaviorMount = { schema: 'cfxr-behavior-mount@1', mounts };
        // Offline stream defaults: unityRendererFlip implies custom1/2 must be
        // corpus-stamped (historical zeros). Thin refuses runtime invent.
        if (Array.isArray(node.ps.unityRendererFlip)) {
          if (!Array.isArray(node.ps.artifactDefaultCustom1)
            || node.ps.artifactDefaultCustom1.length !== 4
            || node.ps.artifactDefaultCustom1.some((v: unknown) => typeof v !== 'number')) {
            node.ps.artifactDefaultCustom1 = [0, 0, 0, 0];
          }
          if (!Array.isArray(node.ps.artifactDefaultCustom2)
            || node.ps.artifactDefaultCustom2.length !== 4
            || node.ps.artifactDefaultCustom2.some((v: unknown) => typeof v !== 'number')) {
            node.ps.artifactDefaultCustom2 = [0, 0, 0, 0];
          }
        }
        const mainTex = material.map || material.texture
          ? textureByUuid.get(material.map ?? material.texture)
          : undefined;
        if (typeof (mainTex as any)?.sRGB === 'boolean') {
          node.ps.artifactMainMapSrgb = !!(mainTex as any).sRGB;
        }
        const pivotEntries = Array.isArray(cfxrState.rendererPivotByEmitter)
          ? cfxrState.rendererPivotByEmitter
          : [];
        const pivot = pivotEntries.find((entry: any) => entry?.[0] === String(node.uuid))?.[1];
        if (Array.isArray(pivot)) {
          if (pivot.length < 4) {
            throw new Error(
              `compile: rendererPivot for emitter '${String(node.uuid)}' requires 4 components (no w invent)`,
            );
          }
          node.ps.artifactRendererPivot = [
            Number(pivot[0]),
            Number(pivot[1]),
            Number(pivot[2]),
            Number(pivot[3]),
          ];
        }
        const custom1Entries = Array.isArray(cfxrState.custom1CurvesByEmitter)
          ? cfxrState.custom1CurvesByEmitter
          : [];
        const custom1 = custom1Entries.find((entry: any) => entry?.[0] === String(node.uuid))?.[1];
        if (Array.isArray(custom1) && custom1.length === 4) {
          node.ps.artifactCustom1Curves = custom1;
        }
        // Mirror map-only tables onto ps when the exporter left them only in cfxrState.
        const bakePs = (mapKey: string, psKey: string) => {
          if (node.ps[psKey] != null) return;
          const entries = Array.isArray(cfxrState[mapKey]) ? cfxrState[mapKey] : [];
          const value = entries.find((entry: any) => entry?.[0] === String(node.uuid))?.[1];
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
        const addBagMount = (condition: unknown, ...ids: string[]) => {
          if (condition) mounts.push(...ids);
        };
        addBagMount(node.ps.unityShapeTransform, 'shape-transform@1');
        addBagMount(Array.isArray(node.ps.unityInitialState) && node.ps.unityInitialState.length,
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
        const flipTiming = Array.isArray(cfxrState.flipbookTimingByEmitter)
          ? cfxrState.flipbookTimingByEmitter.find((entry: any) => entry?.[0] === String(node.uuid))?.[1]
          : undefined;
        if (flipTiming?.mode && Array.isArray(flipTiming.speedRange) && node.ps.unityFlipbookTimeMode == null) {
          node.ps.unityFlipbookTimeMode = flipTiming.mode;
          node.ps.unityFlipbookSpeedRange = flipTiming.speedRange;
        }
        // Sub-emitter inheritance lives on EmitSubParticleSystem edges. Mirror the
        // cfxrState table onto ps so thin bags / collectArtifactEmitterSim do not
        // need runtime-state map fallback.
        const inheritanceEntries = Array.isArray(cfxrState.subEmitterInheritanceByEmitter)
          ? cfxrState.subEmitterInheritanceByEmitter
          : [];
        const inheritanceSpecs = inheritanceEntries.find(
          (entry: any) => entry?.[0] === String(node.uuid),
        )?.[1];
        if (Array.isArray(inheritanceSpecs) && inheritanceSpecs.length) {
          node.ps.artifactSubEmitterInheritance = inheritanceSpecs;
          const subBehaviors = (node.ps.behaviors ?? [])
            .filter((behavior: any) => behavior?.type === 'EmitSubParticleSystem');
          for (let i = 0; i < subBehaviors.length; i++) {
            const spec = inheritanceSpecs[i];
            if (spec?.schema === 'unity-sub-emitter-inheritance@1'
              && subBehaviors[i].unityInheritance == null) {
              subBehaviors[i].unityInheritance = spec;
            }
          }
        }
        vertexPatchesByEmitter.push([String(node.uuid), vertexPatches]);
        behaviorMountByEmitter.push([String(node.uuid), { schema: 'cfxr-behavior-mount@1', mounts }]);
      }
    }
    // Child-duration targets may lack a material pipeline; still stamp lifecycle.
    if (node?.type === 'ParticleEmitter' && node?.ps) {
      const childIds = Array.isArray(cfxrState.childDurationSubEmitterIds)
        ? cfxrState.childDurationSubEmitterIds
        : [];
      if (childIds.includes(String(node.uuid))
        && node.ps.unitySubEmitterLifecycle?.termination !== 'child-duration') {
        node.ps.unitySubEmitterLifecycle = {
          schema: 'unity-sub-emitter-lifecycle@1',
          termination: 'child-duration',
        };
      }
    }
    for (const child of node?.children ?? []) collectBatchClosures(child);
  };
  collectBatchClosures(payload.object);
  // Offline-complete initial-state streams (flip/custom). Thin requireStreamStamps
  // refuses runtime invent when emitter bags carry stream defaults.
  // Emitter-level unityRendererFlip is folded into material CFXR_FLIP_* defines
  // (cfxr-props-from-json). Particle-stream rendererFlip must stay identity —
  // copying unityRendererFlip here double-flips Y vs thick (which invents
  // CFXR_STREAM_FLIP_IDENTITY when stamps are absent).
  const stampInitialStateStreams = (node: any) => {
    if (node?.type === 'ParticleEmitter' && Array.isArray(node.ps?.unityInitialState)) {
      for (const state of node.ps.unityInitialState) {
        if (!state || typeof state !== 'object') continue;
        // Always identity — including rewrite of legacy unityRendererFlip copies.
        state.rendererFlip = [false, false];
        if (!Array.isArray(state.custom1) || state.custom1.length !== 4
          || state.custom1.some((v: unknown) => typeof v !== 'number')) {
          state.custom1 = [0, 0, 0, 0];
        }
        if (!Array.isArray(state.custom2) || state.custom2.length !== 4
          || state.custom2.some((v: unknown) => typeof v !== 'number')) {
          state.custom2 = [0, 0, 0, 0];
        }
      }
    }
    for (const child of node?.children ?? []) stampInitialStateStreams(child);
  };
  stampInitialStateStreams(payload.object);
  // Bake Quarks+patches vertex into each shader once. Thin player binds it;
  // production still patches live stock. Refuse bake when one shader id is
  // shared across disagreeing renderMode/patch sets (would be ambiguous).
  const shaderVertexMeta = new Map<string, { renderMode: number; patches: string[]; key: string }>();
  const collectShaderVertexMeta = (node: any) => {
    if (node?.type === 'ParticleEmitter' && node?.ps?.material) {
      const pipelineId = effectMaterials[node.ps.material];
      const pipeline = pipelineId ? pipelines[pipelineId] : undefined;
      if (pipeline?.shader) {
        if (node?.ps?.renderMode == null || node?.ps?.renderMode === '') {
          throw new Error(`compile: emitter '${String(node.uuid)}' missing renderMode (no invent)`);
        }
        const renderMode = Number(node.ps.renderMode);
        const patches = deriveVertexPatches(renderMode);
        const key = quarksVertexBakeKey(renderMode, patches);
        const prior = shaderVertexMeta.get(pipeline.shader);
        if (prior && prior.key !== key) {
          throw new Error(
            `${entry.id}: shader '${pipeline.shader}' shared across incompatible vertex bakes `
            + `(${prior.key} vs ${key})`,
          );
        }
        if (!prior) shaderVertexMeta.set(pipeline.shader, { renderMode, patches, key });
      }
    }
    for (const child of node?.children ?? []) collectShaderVertexMeta(child);
  };
  collectShaderVertexMeta(payload.object);
  for (const [shaderId, meta] of shaderVertexMeta) {
    const module = shaders[shaderId];
    if (!module) continue;
    const baked = bakeQuarksVertexModule(meta.renderMode, meta.patches);
    module.vertex = baked.vertex;
    module.vertexExecution = baked.vertexExecution;
  }
  // A closure is executable only when every member pipeline already carries
  // matching pixel evidence. Single-pipeline closures inherit that proof;
  // mixed/unproven members stay on the semantic bridge.
  for (const closure of Object.values(batchClosures)) {
    const memberEvidence = closure.pipelineIds.map((pipelineId: string) => {
      const pipeline = pipelines[pipelineId];
      return pipeline?.qualification?.status === 'pixel-qualified'
        && pipeline.qualification.evidence?.compilerVersion === MATERIAL_EMITTER_VERSION
        ? pipeline.qualification.evidence
        : null;
    });
    if (!memberEvidence.length || memberEvidence.some((evidence: any) => !evidence)) continue;
    const first = memberEvidence[0];
    const sameEvidence = memberEvidence.every((evidence: any) =>
      evidence.compilerVersion === first.compilerVersion
      && evidence.changedPixels === first.changedPixels
      && evidence.maxChannelDelta === first.maxChannelDelta
      && JSON.stringify(evidence.captureTimes) === JSON.stringify(first.captureTimes));
    if (!sameEvidence) continue;
    closure.qualification = {
      status: 'pixel-qualified',
      baseline: 'frozen-semantic@1',
      evidence: { ...first },
    };
  }
  // Offline emitter sim bags (artifactBehaviorMount + unity*/artifact* on ps)
  // are enough for ArtifactQuarksPlayer; stamp the dedicated executor when every
  // material-bearing emitter carries a mount manifest.
  let materialEmitters = 0;
  let mountedEmitters = 0;
  const countMounted = (node: any) => {
    if (node?.type === 'ParticleEmitter' && node?.ps?.material) {
      materialEmitters += 1;
      if (node.ps.artifactBehaviorMount?.schema === 'cfxr-behavior-mount@1') mountedEmitters += 1;
    }
    for (const child of node?.children ?? []) countMounted(child);
  };
  countMounted(payload.object);
  const simulationExecutor = materialEmitters > 0 && mountedEmitters === materialEmitters
    ? 'artifact-emitter-sim@1' as const
    : 'semantic-bridge@1' as const;
  // Trajectory ownership is independent from whether an effect happens to use a
  // sampled trajectory. `artifact-trajectory@1` means every authored trajectory
  // input is closed over by the effect-local emitter bag; an empty set is a valid
  // closed set. Never infer this merely from simulationExecutor.
  const trajectoryEntries = Array.isArray(cfxrState.trajectoryCacheByEmitter)
    ? cfxrState.trajectoryCacheByEmitter
    : [];
  const emittersById = new Map<string, any>();
  const collectEmitters = (node: any) => {
    if (node?.type === 'ParticleEmitter' && typeof node.uuid === 'string') {
      emittersById.set(String(node.uuid), node);
    }
    for (const child of node?.children ?? []) collectEmitters(child);
  };
  collectEmitters(payload.object);
  const validTrajectorySchemas = new Set([
    'particle-trajectory-cache@4',
    'particle-trajectory-cache@5',
    'particle-trajectory-cache@6',
  ]);
  let trajectoryClosed = true;
  const trajectoryByEmitter = new Map<string, any>();
  for (const entry of trajectoryEntries) {
    const emitterId = typeof entry?.[0] === 'string' ? entry[0] : '';
    const cache = entry?.[1];
    if (!emitterId || !cache || !validTrajectorySchemas.has(cache.schema)
      || trajectoryByEmitter.has(emitterId)) {
      trajectoryClosed = false;
      continue;
    }
    trajectoryByEmitter.set(emitterId, cache);
  }
  for (const [emitterId, emitter] of emittersById) {
    const cache = emitter.ps?.unityTrajectoryCache;
    const declared = emitter.ps?.artifactBehaviorMount?.mounts;
    const sourceCache = trajectoryByEmitter.get(emitterId);
    if (cache != null) {
      if (!validTrajectorySchemas.has(cache.schema)
        || !Array.isArray(declared)
        || !declared.includes('trajectory-cache@1')) trajectoryClosed = false;
    }
    if (sourceCache != null && JSON.stringify(cache) !== JSON.stringify(sourceCache)) {
      trajectoryClosed = false;
    }
  }
  for (const emitterId of trajectoryByEmitter.keys()) {
    if (!emittersById.has(emitterId)) trajectoryClosed = false;
  }
  const trajectoryExecutor = trajectoryClosed
    ? 'artifact-trajectory@1' as const
    : 'semantic-bridge@1' as const;
  const seed = source.vfxIR?.seed;
  const fixedDelta = source.vfxIR?.fixedDelta;
  if (typeof seed !== 'number') {
    throw new Error(`compile: effect '${entry.id}' missing vfxIR.seed`);
  }
  if (!(typeof fixedDelta === 'number' && fixedDelta > 0)) {
    throw new Error(`compile: effect '${entry.id}' missing positive vfxIR.fixedDelta`);
  }
  // Offline-complete startDelays (including explicit 0) so thin never invents.
  const startDelays = [...extractStartDelays(payload).entries()];
  const artifact: VfxRuntimeArtifactV3 = {
    schema: 'vfx-runtime-artifact@3',
    effectId: entry.id,
    compiler: { name: 'unity-vfx-offline-compiler', version: '3.0.0' },
    simulation: payload,
    pipelines,
    batchClosures,
    shaders,
    resources,
    metadata: { sourceSchema: source.vfxIR?.schema, seed, fixedDelta },
    execution: {
      material: 'per-pipeline@1',
      simulation: simulationExecutor,
      trajectory: trajectoryExecutor,
    },
    runtimeState: {
      cfxrState: {
        ...cfxrState,
        vertexPatchesByEmitter,
        behaviorMountByEmitter,
      },
      runtimeConfig: {
        ...(source.webRuntime?.runtimeConfig ?? {}),
        startDelays,
      },
    },
  };
  assertVfxRuntimeArtifactV3(artifact);
  await writeFile(path.join(out, entry.file), JSON.stringify(artifact));
  compiled.push({
    ...entry,
    artifact: `/assets/v3-artifacts/${entry.file}`,
    capabilities: { thinPlayer: computeThinPlayerCapability(artifact) },
  });
}
const manifestPath = path.join(out, 'manifest.json');
if (requested.size) {
  // Targeted recompile: merge into the existing artifact manifest (do not drop siblings).
  let prior: { schema?: string; effects?: any[] } = { schema: 'vfx-runtime-artifact-manifest@3', effects: [] };
  try {
    prior = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    // First targeted run against an empty out dir.
  }
  const byId = new Map((prior.effects ?? []).map((effect: any) => [effect.id, effect]));
  for (const effect of compiled) byId.set(effect.id, { ...(byId.get(effect.id) ?? {}), ...effect });
  await writeFile(
    manifestPath,
    JSON.stringify({
      schema: prior.schema ?? 'vfx-runtime-artifact-manifest@3',
      effects: [...byId.values()],
    }, null, 2),
  );
  console.log(`compiled ${compiled.length} v3 artifacts (targeted; manifest merged)`);
} else {
  await writeFile(manifestPath, JSON.stringify({ schema: 'vfx-runtime-artifact-manifest@3', effects: compiled }, null, 2));
  console.log(`compiled ${compiled.length} v3 artifacts`);
}
