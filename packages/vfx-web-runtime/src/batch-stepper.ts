import { DynamicDrawUsage, InstancedBufferAttribute } from 'three';
import { BatchedRenderer, type IParticleSystem } from 'three.quarks';

type RuntimeSystem = {
  update: (delta: number) => void;
  particleNum?: number;
  particles?: Array<{ age?: number; life?: number; previous?: unknown[] }>;
};

type CfxrStreamParticle = {
  unityCustom1?: [number, number, number, number];
  unityCustom2?: [number, number, number, number];
  unityRendererFlip?: [boolean, boolean];
};

/** Historical stream invent for particles without Custom1/Custom2 behaviors. */
export const CFXR_STREAM_CUSTOM_ZERO: [number, number, number, number] = [0, 0, 0, 0];
/** Historical stream invent for particles without unityRendererFlip. */
export const CFXR_STREAM_FLIP_IDENTITY: [boolean, boolean] = [false, false];
/** Cull particles once age+eps reaches life (Unity one-frame terminal). */
export const CFXR_BATCH_PARTICLE_CULL_EPS = 1e-9;

type CustomStreamBatch = {
  geometry: {
    getAttribute: (name: string) => InstancedBufferAttribute | undefined;
    setAttribute: (name: string, attribute: InstancedBufferAttribute) => void;
  };
  getVisibleSystems: () => Array<IParticleSystem>;
};

/**
 * Upload Unity's Custom1.xyzw vertex stream in exactly the same flattened instance order used
 * by SpriteBatch. Shared by production after-batch and thin steppers.
 */
