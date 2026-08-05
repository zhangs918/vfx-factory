import type { WebVfxRuntimeV2 } from '@vfx-factory/artifact-schema';
import type { Object3D } from 'three';

export interface RuntimeHandle {
  root: Object3D;
  update(dt: number): void;
  restart(): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

export interface RuntimeBackend<TContext = unknown> {
  instantiate(artifact: WebVfxRuntimeV2, context: TContext): Promise<RuntimeHandle>;
}
