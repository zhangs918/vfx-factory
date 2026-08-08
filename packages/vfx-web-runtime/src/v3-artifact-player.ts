import { assertVfxRuntimeArtifactV3, type VfxRuntimeArtifactV3 } from '@vfx-factory/artifact-schema';
import { V3ResourceCache } from './v3-resource-cache';

/** Minimal execution seam between the offline artifact loader and a renderer.
 * The v3 player deliberately knows nothing about QuarksEffectPlayer; the current
 * adapter implements this seam for the production three.quarks runtime. */
export interface PreparedV3Effect {
  artifact: VfxRuntimeArtifactV3;
  quarksConfig: Record<string, any>;
  /** Production includes cfxrState; thin sinks may receive runtimeConfig only. */
  runtimeState: {
    cfxrState?: Record<string, unknown>;
    runtimeConfig: Record<string, unknown>;
  };
  shaders: Record<string, {
    vertex: string;
    fragment: string;
    uniforms: Record<string, string>;
    execution?: 'quarks-fragment-v1' | 'validated-only';
    vertexExecution?: 'quarks-vertex-v1';
    defines?: Record<string, string | number | boolean>;
    provenance?: {
      kind?: string;
      capturedAt?: string;
      injectMode?: string;
      captureSource?: string;
    };
  }>;
  geometryData: Record<string, { attributes: unknown; index?: unknown }>;
}

export interface ArtifactRuntimeSink {
  /** Whether this backend consumes external GLSL modules at runtime. */
  readonly needsShaders?: boolean;
  /**
   * Thin player owns simulation from hydrated emitter `ps` bags and does not
   * restore global cfxrState maps — skip loading those ResourceId tables.
   */
  readonly skipCfxrRuntimeHydrate?: boolean;
  loadPrepared(effect: PreparedV3Effect, label: string): Promise<void>;
}

/** Hydrate compiler-owned particle tables through explicit resource bindings. */
async function hydrateCompiledTables(
  node: any,
  resources: Record<string, VfxRuntimeArtifactV3['resources'][string]>,
  cache: V3ResourceCache,
): Promise<void> {
  if (!node || typeof node !== 'object') return;
  const ps = node.ps as (Record<string, unknown> & {
    unityInitialStateResourceId?: string;
    unityTrajectoryCacheResourceId?: string;
  }) | undefined;
  if (ps) {
    for (const [refKey, valueKey] of [
      ['unityInitialStateResourceId', 'unityInitialState'],
      ['unityTrajectoryCacheResourceId', 'unityTrajectoryCache'],
    ] as const) {
      const resourceId = ps[refKey];
      if (!resourceId) continue;
      const resource = resources[resourceId];
      if (!resource) throw new Error(`Compiled table '${resourceId}' is not declared by the artifact.`);
      ps[valueKey] = await cache.loadJsonVerified(resource.uri, resource.sha256);
      // Drop the binding id once inlined so thin bags / asserts see only hydrated tables.
      delete ps[refKey];
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) await hydrateCompiledTables(child, resources, cache);
  }
}

async function hydrateRuntimeTables(
  runtimeState: NonNullable<VfxRuntimeArtifactV3['runtimeState']>,
  resources: Record<string, VfxRuntimeArtifactV3['resources'][string]>,
  cache: V3ResourceCache,
): Promise<void> {
  const cfxr = runtimeState.cfxrState as Record<string, any>;
  for (const key of Object.keys(cfxr).filter((name) => name.endsWith('ResourceId'))) {
    const valueKey = key.slice(0, -'ResourceId'.length);
    const resourceId = cfxr[key];
    if (!resourceId) continue;
    const resource = resources[resourceId];
    if (!resource) throw new Error(`Compiled runtime table '${resourceId}' is not declared by the artifact.`);
    cfxr[valueKey] = await cache.loadJsonVerified(resource.uri, resource.sha256);
    delete cfxr[key];
  }
}

/** v3 artifact loader. It accepts only the offline contract, resolves its
 * effect-scoped resources, hydrates the simulation, and delegates execution to
 * the qualified render kernel during the migration window. No Unity/compiler
 * inputs cross this boundary. */
export class V3ArtifactPlayer {
  private artifact: VfxRuntimeArtifactV3 | null = null;
  private readonly resources = new V3ResourceCache();
  private loadGeneration = 0;
  private commitQueue: Promise<void> = Promise.resolve();
  constructor(private readonly runtimeSink: ArtifactRuntimeSink) {}

