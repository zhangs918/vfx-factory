/**
 * Thin-safe constant-uniform applicator. Dual-path derive/assert stays in
 * cfxr-constant-uniforms.
 */
import { Vector3, type ShaderMaterial } from 'three';
import { type VfxPipelineUniformValues } from '@vfx-factory/artifact-schema';

export type { VfxPipelineUniformValues };

export function applyConstantUniforms(
  mat: ShaderMaterial,
  values: VfxPipelineUniformValues,
) {
  mat.uniforms = mat.uniforms ?? {};
  if (values.opacityGain !== undefined) {
    mat.uniforms.opacityGain = { value: values.opacityGain };
  }
  if (values.legacyAlphaTintFactor !== undefined) {
    mat.uniforms.legacyAlphaTintFactor = { value: values.legacyAlphaTintFactor };
  }
  if (values.materialColor) {
    mat.uniforms.materialColor = {
      value: new Vector3(
        values.materialColor[0],
        values.materialColor[1],
        values.materialColor[2],
      ),
    };
  }
  if (values.hdrMultiply !== undefined) {
    mat.uniforms.hdrMultiply = { value: values.hdrMultiply };
  }
  if (values.vertColorGain !== undefined) {
    mat.uniforms.vertColorGain = { value: values.vertColorGain };
  }
  for (const key of ['vertColorRgbOn', 'vertColorAlphaOn', 'texPower', 'colorPower'] as const) {
    if (values[key] !== undefined) mat.uniforms[key] = { value: values[key] };
  }
}
