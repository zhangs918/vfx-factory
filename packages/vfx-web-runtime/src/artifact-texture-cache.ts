import { NoColorSpace, SRGBColorSpace, TextureLoader, type Texture } from 'three';

export type ArtifactTextureSamplerSpec = {
  wrap?: [number, number];
  magFilter?: number;
  minFilter?: number;
};

const textureCache = new Map<string, Promise<Texture>>();

export function loadArtifactTexture(
  url: string,
  srgb: boolean,
  sampler?: ArtifactTextureSamplerSpec,
): Promise<Texture> {
  const key = `${srgb ? 'srgb' : 'linear'}:${JSON.stringify(sampler ?? {})}:${url}`;
  let request = textureCache.get(key);
  if (!request) {
    request = new TextureLoader().loadAsync(url).then((texture) => {
      texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
      if (sampler?.wrap) {
        texture.wrapS = sampler.wrap[0] as typeof texture.wrapS;
        texture.wrapT = sampler.wrap[1] as typeof texture.wrapT;
      }
      if (sampler?.magFilter != null) texture.magFilter = sampler.magFilter as typeof texture.magFilter;
      if (sampler?.minFilter != null) texture.minFilter = sampler.minFilter as typeof texture.minFilter;
      texture.needsUpdate = true;
      return texture;
    }).catch((error) => {
      textureCache.delete(key);
      throw new Error(`Artifact texture failed to load: ${url}`, { cause: error });
    });
    textureCache.set(key, request);
  }
  return request;
}