  async load(
    source: string | URL | object,
    label: string,
    expectedEffectId?: string,
    expectedSha256?: string,
  ): Promise<void> {
    const generation = ++this.loadGeneration;
    let raw: object;
    if (typeof source === 'object' && !(source instanceof URL)) {
      raw = source;
    } else {
      const bytes = await this.resources.loadVerified(String(source), expectedSha256 ?? '');
      try { raw = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new Error(`Failed to parse v3 artifact ${String(source)} as JSON`); }
    }
    assertVfxRuntimeArtifactV3(raw);
    if (expectedEffectId && raw.effectId.toLowerCase() !== expectedEffectId.toLowerCase()) {
      throw new Error(`v3 artifact effect '${raw.effectId}' does not match requested '${expectedEffectId}'`);
    }
    const artifact = raw;
    let quarksConfig = artifact.simulation ? structuredClone(artifact.simulation as any) : null;
    let runtimeState = artifact.runtimeState
      ? structuredClone(artifact.runtimeState)
      : undefined;
    let externalQuarksConfig = false;
    const shaderSources: PreparedV3Effect['shaders'] = {};
    const geometryData: PreparedV3Effect['geometryData'] = {};
    if (artifact.files) {
      const config = await this.resources.loadJsonVerified<{
        schema?: 'vfx-thin-config@1' | 'vfx-runtime-config@3';
        quarksConfig?: any;
        simulation?: any;
        runtimeState: {
          cfxrState?: Record<string, unknown>;
          runtimeConfig: Record<string, unknown>;
        };
      }>(artifact.files.config.uri, artifact.files.config.sha256);
      if (!config || typeof config !== 'object'
        || (!config.quarksConfig && !config.simulation)
        || !config.runtimeState || typeof config.runtimeState !== 'object'
        || !config.runtimeState.runtimeConfig || typeof config.runtimeState.runtimeConfig !== 'object') {
        throw new Error(`v3 artifact '${artifact.effectId}' external config is incomplete`);
      }
      if (this.runtimeSink.skipCfxrRuntimeHydrate) {
        if (config.schema !== 'vfx-thin-config@1' || config.runtimeState.cfxrState != null) {
          throw new Error(
            `v3 artifact '${artifact.effectId}' thin config must omit cfxrState`,
          );
        }
      } else if (!config.runtimeState.cfxrState
        || typeof config.runtimeState.cfxrState !== 'object') {
        throw new Error(`v3 artifact '${artifact.effectId}' bridge config is missing cfxrState`);
      }
      externalQuarksConfig = !!config.quarksConfig;
      quarksConfig = config.quarksConfig ?? config.simulation ?? null;
      runtimeState = config.runtimeState as NonNullable<VfxRuntimeArtifactV3['runtimeState']>;
      if (this.runtimeSink.needsShaders) {
        await Promise.all(Object.values(artifact.files.shaders).map(async (shader) => {
          const [vertex, fragment] = await Promise.all([
            this.resources.loadTextVerified(shader.vertex.uri, shader.vertex.sha256),
            this.resources.loadTextVerified(shader.fragment.uri, shader.fragment.sha256),
          ]);
          const meta = artifact.shaders?.[shader.id] as {
            uniforms?: Record<string, string>;
            execution?: 'quarks-fragment-v1' | 'validated-only';
            vertexExecution?: 'quarks-vertex-v1';
            defines?: Record<string, string | number | boolean>;
            provenance?: PreparedV3Effect['shaders'][string]['provenance'];
          } | undefined;
          const fileMeta = shader as typeof shader & {
            defines?: Record<string, string | number | boolean>;
            provenance?: PreparedV3Effect['shaders'][string]['provenance'];
          };
          shaderSources[shader.id] = {
            vertex,
            fragment,
            uniforms: shader.uniforms ?? meta?.uniforms ?? {},
            execution: shader.execution ?? meta?.execution,
            vertexExecution: shader.vertexExecution ?? meta?.vertexExecution,
            defines: fileMeta.defines ?? meta?.defines,
            provenance: fileMeta.provenance ?? meta?.provenance,
          };
          if (!vertex.includes('void main') || !fragment.includes('void main')) {
            throw new Error(`v3 artifact '${artifact.effectId}' shader '${shader.id}' is not executable GLSL`);
          }
        }));
      }
    }
    if (!artifact.files && this.runtimeSink.needsShaders) {
      for (const [id, shader] of Object.entries(artifact.shaders ?? {})) {
        shaderSources[id] = {
          vertex: shader.vertex,
          fragment: shader.fragment,
          uniforms: shader.uniforms,
          execution: shader.execution,
          vertexExecution: shader.vertexExecution,
          defines: (shader as { defines?: Record<string, string | number | boolean> }).defines,
          provenance: (shader as { provenance?: PreparedV3Effect['shaders'][string]['provenance'] }).provenance,
        };
      }
    }
    if (!quarksConfig || !runtimeState) {
      throw new Error(`v3 artifact '${artifact.effectId}' has no hydrated config`);
    }
    // Collect binding ids into the integrity set BEFORE hydrate deletes them.
    const referenced = new Map<string, VfxRuntimeArtifactV3['resources'][string]>();
    const collectCompiledTableRefs = (node: any) => {
      if (!node || typeof node !== 'object') return;
      const ps = node.ps;
      for (const key of ['unityInitialStateResourceId', 'unityTrajectoryCacheResourceId']) {
        const id = ps?.[key];
        const resource = id ? artifact.resources[id] : undefined;
        if (resource) referenced.set(resource.id, resource);
      }
      if (Array.isArray(node.children)) node.children.forEach(collectCompiledTableRefs);
    };
    collectCompiledTableRefs(quarksConfig.object);
    if (!this.runtimeSink.skipCfxrRuntimeHydrate) {
      for (const key of Object.keys(runtimeState.cfxrState as any).filter((name) => name.endsWith('ResourceId'))) {
        const id = (runtimeState.cfxrState as any)[key];
        const resource = id ? artifact.resources[id] : undefined;
        if (resource) referenced.set(resource.id, resource);
      }
    }
    await hydrateCompiledTables(quarksConfig.object, artifact.resources, this.resources);
    if (!this.runtimeSink.skipCfxrRuntimeHydrate) {
      await hydrateRuntimeTables(runtimeState, artifact.resources, this.resources);
    }
    if (this.runtimeSink.needsShaders) {
      for (const [pipelineId, pipeline] of Object.entries(artifact.pipelines)) {
        if (!shaderSources[pipeline.shader]) {
          throw new Error(`v3 artifact '${artifact.effectId}' pipeline '${pipelineId}' has no verified shader module '${pipeline.shader}'.`);
        }
      }
    }
    if (artifact.files && !externalQuarksConfig) {
      throw new Error(`v3 artifact '${artifact.effectId}' config is not a quarksConfig artifact`);
    }
    for (const pipeline of Object.values(artifact.pipelines)) {
      for (const id of Object.values(pipeline.textures ?? {})) {
        const resource = artifact.resources[id];
        if (resource) referenced.set(resource.id, resource);
      }
    }
    // Geometry bindings are also explicit v3 resources. Load only geometry used by
    // this effect. Hydrate the cloned Quarks JSON at this boundary as well as
    // exposing geometryData: ObjectLoader requires `geometry.data` synchronously
    // during parse and must never see the split resource placeholder.
    for (const geometry of quarksConfig.geometries ?? []) {
      const resource = geometry.resourceId ? artifact.resources[geometry.resourceId] : undefined;
      if (geometry.resourceId && !resource) {
        throw new Error(`v3 artifact '${artifact.effectId}' geometry references undeclared resource '${geometry.resourceId}'`);
      }
      if (!resource) continue;
      const data = await this.resources.loadJsonVerified<{ attributes: unknown; index?: unknown }>(resource.uri, resource.sha256);
      if (!data || typeof data !== 'object' || !data.attributes) {
        throw new Error(`v3 artifact '${artifact.effectId}' geometry resource '${resource.id}' is invalid`);
      }
      geometry.data = data;
      geometryData[resource.id] = data;
      referenced.set(resource.id, resource);
    }
    // Quarks resolves image URLs from the serialized config itself. Register the
    // same image resources with the artifact cache so every texture crossing the
    // online boundary is integrity-checked before the backend starts playback.
    const resourcesByUri = new Map(Object.values(artifact.resources).map((resource) => [resource.uri, resource]));
    for (const image of quarksConfig.images ?? []) {
      const resource = image?.url ? resourcesByUri.get(String(image.url)) : undefined;
      if (resource) referenced.set(resource.id, resource);
    }
    await Promise.all([...referenced.values()].map((resource) => this.resources.loadVerified(resource.uri, resource.sha256)));
    const commit = this.commitQueue.catch(() => {}).then(async () => {
      // Preparation is intentionally concurrent, but renderer mutation is ordered.
      // A superseded request never reaches the sink; if a newer request arrives
      // during an in-flight sink commit, its commit runs immediately afterwards.
      if (generation !== this.loadGeneration) return;
      await this.runtimeSink.loadPrepared({
        artifact,
        quarksConfig,
        // Thin sinks only need runtimeConfig (startDelays); omit cfxrState so they
        // cannot accidentally hydrate or consult global CFXR maps.
        runtimeState: this.runtimeSink.skipCfxrRuntimeHydrate
          ? { runtimeConfig: runtimeState.runtimeConfig }
          : runtimeState,
        shaders: shaderSources,
        geometryData,
      }, label);
      if (generation === this.loadGeneration) this.artifact = artifact;
    });
    this.commitQueue = commit.then(() => {}, () => {});
    await commit;
  }

  get effectId(): string | null { return this.artifact?.effectId ?? null; }
}
