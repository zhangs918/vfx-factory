import { Object3D } from 'three';
import { BatchedRenderer, QuarksLoader, QuarksUtil } from 'three.quarks';

/**
 * Runtime-only loader for an already compiled artifact.
 *
 * This module intentionally has no Unity lowering, Shader Graph, or CFXR imports.
 * All semantic decisions must have been made by the offline compiler and encoded
 * in the Quarks-ready JSON/config before this function is called.
 */
export async function loadArtifactQuarksObject(
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
  withSeededRandom(() => QuarksUtil.addToBatchRenderer(object, batchRenderer));
  return object;
}
