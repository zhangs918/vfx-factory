/** Compatibility names for the thick CFXR bridge. Shared ownership is artifact-neutral. */
export {
  clearArtifactSceneInputMaterials as clearCfxrSceneInputMaterials,
  registerArtifactSceneInputMaterial as registerCfxrSceneInputMaterial,
  getArtifactSharedSceneColor as getCfxrSharedSceneColor,
  getArtifactSharedSceneDepth as getCfxrSharedSceneDepth,
  syncArtifactSceneInputEffectTime as syncCfxrSceneInputEffectTime,
  setArtifactSceneColorTexture as setCfxrSceneColorTexture,
  artifactNeedsSceneColor as cfxrNeedsSceneColor,
} from './artifact-scene-inputs';
