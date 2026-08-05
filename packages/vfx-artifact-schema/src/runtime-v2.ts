export const WEB_VFX_RUNTIME_V2_SCHEMA = 'web-vfx-runtime@2' as const;

export type RuntimeBlend = 'opaque' | 'alpha' | 'premultiplied' | 'additive' | 'multiply';

export interface RuntimeResource {
  id: string;
  kind: 'texture' | 'geometry' | 'shader';
  uri: string;
  colorSpace?: 'srgb' | 'linear';
  metadata?: Record<string, unknown>;
}

export interface RuntimeMaterial {
  id: string;
  vertexShader: string;
  fragmentShader: string;
  textures?: Record<string, string>;
  uniforms?: Record<string, unknown>;
  renderState: {
    blend: RuntimeBlend;
    depthTest: boolean;
    depthWrite: boolean;
    cull: 'none' | 'front' | 'back';
    alphaTest?: number;
    toneMapped?: boolean;
  };
}

export interface RuntimeProgram {
  id: string;
  op: string;
  params: Record<string, unknown>;
}

export interface RuntimeEmission {
  bursts: Array<{ time: number; count: number }>;
  rateOverTime?: number;
}

export interface RuntimeSystem {
  id: string;
  nodeId: string;
  material: string;
  geometry?: string;
  capacity: number;
  duration: number;
  particleLife: number;
  looping: boolean;
  startDelay: number;
  emission: RuntimeEmission;
  renderMode: 'billboard' | 'stretched-billboard' | 'mesh' | 'trail';
  programs: string[];
  transform: { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] };
}

export interface WebVfxRuntimeV2 {
  schema: typeof WEB_VFX_RUNTIME_V2_SCHEMA;
  effectId: string;
  compilerVersion: string;
  seed: number;
  fixedDelta: number;
  duration: number;
  looping: boolean;
  resources: RuntimeResource[];
  materials: RuntimeMaterial[];
  programs: RuntimeProgram[];
  systems: RuntimeSystem[];
  metadata?: Record<string, unknown>;
}

export function isWebVfxRuntimeV2(value: unknown): value is WebVfxRuntimeV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<WebVfxRuntimeV2>;
  return v.schema === WEB_VFX_RUNTIME_V2_SCHEMA
    && typeof v.effectId === 'string'
    && typeof v.compilerVersion === 'string'
    && Number.isFinite(v.seed)
    && Number.isFinite(v.fixedDelta) && Number(v.fixedDelta) > 0
    && Number.isFinite(v.duration) && Number(v.duration) >= 0
    && typeof v.looping === 'boolean'
    && Array.isArray(v.resources)
    && Array.isArray(v.materials)
    && Array.isArray(v.programs)
    && Array.isArray(v.systems);
}

export function assertWebVfxRuntimeV2(value: unknown): asserts value is WebVfxRuntimeV2 {
  if (!isWebVfxRuntimeV2(value)) throw new Error('Invalid web-vfx-runtime@2 artifact.');
}
