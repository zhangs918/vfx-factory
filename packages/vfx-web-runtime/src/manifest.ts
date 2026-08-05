export interface QuarksManifestEntry {
  id: string;
  label: string;
  file: string;
  note?: string;
}

export interface QuarksManifest {
  effects: QuarksManifestEntry[];
}

export async function loadQuarksManifest(candidate = false): Promise<QuarksManifest> {
  const res = await fetch(`/assets/quarks/${candidate ? 'manifest.candidates.json' : 'manifest.json'}`);
  if (!res.ok) return { effects: [] };
  return res.json();
}
