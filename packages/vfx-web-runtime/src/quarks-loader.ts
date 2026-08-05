import { Object3D } from 'three';
import { BatchedRenderer } from 'three.quarks';
import { loadCompiledQuarksObject } from './compiled-quarks-loader';

export type QuarksLoadMode = 'legacy-unity-json' | 'compiled-runtime';

/** Parse one lowered artifact and register it with the host batch renderer. */
export async function loadQuarksObject(
  raw: any,
  batchRenderer: BatchedRenderer,
  withSeededRandom: <T>(fn: () => T) => T,
  mode: QuarksLoadMode = 'legacy-unity-json',
): Promise<Object3D> {
  if (mode === 'compiled-runtime') {
    return loadCompiledQuarksObject(raw, batchRenderer, withSeededRandom);
  }
  const json = (await import('./quarks-lowering')).normalizeUnityQuarksJson(raw);
  return loadCompiledQuarksObject(json, batchRenderer, withSeededRandom);
}
