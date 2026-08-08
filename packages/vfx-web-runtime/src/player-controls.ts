import { Euler, Object3D, Quaternion } from 'three';

export interface AutoRotation {
  target: Object3D;
  baseQuaternion: Quaternion;
  radiansPerSecond: [number, number, number];
  space: 'self' | 'world';
}

export function buildAutoRotations(root: Object3D, controllers: any[]): AutoRotation[] {
  return controllers.flatMap((controller) => {
    if (controller?.kind !== 'constant-euler-rotation') return [];
    if (typeof controller.targetNode !== 'string' || !controller.targetNode) {
      throw new Error('constant-euler-rotation: targetNode required (no invent)');
    }
    if (controller.space !== 'self' && controller.space !== 'world') {
      throw new Error('constant-euler-rotation: space required (no invent)');
    }
    if (!Array.isArray(controller.degreesPerSecond) || controller.degreesPerSecond.length !== 3
      || controller.degreesPerSecond.some((value: unknown) => typeof value !== 'number')) {
      throw new Error('constant-euler-rotation: degreesPerSecond[3] required (no invent)');
    }
    const target = root.getObjectByProperty('uuid', controller.targetNode);
    if (!target) throw new Error(`Auto-rotate target '${controller.targetNode}' was not loaded`);
    const d = controller.degreesPerSecond as [number, number, number];
    return [{
      target,
      baseQuaternion: target.quaternion.clone(),
      radiansPerSecond: [-d[0] * Math.PI / 180, -d[1] * Math.PI / 180, d[2] * Math.PI / 180],
      space: controller.space,
    }];
  });
}

export function resetAutoRotations(rotations: AutoRotation[]) {
  for (const controller of rotations) controller.target.quaternion.copy(controller.baseQuaternion);
}

export function updateAutoRotations(rotations: AutoRotation[], dt: number) {
  for (const controller of rotations) {
    const [x, y, z] = controller.radiansPerSecond;
    const delta = new Quaternion().setFromEuler(new Euler(x * dt, y * dt, z * dt, 'YXZ'));
    if (controller.space === 'self') controller.target.quaternion.multiply(delta);
    else controller.target.quaternion.premultiply(delta);
  }
}

export function listEmitters(root: Object3D | null): string[] {
  const names: string[] = [];
  root?.traverse((child) => { if (child.type === 'ParticleEmitter') names.push(child.name); });
  return names;
}

/** Apply diagnostic visibility without breaking the parent→sub-emitter simulation chain. */
export function applySolo(root: Object3D | null, soloName: string | null) {
  if (!root) return;
  const solo = soloName?.toLowerCase() ?? null;
  const emitters: Array<Object3D & { system?: {
    behaviors?: Array<{ type?: string; subParticleSystem?: Object3D }>;
    stop?: () => void; pause?: () => void;
  } }> = [];
  root.traverse((child) => {
    if (child.type === 'ParticleEmitter') emitters.push(child as typeof emitters[number]);
  });
  const layerIndex = solo?.startsWith('@layer:') ? Number(solo.slice('@layer:'.length)) : null;
  const selected = new Set(emitters.filter((emitter, index) => !solo
    || (layerIndex != null && Number.isInteger(layerIndex) && index === layerIndex)
    || (layerIndex == null && emitter.name.toLowerCase() === solo)));
  const drivers = new Set<typeof emitters[number]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const emitter of emitters) for (const behavior of emitter.system?.behaviors ?? []) {
      if (behavior.type !== 'EmitSubParticleSystem' || !behavior.subParticleSystem) continue;
      const target = behavior.subParticleSystem as typeof emitters[number];
      if ([...selected, ...drivers].some((required) => required === target || required.uuid === target.uuid)
          && !drivers.has(emitter)) {
        drivers.add(emitter);
        changed = true;
      }
    }
  }
  for (const emitter of emitters) {
    const show = selected.has(emitter);
    emitter.visible = show;
    if (!show && !drivers.has(emitter)) {
      emitter.system?.stop?.();
      emitter.system?.pause?.();
    }
  }
}
