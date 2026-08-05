import type { WebVfxRuntimeV2 } from '@vfx-factory/artifact-schema';

export interface RuntimeHandle {
  update(dt: number): void;
  restart(): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

export interface RuntimeBackend<TContext = unknown> {
  instantiate(artifact: WebVfxRuntimeV2, context: TContext): Promise<RuntimeHandle>;
}
