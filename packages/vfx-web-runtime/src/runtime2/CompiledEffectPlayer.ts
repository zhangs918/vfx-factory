import { assertWebVfxRuntimeV2, type WebVfxRuntimeV2 } from '@vfx-factory/artifact-schema';
import type { RuntimeBackend, RuntimeHandle } from './RuntimeBackend';

export type CompiledPlayerState = 'empty' | 'loading' | 'playing' | 'paused' | 'finished' | 'disposed';

/** Minimal player boundary for runtime@2. It knows no Unity, CFXR or Shader Graph concepts. */
export class CompiledEffectPlayer<TContext = unknown> {
  private handle: RuntimeHandle | null = null;
  private state: CompiledPlayerState = 'empty';
  private artifact: WebVfxRuntimeV2 | null = null;

  constructor(private readonly backend: RuntimeBackend<TContext>, private readonly context: TContext) {}

  get playbackState(): CompiledPlayerState { return this.state; }
  get currentArtifact(): WebVfxRuntimeV2 | null { return this.artifact; }
  get root() { return this.handle?.root ?? null; }

  async load(artifact: unknown): Promise<void> {
    if (this.state === 'disposed') throw new Error('Cannot load after dispose().');
    assertWebVfxRuntimeV2(artifact);
    this.state = 'loading';
    this.handle?.dispose();
    const next = await this.backend.instantiate(artifact, this.context);
    this.handle = next;
    this.artifact = artifact;
    this.state = 'playing';
  }

  /** Load a compiler-produced JSON bundle. The player only performs transport
   * and schema validation; all Unity/Shader Graph lowering remains offline. */
  async loadFromUrl(url: string, fetcher: typeof fetch = fetch): Promise<void> {
    if (!url) throw new Error('Compiled artifact URL must be non-empty.');
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`Failed to load compiled artifact (${response.status} ${response.statusText}).`);
    await this.load(await response.json());
  }

  update(dt: number): void {
    if (this.state !== 'playing' || !this.handle) return;
    this.handle.update(Math.max(0, dt));
  }

  restart(): void {
    if (!this.handle) return;
    this.handle.restart();
    this.state = 'playing';
  }

  pause(): void {
    if (!this.handle) return;
    this.handle.pause();
    this.state = 'paused';
  }

  resume(): void {
    if (!this.handle) return;
    this.handle.resume();
    this.state = 'playing';
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.handle?.dispose();
    this.handle = null;
    this.artifact = null;
    this.state = 'disposed';
  }
}
