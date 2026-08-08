import { Object3D } from 'three';
import { BatchedRenderer, QuarksLoader, QuarksUtil } from 'three.quarks';
import { patchCfxrBeforeBatch } from './cfxr-before-batch-full';
import { patchCfxrAfterBatch } from './cfxr-after-batch';
import { stampCfxrEmitterSimsFromMaps } from './cfxr-simulation-mounts';

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
    // Mirror restored cfxrState maps into emitter bags so production mounts
    // share the same bag-only path as thin (including pending material props).
    stampCfxrEmitterSimsFromMaps(object);
    patchCfxrBeforeBatch(object);
    // Do not rewrite Material.type before batching. three.quarks already isolates
    // distinct MeshBasicMaterial instances; rewriting type to
    // ShaderMaterial:artifact:* and then restarting causes ghost VFXBatches that
    // double-draw the same emitter (CFXR Alpha8 fire: 7→9 batches). Mixed
    // artifact/bridge safety is enforced later by homogeneous closure binding.
    QuarksUtil.addToBatchRenderer(object, batchRenderer);
  });
  await patchCfxrAfterBatch(batchRenderer);
  return object;
}
