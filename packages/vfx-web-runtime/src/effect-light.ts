import { Color, PointLight, Vector3, type Object3D } from 'three';

/**
 * Reference-stage calibration between Unity built-in Light.intensity and
 * the non-physical three.js stage lighting units (Quarks deterministic light).
 */
export const UNITY_TO_THREE_LIGHT_INTENSITY_SCALE = 2.8;

/**
 * Host calibration for plain `cfxrEffect` payloads (corpus omits intensityScale).
 * Distinct from UNITY_TO_THREE_LIGHT_INTENSITY_SCALE used by deterministic controllers.
 */
export const CFXR_EFFECT_HOST_INTENSITY_SCALE = 0.035;

/** Plain cfxrEffect payloads omit mode; burst-curve is the only host path for that shape. */
const PLAIN_CFXR_EFFECT_MODE = 'burst-curve' as const;
/** Corpus omits intensityEnd / delay on plain cfxrEffect — host fade floor. */
const PLAIN_CFXR_EFFECT_INTENSITY_END = 0;
const PLAIN_CFXR_EFFECT_DELAY = 0;

/** Optional CFXR_Effect light — enabled when JSON metadata present (future) or always mild. */
export class CfxrEffectLight {
  readonly light: PointLight;
  private elapsed = 0;
  private playing = false;
  private intensityStart = 0;
  private intensityEnd = 0;
  private duration = 0;
  private delay = 0;
  private intensityScale = CFXR_EFFECT_HOST_INTENSITY_SCALE;
  private mode: 'burst-curve' | 'linear-fade' | 'sampled-flicker' = 'burst-curve';
  private flickerAdd = 0;
  private flickerSmooth = 1;
  private flickerPhase = 0;
  private flickerDomainStep = 1 / 128;
  private flickerSamples: number[] = [0.5, 0.5];

  constructor() {
    this.light = new PointLight(new Color(1, 0.621, 0.204), 0, 10, 2);
    this.light.name = 'CFXR_EffectLight';
  }

  attach(parent: Object3D, localPos = new Vector3(0, 0.2, 0)) {
    this.light.position.copy(localPos);
    parent.add(this.light);
  }

  configure(meta?: {
    intensityStart?: number;
    duration?: number;
    color?: [number, number, number];
    range?: number;
    intensityEnd?: number;
    delay?: number;
    position?: [number, number, number];
    intensityScale?: number;
    mode?: 'burst-curve' | 'linear-fade' | 'sampled-flicker';
    flickerAdd?: number;
    flickerSmooth?: number;
    flickerPhase?: number;
    flickerDomainStep?: number;
    flickerSamples?: number[];
  }) {
    if (!meta) return;
    // configure() is called for every newly loaded effect. Reset all controller-only
    // state so a sampled flicker cannot leak into a later plain cfxrEffect payload.
    // Plain cfxrEffect payloads omit mode; burst-curve is the only host path for that shape.
    this.mode = meta.mode ?? PLAIN_CFXR_EFFECT_MODE;
    this.flickerAdd = 0;
    this.flickerSmooth = 1;
    this.flickerPhase = 0;
    this.flickerDomainStep = 1 / 128;
    this.flickerSamples = [0.5, 0.5];
    if (typeof meta.intensityStart !== 'number' || !Number.isFinite(meta.intensityStart)) {
      throw new Error('CfxrEffectLight: intensityStart required (no invent)');
    }
    if (!Array.isArray(meta.color) || meta.color.length !== 3
      || meta.color.some((channel) => typeof channel !== 'number')) {
      throw new Error('CfxrEffectLight: color[3] required (no invent)');
    }
    if (typeof meta.range !== 'number' || !Number.isFinite(meta.range)) {
      throw new Error('CfxrEffectLight: range required (no invent)');
    }
    // sampled-flicker is driven by samples, not a fade duration.
    if (this.mode !== 'sampled-flicker') {
      if (typeof meta.duration !== 'number' || !Number.isFinite(meta.duration)) {
        throw new Error('CfxrEffectLight: duration required (no invent)');
      }
      this.duration = meta.duration;
    } else {
      this.duration = typeof meta.duration === 'number' ? meta.duration : 0;
    }
    this.intensityStart = meta.intensityStart;
    this.light.color.setRGB(meta.color[0], meta.color[1], meta.color[2]);
    this.light.distance = meta.range;
    if (meta.intensityEnd != null) this.intensityEnd = meta.intensityEnd;
    else this.intensityEnd = PLAIN_CFXR_EFFECT_INTENSITY_END;
    if (meta.delay != null) this.delay = Math.max(0, meta.delay);
    else this.delay = PLAIN_CFXR_EFFECT_DELAY;
    if (meta.position) this.light.position.set(meta.position[0], meta.position[1], meta.position[2]);
    // Corpus cfxrEffect omits intensityScale; host calibration stays explicit.
    this.intensityScale = typeof meta.intensityScale === 'number'
      ? meta.intensityScale
      : CFXR_EFFECT_HOST_INTENSITY_SCALE;
    if (meta.flickerAdd != null) this.flickerAdd = meta.flickerAdd;
    if (meta.flickerSmooth != null) this.flickerSmooth = Math.max(0, meta.flickerSmooth);
    if (meta.flickerPhase != null) this.flickerPhase = meta.flickerPhase;
    if (meta.flickerDomainStep != null) this.flickerDomainStep = Math.max(1e-8, meta.flickerDomainStep);
    if (meta.flickerSamples?.length) this.flickerSamples = [...meta.flickerSamples];
  }

  restart() {
    this.elapsed = 0;
    this.playing = true;
    this.light.intensity = this.delay > 0 ? 0 : this.intensityStart * this.intensityScale;
  }

  stop() {
    this.playing = false;
    this.light.intensity = 0;
  }

  update(dt: number) {
    if (!this.playing) return;
    if (this.mode === 'sampled-flicker') {
      const x = Math.max(0, (this.elapsed + this.flickerPhase) * this.flickerSmooth);
      const sample = x / this.flickerDomainStep;
      const index = Math.min(this.flickerSamples.length - 2, Math.floor(sample));
      const u = Math.max(0, Math.min(1, sample - index));
      const noise = this.flickerSamples[index]
        + (this.flickerSamples[index + 1] - this.flickerSamples[index]) * u;
      this.light.intensity = (this.intensityStart + this.flickerAdd * noise) * this.intensityScale;
      this.elapsed += dt;
      return;
    }
    if (this.mode === 'linear-fade') {
      // CFX_LightIntensityFade evaluates the current lifetime, then increments it.
      // Preserve that order so fixed-step frame zero starts at baseIntensity.
      if (this.elapsed < this.delay) {
        this.light.intensity = 0;
      } else {
        const localTime = this.elapsed - this.delay;
        const u = Math.max(0, Math.min(1, localTime / this.duration));
        this.light.intensity = (
          this.intensityStart + (this.intensityEnd - this.intensityStart) * u
        ) * this.intensityScale;
        if (u >= 1) this.playing = false;
      }
      this.elapsed += dt;
      return;
    }
    this.elapsed += dt;
    const u = Math.max(0, Math.min(1, this.elapsed / this.duration));
    let curve = 0;
    if (u < 0.1) curve = u / 0.1;
    else curve = Math.max(0, 1 - (u - 0.1) / 0.9);
    this.light.intensity = (
      this.intensityStart * curve + this.intensityEnd * (1 - curve)
    ) * this.intensityScale;
    if (u >= 1) {
      this.playing = false;
      this.light.intensity = 0;
    }
  }
}

