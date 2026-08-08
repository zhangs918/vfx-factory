/** Renderer-neutral registry for artifact shaders that consume host scene inputs. */
import type { ShaderMaterial, Texture } from 'three';

const sceneInputMaterials = new Set<ShaderMaterial>();
let sharedSceneColor: Texture | null = null;
let sharedSceneDepth: Texture | null = null;

export function clearArtifactSceneInputMaterials(): void { sceneInputMaterials.clear(); }
export function registerArtifactSceneInputMaterial(material: ShaderMaterial): void {
  sceneInputMaterials.add(material);
}
export function getArtifactSharedSceneColor(): Texture | null { return sharedSceneColor; }
export function getArtifactSharedSceneDepth(): Texture | null { return sharedSceneDepth; }

export function syncArtifactSceneInputEffectTime(seconds: number): void {
  for (const material of sceneInputMaterials) {
    if (material.uniforms?.effectTime) material.uniforms.effectTime.value = seconds;
  }
}

export function setArtifactSceneColorTexture(
  texture: Texture | null,
  depth: Texture | null,
  width = 1,
  height = 1,
  near?: number,
  far?: number,
): void {
  sharedSceneColor = texture;
  sharedSceneDepth = depth;
  if (texture && (typeof near !== 'number' || typeof far !== 'number')) {
    throw new Error('setArtifactSceneColorTexture: near/far required when binding scene color (no invent)');
  }
  for (const material of sceneInputMaterials) {
    if (material.uniforms?.sceneColorMap) material.uniforms.sceneColorMap.value = texture;
    if (material.uniforms?.sceneDepthMap) material.uniforms.sceneDepthMap.value = depth;
    if (material.uniforms?.sceneColorSize) material.uniforms.sceneColorSize.value.set(width, height, 0);
    if (texture && material.uniforms?.cameraNear) material.uniforms.cameraNear.value = near!;
    if (texture && material.uniforms?.cameraFar) material.uniforms.cameraFar.value = far!;
  }
}

export function artifactNeedsSceneColor(): boolean { return sceneInputMaterials.size > 0; }
