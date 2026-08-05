import { Object3D } from 'three';
import { BatchedRenderer, QuarksLoader, QuarksUtil } from 'three.quarks';
import {
  patchCfxrAfterBatch,
  patchCfxrBeforeBatch,
} from './cfxrQuarksFidelity';
import { normalizeUnityQuarksJson } from './quarks-lowering';

/** Parse one lowered artifact and register it with the host batch renderer. */
export async function loadQuarksObject(
  raw: any,
  batchRenderer: BatchedRenderer,
  withSeededRandom: <T>(fn: () => T) => T,
  precompiled = false,
): Promise<Object3D> {
  const json = precompiled ? raw : normalizeUnityQuarksJson(raw);
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