export function updateCfxrCustomAttributes(batchRenderer: BatchedRenderer) {
  for (const rawBatch of batchRenderer.batches) {
    const batch = rawBatch as unknown as CustomStreamBatch;
    if (!batch.geometry?.getAttribute || !batch.getVisibleSystems) continue;
    // TrailBatch is vertex-expanded (two vertices per history sample), not instance-expanded.
    // Its authored adapters currently consume neither per-particle Custom1 nor Custom2 when
    // their material-folded toggles are off. Attaching InstancedBufferAttributes to this
    // non-instanced geometry changes the draw contract and can suppress the trail entirely.
    if (batch.geometry.getAttribute('previous')) continue;
    const colorAttr = batch.geometry.getAttribute('color');
    // Non-instance batches omit color; skip rather than inventing capacity 0.
    if (!colorAttr) continue;
    const instanceCapacity = colorAttr.count;
    if (instanceCapacity <= 0) continue;

    let attribute = batch.geometry.getAttribute('cfxrCustom1');
    if (!attribute || attribute.count < instanceCapacity) {
      attribute = new InstancedBufferAttribute(new Float32Array(instanceCapacity * 4), 4);
      attribute.setUsage(DynamicDrawUsage);
      batch.geometry.setAttribute('cfxrCustom1', attribute);
    }
    let attribute2 = batch.geometry.getAttribute('cfxrCustom2');
    if (!attribute2 || attribute2.count < instanceCapacity) {
      attribute2 = new InstancedBufferAttribute(new Float32Array(instanceCapacity * 4), 4);
      attribute2.setUsage(DynamicDrawUsage);
      batch.geometry.setAttribute('cfxrCustom2', attribute2);
    }
    let flipAttribute = batch.geometry.getAttribute('cfxrUvFlip');
    if (!flipAttribute || flipAttribute.count < instanceCapacity) {
      flipAttribute = new InstancedBufferAttribute(new Float32Array(instanceCapacity * 2), 2);
      flipAttribute.setUsage(DynamicDrawUsage);
      batch.geometry.setAttribute('cfxrUvFlip', flipAttribute);
    }
    let pivotAttribute = batch.geometry.getAttribute('cfxrRendererPivot');
    if (!pivotAttribute || pivotAttribute.count < instanceCapacity) {
      pivotAttribute = new InstancedBufferAttribute(new Float32Array(instanceCapacity * 4), 4);
      pivotAttribute.setUsage(DynamicDrawUsage);
      batch.geometry.setAttribute('cfxrRendererPivot', pivotAttribute);
    }

    let index = 0;
    for (const system of batch.getVisibleSystems()) {
      const requireStampedStreams = (system as unknown as { behaviors?: Array<{ type: string }> })
        .behaviors
        ?.some((behavior) => behavior.type === 'UnityInitialState');
      for (let i = 0; i < system.particleNum; i++, index++) {
        const particle = system.particles[i] as CfxrStreamParticle;
        const hasCustom1 = Array.isArray(particle.unityCustom1) && particle.unityCustom1.length === 4;
        const hasCustom2 = Array.isArray(particle.unityCustom2) && particle.unityCustom2.length === 4;
        const hasFlip = Array.isArray(particle.unityRendererFlip) && particle.unityRendererFlip.length === 2;
        if (requireStampedStreams && (!hasCustom1 || !hasCustom2 || !hasFlip)) {
          throw new Error(
            'batch-stepper: unityCustom1/custom2/rendererFlip required after UnityInitialState (no invent)',
          );
        }
        const streamDefaults = system as unknown as {
          unityDefaultRendererFlip?: [boolean, boolean];
          unityDefaultCustom1?: [number, number, number, number];
          unityDefaultCustom2?: [number, number, number, number];
        };
        const hasEmitterStreamDefaults = Array.isArray(streamDefaults.unityDefaultRendererFlip)
          && streamDefaults.unityDefaultRendererFlip.length === 2
          && Array.isArray(streamDefaults.unityDefaultCustom1)
          && streamDefaults.unityDefaultCustom1.length === 4
          && Array.isArray(streamDefaults.unityDefaultCustom2)
          && streamDefaults.unityDefaultCustom2.length === 4;
        if (!hasEmitterStreamDefaults && (
          streamDefaults.unityDefaultRendererFlip
          || streamDefaults.unityDefaultCustom1
          || streamDefaults.unityDefaultCustom2
        )) {
          throw new Error(
            'batch-stepper: incomplete unityDefault* stream defaults (no invent)',
          );
        }
        const custom = hasCustom1
          ? particle.unityCustom1!
          : (hasEmitterStreamDefaults
            ? streamDefaults.unityDefaultCustom1!
            : CFXR_STREAM_CUSTOM_ZERO);
        attribute.setXYZW(index, custom[0], custom[1], custom[2], custom[3]);
        const custom2 = hasCustom2
          ? particle.unityCustom2!
          : (hasEmitterStreamDefaults
            ? streamDefaults.unityDefaultCustom2!
            : CFXR_STREAM_CUSTOM_ZERO);
        attribute2.setXYZW(index, custom2[0], custom2[1], custom2[2], custom2[3]);
        // Prefer per-particle stamp; else emitter offline default; else frozen invent.
        const flip = hasFlip
          ? particle.unityRendererFlip!
          : (hasEmitterStreamDefaults
            ? streamDefaults.unityDefaultRendererFlip!
            : CFXR_STREAM_FLIP_IDENTITY);
        flipAttribute.setXY(index, flip[0] ? 1 : 0, flip[1] ? 1 : 0);
        const pivot = (system as unknown as { unityRendererPivot?: [number, number, number, number] })
          .unityRendererPivot;
        if (!pivot
          || pivot.length !== 4
          || pivot.some((component) => typeof component !== 'number')) {
          throw new Error('batch-stepper: unityRendererPivot[4] required (no invent)');
        }
        pivotAttribute.setXYZW(index, pivot[0], pivot[1], pivot[2], pivot[3]);
      }
    }
    attribute.clearUpdateRanges();
    if (index > 0) attribute.addUpdateRange(0, index * 4);
    attribute.needsUpdate = true;
    attribute2.needsUpdate = true;
    flipAttribute.needsUpdate = true;
    pivotAttribute.needsUpdate = true;
  }
}

/** Advance each Quarks system exactly once and rebuild its render batches. */
export function updateBatchesExactlyOnce(
  renderer: BatchedRenderer,
  dt: number,
  emitterDeltas = new Map<object, number>(),
) {
  const systems = [...renderer.systemToBatchIndex.keys()] as unknown as RuntimeSystem[];
  for (const system of systems) {
    system.update(emitterDeltas.get(system) ?? dt);
    cullUnityExpiredParticles(system);
  }
  for (const batch of renderer.batches) batch.update();
  updateCfxrCustomAttributes(renderer);
}

function cullUnityExpiredParticles(system: RuntimeSystem) {
  if (!system.particles || typeof system.particleNum !== 'number') return;
  const epsilon = CFXR_BATCH_PARTICLE_CULL_EPS;
  let count = system.particleNum;
  for (let i = count - 1; i >= 0; i--) {
    const particle = system.particles[i];
    if (particle?.previous && particle.previous.length > 0) continue;
    if (!Number.isFinite(particle?.age) || !Number.isFinite(particle?.life)) continue;
    if ((particle.age as number) + epsilon < (particle.life as number)) continue;
    const last = count - 1;
    system.particles[i] = system.particles[last];
    system.particles[last] = particle;
    count = last;
    system.particleNum = count;
  }
}
