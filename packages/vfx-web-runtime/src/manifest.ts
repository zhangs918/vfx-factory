export interface QuarksManifestEntry {
  id: string;
  label: string;
  file: string;
  note?: string;
}

export interface QuarksManifest {
  effects: QuarksManifestEntry[];
}

export interface RuntimeV3ManifestEntry extends QuarksManifestEntry {
  artifact: string;
  sha256: string;
  status: 'compiled' | 'rejected';
  disposition: 'qualified' | 'candidate' | 'failed';
  failure?: string;
  capabilities?: { thinPlayer: boolean };
  qualification?: {
    thinPlayer: boolean;
    captureTimes: number[];
    changedPixels?: number;
    maxChannelDelta?: number;
    updatedAt?: string;
  };
}

export interface RuntimeV3Manifest {
  schema: 'vfx-runtime-artifact-manifest@3';
  effects: RuntimeV3ManifestEntry[];
}

export async function loadQuarksManifest(candidate = false, root = '/assets/quarks'): Promise<QuarksManifest> {
  const res = await fetch(`${root}/${candidate ? 'manifest.candidates.json' : 'manifest.json'}`);
  if (!res.ok) return { effects: [] };
  const contentType = res.headers.get('content-type') ?? '';
  // Vite's SPA fallback returns index.html with HTTP 200 for a missing JSON file.
  // Never pass that HTML document to JSON.parse.
  if (!contentType.includes('json')) return { effects: [] };
  return res.json();
}

export async function loadRuntimeV3Manifest(
  root = '/assets/v3-artifacts',
): Promise<RuntimeV3Manifest> {
  const response = await fetch(`${root}/manifest.json`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('json')) {
    throw new Error(`Failed to load runtime-v3 manifest (${response.status})`);
  }
  const manifest = await response.json() as RuntimeV3Manifest;
  if (manifest.schema !== 'vfx-runtime-artifact-manifest@3' || !Array.isArray(manifest.effects)) {
    throw new Error('Invalid runtime-v3 manifest');
  }
  for (const entry of manifest.effects) {
    if (!entry || typeof entry.id !== 'string' || !entry.id
      || typeof entry.artifact !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !['compiled', 'rejected'].includes(entry.status)
      || !['qualified', 'candidate', 'failed'].includes(entry.disposition)
      || (entry.capabilities !== undefined
        && typeof entry.capabilities.thinPlayer !== 'boolean')
      || (entry.qualification !== undefined
        && (typeof entry.qualification.thinPlayer !== 'boolean'
          || !Array.isArray(entry.qualification.captureTimes)
          || entry.qualification.captureTimes.some((time) => !Number.isFinite(time))))) {
      throw new Error(`Invalid runtime-v3 manifest entry '${entry?.id ?? '(unknown)'}'`);
    }
  }
  return manifest;
}
