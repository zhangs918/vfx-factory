import {
  AdditiveBlending,
  AddEquation,
  CustomBlending,
  DstColorFactor,
  OneFactor,
  OneMinusSrcAlphaFactor,
  NormalBlending,
  SrcColorFactor,
  ZeroFactor,
} from 'three';
import { expandCfxrRingGeometry } from './cfxr-ring-geometry';
import type { CfxrMaterialProps } from './cfxr-material-profile';
export type { CfxrMaterialProps } from './cfxr-material-profile';
export { expandCfxrRingGeometry } from './cfxr-ring-geometry';

export function normalizeUnityQuarksJson(json: any): any {
  expandCfxrRingGeometry(json);

  // Legacy/oversized exports can lose an editor-only mesh reference. Keep them loadable with
  // an explicit editable quad fallback; new exports still carry the authored mesh and basis.
  if (!Array.isArray(json.geometries)) {
    throw new Error('normalizeUnityQuarksJson: geometries[] required (no invent)');
  }
  const fallbackGeometryUuid = '__unity_mesh_fallback_quad@1';
  if (!json.geometries.some((g: any) => g?.uuid === fallbackGeometryUuid)) {
    json.geometries.push({
      uuid: fallbackGeometryUuid,
      type: 'QuarksGeometry',
      positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
      indices: [0, 2, 1, 0, 3, 2],
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    });
  }
  const patchMissingMeshBasis = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.ps?.renderMode === 2
        && (!o.ps.unityMeshRendererBasis || !o.ps.instancingGeometry)) {
      o.ps.instancingGeometry = fallbackGeometryUuid;
      o.ps.unityMeshRendererBasis = {
        schema: 'unity-mesh-renderer-basis@1', pivot: [0, 0, 0],
        scaleSource: 'particle-current-size', handedness: 'reflect-z-once',
        lowering: 'missing-source-quad-fallback@1',
      };
    }
    if (Array.isArray(o.children)) o.children.forEach(patchMissingMeshBasis);
  };
  patchMissingMeshBasis(json.object);

  // Compile Unity's renderer pivot into the unit Mesh before Quarks creates its instancing
  // geometry. Pivot is measured in particle-size units and therefore must be applied before
  // the per-particle current-size and quaternion TRS. Shape/hierarchy scales are deliberately
  // absent from this operation: each coordinate-space transform has one owner.
  const geometries = new Map<string, any>();
  for (const geometry of json.geometries) geometries.set(geometry.uuid, geometry);
  const lowerMeshBasis = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'ParticleEmitter' && o.ps?.unitySubEmitterLifecycle) {
      const lifecycle = o.ps.unitySubEmitterLifecycle;
      if (lifecycle.schema !== 'unity-sub-emitter-lifecycle@1'
          || lifecycle.ownership !== 'parent-event'
          || lifecycle.looping !== true
          || lifecycle.termination !== 'child-duration'
          || o.ps.onlyUsedByOther !== true
          || o.ps.looping !== true
          || o.ps.unitySpawnSchedule
          || o.ps.unityInitialState
          || o.ps.unityTrajectoryCache) {
        throw new Error(`Emitter ${o.name ?? o.uuid} has an invalid live sub-emitter lifecycle contract`);
      }
    }
    if (o.type === 'ParticleEmitter' && Array.isArray(o.ps?.behaviors)) {
      for (const behavior of o.ps.behaviors) {
        if (behavior?.type !== 'EmitSubParticleSystem') continue;
        const inheritance = behavior.unityInheritance;
        if (inheritance?.schema !== 'unity-sub-emitter-inheritance@1'
            || typeof inheritance.size !== 'boolean'
            || typeof inheritance.color !== 'boolean'
            || typeof inheritance.rotation !== 'boolean'
            || typeof inheritance.lifetime !== 'boolean') {
          throw new Error(`Emitter ${o.name ?? o.uuid} has an unsupported sub-emitter inheritance contract`);
        }
      }
    }
    if (o.type === 'ParticleEmitter' && o.ps?.renderMode === 2) {
      const alignment = o.ps.unityRendererAlignment;
      if (alignment?.schema === 'unity-renderer-alignment@1'
          && alignment.lowering === 'local-billboard-instanced-quad') {
        if (alignment.sourceRenderMode !== 'Billboard' || alignment.alignment !== 'Local')
          throw new Error(`Emitter ${o.name ?? o.uuid} has an invalid local billboard lowering`);
      }
      const basis = o.ps.unityMeshRendererBasis;
      if (basis?.schema !== 'unity-mesh-renderer-basis@1') {
        throw new Error(`Mesh emitter ${o.name ?? o.uuid} lacks unity-mesh-renderer-basis@1`);
      }
      const geometry = geometries.get(o.ps.instancingGeometry);
      const pivot = basis.pivot;
      if (!geometry || !Array.isArray(geometry.positions) || !Array.isArray(pivot)) {
        throw new Error(`Mesh emitter ${o.name ?? o.uuid} has an invalid renderer basis`);
      }
      if (!geometry.__unityMeshBasisLowered) {
        for (let i = 0; i + 2 < geometry.positions.length; i += 3) {
          geometry.positions[i] -= Number(pivot[0]) || 0;
          geometry.positions[i + 1] -= Number(pivot[1]) || 0;
          geometry.positions[i + 2] -= Number(pivot[2]) || 0;
        }
        geometry.__unityMeshBasisLowered = true;
      }
    }
    if (Array.isArray(o.children)) o.children.forEach(lowerMeshBasis);
  };
  lowerMeshBasis(json.object);

  // Exporter attaches "(emitter source)" Mesh nodes for mesh_surface shape references.
  // They carry no material — ObjectLoader would render them as default white meshes.
  const hideSourceMeshes = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'Mesh' && typeof o.name === 'string' && o.name.endsWith('(emitter source)')) {
      o.visible = false;
    }
    if (Array.isArray(o.children)) o.children.forEach(hideSourceMeshes);
  };
  hideSourceMeshes(json.object);

  if (Array.isArray(json.materials)) {
    for (const m of json.materials) {
      if (m.type !== 'QuarksMaterial' && m.type !== 'MeshBasicMaterial') continue;
      if (typeof m.blending !== 'number') {
        throw new Error(
          `Material ${m.name ?? m.uuid} missing numeric blending (no invent)`,
        );
      }
      const quarksBlend = m.blending; // 1=add, 2=alpha, 4=multiply, …
      const program = m.vfxProgram as { schema?: string; profile?: CfxrMaterialProps; blend?: string } | undefined;
      if (program?.schema !== 'particle-material-program@2') {
        throw new Error(`Material ${m.name ?? m.uuid} has no strict particle material program`);
      }
      const semanticProfile = program.profile;
      const additive = program.blend === 'additive' || quarksBlend === 1;
      const multiply = program.blend === 'multiply' || quarksBlend === 4;
      const legacyMultiply = !!semanticProfile?.legacyMultiply;
      const legacyPremultiply = program.blend === 'premultiplied-alpha' || !!semanticProfile?.legacyPremultiply;
      m.type = 'MeshBasicMaterial';
      // Alias Unity `texture` → three `map` when only the former is authored.
      if (m.map == null && m.texture != null) m.map = m.texture;
      if (typeof m.transparent !== 'boolean') {
        throw new Error(`Material ${m.name ?? m.uuid} missing transparent (no invent)`);
      }
      if (typeof m.depthWrite !== 'boolean') {
        throw new Error(`Material ${m.name ?? m.uuid} missing depthWrite (no invent)`);
      }
      if (typeof m.depthTest !== 'boolean') {
        throw new Error(`Material ${m.name ?? m.uuid} missing depthTest (no invent)`);
      }
      // Pending corpus stamps side/toneMapped; do not invent DoubleSide / false.
      if (m.side == null) {
        throw new Error(`Material ${m.name ?? m.uuid} missing side (no invent)`);
      }
      if (typeof m.toneMapped !== 'boolean') {
        throw new Error(`Material ${m.name ?? m.uuid} missing toneMapped (no invent)`);
      }
      if (typeof m.premultipliedAlpha !== 'boolean') {
        throw new Error(`Material ${m.name ?? m.uuid} missing premultipliedAlpha (no invent)`);
      }
      if (legacyMultiply) {
        m.blending = CustomBlending;
        m.blendEquation = AddEquation;
        m.blendSrc = ZeroFactor;
        m.blendDst = SrcColorFactor;
        m.blendEquationAlpha = AddEquation;
        m.blendSrcAlpha = ZeroFactor;
        m.blendDstAlpha = OneFactor;
        // Corpus stamps false; keep authored premultipliedAlpha (no invent).
      } else if (legacyPremultiply) {
        m.blending = CustomBlending;
        m.blendEquation = AddEquation;
        m.blendSrc = OneFactor;
        m.blendDst = OneMinusSrcAlphaFactor;
        m.blendEquationAlpha = AddEquation;
        m.blendSrcAlpha = ZeroFactor;
        m.blendDstAlpha = OneFactor;
      } else if (multiply) {
        // Unity shader source declares Blend DstColor Zero. Three's MultiplyBlending preset
        // retains OneMinusSrcAlpha, making transparent texels draw visible rectangular quads.
        m.blending = CustomBlending;
        m.blendEquation = AddEquation;
        m.blendSrc = DstColorFactor;
        m.blendDst = ZeroFactor;
        m.blendEquationAlpha = AddEquation;
        m.blendSrcAlpha = ZeroFactor;
        m.blendDstAlpha = OneFactor;
      } else {
        m.blending = additive ? AdditiveBlending : NormalBlending;
      }
      if (typeof m.alphaTest === 'number' && m.alphaTest > 0) {
        m.alphaTest = m.alphaTest;
      }
      // ObjectLoader wants 0xRRGGBB. HDR punch lives in `cfxr.hdrMultiply` / fidelity shader;
      // here only keep displayable chroma for the MeshBasicMaterial stand-in.
      if (Array.isArray(m.color) && m.color.length >= 3) {
        let r = Number(m.color[0]) || 0;
        let g = Number(m.color[1]) || 0;
        let b = Number(m.color[2]) || 0;
        const peak = Math.max(r, g, b, 1e-4);
        if (peak > 1) {
          r /= peak;
          g /= peak;
          b /= peak;
        }
        const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
        m.color =
          (Math.round(clamp01(r) * 255) << 16) |
          (Math.round(clamp01(g) * 255) << 8) |
          Math.round(clamp01(b) * 255);
      }
      m.userData = {
        ...(m.userData || {}),
        vfxProgram: program,
        cfxrProps: semanticProfile ?? null,
        maps: m.maps ?? null,
        alphaClip: !!m.alphaClip,
      };
      delete m.texture;
      delete m.alphaMode;
      delete m.reflectionAtlas;
      delete m.reflectionLevel;
      delete m.maps;
      delete m.alphaClip;
      delete m.shader;
      delete m.vfxProgram;
      delete m.cfxr;
    }
  }

  if (Array.isArray(json.geometries)) {
    for (const g of json.geometries) {
      if (g.type !== 'QuarksGeometry') continue;
      if (!Array.isArray(g.positions) || g.positions.length === 0) {
        throw new Error(
          `QuarksGeometry ${g.uuid ?? '(anonymous)'} missing positions (no invent)`,
        );
      }
      const positions = g.positions;
      const indices = Array.isArray(g.indices) ? g.indices : [];
      const uvs = Array.isArray(g.uvs) ? g.uvs : [];
      const uv1s = Array.isArray(g.uv1s) ? g.uv1s : [];
      const normals = Array.isArray(g.normals) ? g.normals : [];
      g.type = 'BufferGeometry';
      g.data = {
        attributes: {
          position: { itemSize: 3, type: 'Float32Array', array: positions },
          ...(uvs.length
            ? { uv: { itemSize: 2, type: 'Float32Array', array: uvs } }
            : {}),
          ...(uv1s.length
            ? { uv1: { itemSize: 2, type: 'Float32Array', array: uv1s } }
            : {}),
          ...(normals.length
            ? { normal: { itemSize: 3, type: 'Float32Array', array: normals } }
            : {}),
        },
        index: indices.length ? { type: 'Uint32Array', array: indices } : undefined,
      };
      delete g.positions;
      delete g.indices;
      delete g.uvs;
      delete g.uv1s;
      delete g.normals;
    }
  }

  return json;
}

/**
 * Loads Unity→Quarks JSON and plays it via three.quarks (WebGL BatchedRenderer).
 */
