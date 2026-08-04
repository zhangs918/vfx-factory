import {
  EmitterShapes,
  type EmitterShape,
  type EmissionState,
  type IParticleSystem,
  type Particle,
  type ShapeJSON,
} from 'quarks.core';

type UnityBoxJson = ShapeJSON & { type: 'unity-box-volume' };
type UnityConeVolumeJson = ShapeJSON & {
  type: 'unity-cone-volume';
  radius: number;
  angle: number;
  length: number;
};

/** Unity Box emits uniformly inside a unit box; Shape-module scale/TRS is applied separately. */
class UnityBoxVolumeEmitter implements EmitterShape {
  readonly type = 'unity-box-volume';
  initialize(particle: Particle) {
    particle.position.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    particle.velocity.set(0, 0, particle.startSpeed);
  }
  update(_system: IParticleSystem, _delta: number) {}
  clone() { return new UnityBoxVolumeEmitter(); }
  toJSON(): UnityBoxJson { return { type: this.type }; }
  static fromJSON() { return new UnityBoxVolumeEmitter(); }
}

/**
 * Unity Cone Volume: choose an axial slice, then a uniform disk in that slice.  The
 * emission direction is the corresponding cone ray; Shape-module TRS remains a distinct IR op.
 */
class UnityConeVolumeEmitter implements EmitterShape {
  readonly type = 'unity-cone-volume';
  constructor(readonly radius = 1, readonly angle = 0, readonly length = 1) {}
  initialize(particle: Particle, _emissionState: EmissionState) {
    const z = Math.random() * this.length;
    const theta = Math.random() * Math.PI * 2;
    const disk = Math.sqrt(Math.random());
    const radial = disk * (this.radius + z * Math.tan(this.angle));
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    particle.position.set(radial * cos, radial * sin, z);
    const directionAngle = this.angle * disk;
    particle.velocity.set(
      cos * Math.sin(directionAngle),
      sin * Math.sin(directionAngle),
      Math.cos(directionAngle),
    ).multiplyScalar(particle.startSpeed);
  }
  update(_system: IParticleSystem, _delta: number) {}
  clone() { return new UnityConeVolumeEmitter(this.radius, this.angle, this.length); }
  toJSON(): UnityConeVolumeJson {
    return { type: this.type, radius: this.radius, angle: this.angle, length: this.length } as UnityConeVolumeJson;
  }
  static fromJSON(json: UnityConeVolumeJson) {
    return new UnityConeVolumeEmitter(Number(json.radius), Number(json.angle), Number(json.length));
  }
}

/** Register strict Unity-only shapes before QuarksLoader parses any exported system. */
export function registerUnityEmitterShapes() {
  EmitterShapes['unity-box-volume'] = {
    type: 'unity-box-volume', constructor: UnityBoxVolumeEmitter, params: [],
    loadJSON: UnityBoxVolumeEmitter.fromJSON,
  };
  EmitterShapes['unity-cone-volume'] = {
    type: 'unity-cone-volume', constructor: UnityConeVolumeEmitter,
    params: [['radius', ['number']], ['angle', ['radian']], ['length', ['number']]],
    loadJSON: UnityConeVolumeEmitter.fromJSON,
  };
}
