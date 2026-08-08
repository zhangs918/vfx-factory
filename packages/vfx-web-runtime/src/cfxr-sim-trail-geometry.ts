/**
 * Unity Trail geometry schemas + offline @2 payload decode.
 * Shared by inject (production) and trail behavior mounts (thin + production).
 */

export type UnityTrailGeometryPointObject = {
  position: [number, number, number];
  width: number;
  color: [number, number, number, number];
  u?: number;
};

export type UnityTrailGeometryPoint = UnityTrailGeometryPointObject |
  [number, number, number, number?, number?, number?, number?, number?, number?];

export type UnityTrailGeometry = {
  schema: 'unity-trail-geometry@1' | 'unity-trail-geometry@2';
  sampleRate: number;
  space: 'world' | 'local';
  frames: Array<{ time: number; trails: UnityTrailGeometryPoint[][]; trailSeeds?: number[] }>;
};

export type EncodedUnityTrailGeometry = Omit<UnityTrailGeometry, 'schema' | 'frames'> & {
  schema: 'unity-trail-geometry@2';
  encoding: 'base64-le-f32-u16-alpha8@1' | 'base64-le-f32-u16-alpha8-seed32@1';
  frameCount: number;
  payload: string;
};

export type UnityTrailSemantics = {
  schema: 'unity-trail-semantics@1' | 'unity-trail-semantics@2';
  mode?: 'PerParticle' | 'Ribbon';
  ratio?: number;
  lifetime?: any;
  minVertexDistance?: number;
  textureMode?: string;
  worldSpace?: boolean;
  widthOverTrail: any;
  colorOverLifetime: any;
  colorOverTrail: any;
  sizeAffectsWidth: boolean;
  sizeAffectsLifetime?: boolean;
  inheritParticleColor: boolean;
  dieWithParticles: boolean;
  ribbonCount?: number;
  splitSubEmitterRibbons?: boolean;
  attachRibbonsToTransform?: boolean;
};

export function decodeUnityTrailGeometry(
  geometry: UnityTrailGeometry | EncodedUnityTrailGeometry,
): UnityTrailGeometry {
  if (geometry.schema === 'unity-trail-geometry@1') return geometry as UnityTrailGeometry;
  const encoded = geometry as EncodedUnityTrailGeometry;
  const hasSeeds = encoded.encoding === 'base64-le-f32-u16-alpha8-seed32@1';
  if (!hasSeeds && encoded.encoding !== 'base64-le-f32-u16-alpha8@1') {
    throw new Error(`Unsupported Unity trail geometry encoding '${String(encoded.encoding)}'`);
  }
  const binary = atob(encoded.payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const u16 = () => { const value = view.getUint16(offset, true); offset += 2; return value; };
  const u32 = () => { const value = view.getUint32(offset, true); offset += 4; return value; };
  const f32 = () => { const value = view.getFloat32(offset, true); offset += 4; return value; };
  if (u32() !== 0x32475455) throw new Error('Invalid unity-trail-geometry@2 magic');
  const frameCount = u32();
  if (frameCount !== encoded.frameCount) throw new Error('Trail geometry frameCount mismatch');
  const frames: UnityTrailGeometry['frames'] = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const time = f32();
    const trails: UnityTrailGeometryPoint[][] = [];
    const trailSeeds: number[] = [];
    const trailCount = u16();
    for (let trailIndex = 0; trailIndex < trailCount; trailIndex++) {
      const points: UnityTrailGeometryPoint[] = [];
      const pointCount = u16();
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        const x = f32(), y = f32(), z = f32(), width = f32();
        if (offset >= bytes.byteLength) throw new Error('Truncated unity-trail-geometry@2 payload');
        const alpha = bytes[offset++] / 255;
        points.push([x, y, z, width, alpha]);
      }
      trails.push(points);
      if (hasSeeds) trailSeeds.push(u32());
    }
    frames.push({ time, trails, ...(hasSeeds ? { trailSeeds } : {}) });
  }
  if (offset !== bytes.byteLength) throw new Error('Trailing bytes in unity-trail-geometry@2 payload');
  return { schema: 'unity-trail-geometry@2', sampleRate: geometry.sampleRate, space: geometry.space, frames };
}
