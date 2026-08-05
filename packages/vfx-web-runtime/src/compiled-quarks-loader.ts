import { Object3D } from 'three';
import { BatchedRenderer, QuarksLoader, QuarksUtil } from 'three.quarks';
import { patchCfxrAfterBatch, patchCfxrBeforeBatch } from './cfxrQuarksFidelity';

export async function loadCompiledQuarksObject(
  json: any,
  batchRenderer: BatchedRenderer,
  withSeededRandom: <T>(fn: () => T) => T,
): Promise<Object3D> {
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
