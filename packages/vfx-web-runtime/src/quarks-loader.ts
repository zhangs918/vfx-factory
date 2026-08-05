import { Object3D } from 'three';
import { BatchedRenderer, QuarksLoader, QuarksUtil } from 'three.quarks';
import {
  patchCfxrAfterBatch,
  patchCfxrBeforeBatch,
} from './cfxrQuarksFidelity';

export type QuarksLoadMode = 'legacy-unity-json' | 'compiled-runtime';

/** Parse one lowered artifact and register it with the host batch renderer. */
export async function loadQuarksObject(
  raw: any,
  batchRenderer: BatchedRenderer,
  withSeededRandom: <T>(fn: () => T) => T,
  mode: QuarksLoadMode = 'legacy-unity-json',
): Promise<Object3D> {
  // Keep the legacy Unity lowering path out of the normal playback chunk. It
  // is loaded only for old artifacts; compiled runtime bundles never import it.
  const json = mode === 'compiled-runtime'
    ? raw
    : (await import('./quarks-lowering')).normalizeUnityQuarksJson(raw);
  const loader = new QuarksLoader();
  const object = await new Promise<Object3D>((resolve, reject) => {
    try {
      withSeededRandom(() => loader.parse(json, (ready) => resolve(ready)));
    } catch (error) {
      reject(error);
    }
  });
  withSeededRandom(() => {
    patchCfxrBeforeBatch(object);
    QuarksUtil.addToBatchRenderer(object, batchRenderer);
  });
  await patchCfxrAfterBatch(batchRenderer);
  return object;
}
