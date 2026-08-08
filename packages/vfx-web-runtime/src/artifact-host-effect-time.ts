import { setCfxrEffectTime as setSimulationEffectTime } from './cfxr-sim-initial';
import { syncArtifactSceneInputEffectTime } from './artifact-scene-inputs';

export function setArtifactEffectTime(seconds: number): void {
  setSimulationEffectTime(seconds);
  syncArtifactSceneInputEffectTime(seconds);
}
