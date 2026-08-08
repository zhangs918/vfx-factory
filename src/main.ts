import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  Mesh,
  GridHelper,
  PlaneGeometry,
  MeshBasicMaterial,
  Clock,
  Vector2,
  SRGBColorSpace,
  ACESFilmicToneMapping,
  NoToneMapping,
  CanvasTexture,
  RepeatWrapping,
  NearestFilter,
  Color,
  WebGLRenderTarget,
  UnsignedByteType,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  loadQuarksManifest,
  loadRuntimeV3Manifest,
  type RuntimeV3ManifestEntry,
} from '@vfx-factory/web-runtime/manifest';
import type {
  QuarksEffectPlayer,
  ArtifactQuarksPlayer,
} from '@vfx-factory/web-runtime/artifact-runtime';

/** Dark preview studio: low zenith fading into a muted horizon (below bloom). */
function makePreviewSky() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, '#0e141a');
  g.addColorStop(0.48, '#151c24');
  // Stay below bloom threshold: the sky is a clean stage, not an emissive buffer.
  g.addColorStop(0.76, '#1c242e');
  g.addColorStop(1, '#232b34');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Oracle-only checker floor (Unity regression stage includes this plane). */
function makeCheckerFloorTexture() {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 2;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#999fa2';
  ctx.fillRect(0, 0, 2, 2);
  ctx.fillStyle = '#686f73';
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillRect(1, 1, 1, 1);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.repeat.set(18, 18);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

const statusEl = document.querySelector('#status') as HTMLElement;
const selectEl = document.querySelector('#effectSelect') as HTMLSelectElement;
const playBtn = document.querySelector('#playBtn') as HTMLButtonElement;
const pauseBtn = document.querySelector('#pauseBtn') as HTMLButtonElement;
const resetCameraBtn = document.querySelector('#resetCameraBtn') as HTMLButtonElement;
const hintEl = document.querySelector('#exportHint') as HTMLElement;
const canvas = document.querySelector('#c') as HTMLCanvasElement;
const tweakPanel = document.querySelector('#tweakPanel') as HTMLElement | null;
const tweakTint = document.querySelector('#tweakTint') as HTMLInputElement | null;
const tweakHdr = document.querySelector('#tweakHdr') as HTMLInputElement | null;
const tweakOpacity = document.querySelector('#tweakOpacity') as HTMLInputElement | null;
const tweakScale = document.querySelector('#tweakScale') as HTMLInputElement | null;
const tweakSpeed = document.querySelector('#tweakSpeed') as HTMLInputElement | null;
const tweakHdrVal = document.querySelector('#tweakHdrVal') as HTMLElement | null;
const tweakOpacityVal = document.querySelector('#tweakOpacityVal') as HTMLElement | null;
const tweakScaleVal = document.querySelector('#tweakScaleVal') as HTMLElement | null;
const tweakSpeedVal = document.querySelector('#tweakSpeedVal') as HTMLElement | null;
const tweakResetBtn = document.querySelector('#tweakResetBtn') as HTMLButtonElement | null;

function setStatus(msg: string) {
  statusEl.textContent = msg;
}

function hexToRgb01(hex: string): [number, number, number] {
  const raw = hex.replace('#', '');
  const n = Number.parseInt(raw.length === 3
    ? raw.split('').map((c) => c + c).join('')
    : raw, 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function formatTweak(value: number) {
  return value.toFixed(2);
}

async function main() {
  const urlParams = new URLSearchParams(location.search);
  const regressionMode = urlParams.get('regression') === '1';
  const runtimeV2ArtifactMode = urlParams.get('runtime') === 'v2-artifact';
  const runtimeV2Mode = runtimeV2ArtifactMode || urlParams.get('runtime') === 'v2';
  const compareLegacy = urlParams.get('compare') === 'legacy' || urlParams.get('legacy') === '1';
  // Two preview paths only:
  //   default          → thin player + offline v3 artifacts (new)
  //   ?compare=legacy  → QuarksEffectPlayer on source JSON (old oracle)
  // ?thinPlayer=1 is a deprecated no-op alias for the default path.
  const runtimeV3Mode = !runtimeV2Mode && !compareLegacy;
  const thinPlayerMode = runtimeV3Mode;
  // Thin playback is compiled from frozen-quarks; force that corpus on the new path.
  // Legacy may still opt into live /assets/quarks by omitting frozen=1.
  const frozenQuarks = urlParams.get('frozen') === '1' || thinPlayerMode;
  // Production imports only the artifact facade. Legacy/runtime2 is a separate, explicit
  // comparison chunk and cannot enter the production bundle by accident.
  const runtimeModule = await import('@vfx-factory/web-runtime/artifact-runtime');
  const {
    QuarksEffectPlayer,
    V3ArtifactPlayer,
    ArtifactQuarksPlayer,
    ThinArtifactBackend,
  } = runtimeModule;
  const legacyModule = runtimeV2Mode || compareLegacy
    ? await import('@vfx-factory/web-runtime/legacy-runtime')
    : null;
  if (regressionMode) (document.querySelector('#hud') as HTMLElement).style.display = 'none';
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  // Match the Unity demo post stack (Post Process Profile 1.asset): ACES tonemapping.
  // Fidelity shaders output linear HDR; ACES + bloom below reproduce URP's look.
  const captureLayer = urlParams.get('layer') ?? (urlParams.get('post') === '0' ? 'tonemap' : 'final');
  if (!['raw', 'tonemap', 'final'].includes(captureLayer)) {
    throw new Error(`Unsupported capture layer '${captureLayer}'. Use raw, tonemap, or final.`);
  }
  renderer.toneMapping = captureLayer === 'raw' ? NoToneMapping : ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = new Scene();
  // Oracle captures use an opaque, constant reference sky. Interactive preview keeps the
  // authored gradient, while regression mode removes that unrelated buffer difference.
  scene.background = regressionMode ? new Color(0xdce6ee) : makePreviewSky();

  // FOV 60; low near-horizon 3/4 like the Unity reference capture
  const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  const parseVectorParam = (name: string, fallback: [number, number, number]) => {
    const values = urlParams.get(name)?.split(',').map(Number);
    return values?.length === 3 && values.every(Number.isFinite)
      ? values as [number, number, number]
      : fallback;
  };
  camera.position.fromArray(parseVectorParam('cameraPosition', [2.15, 1.55, 4.55]));

  const controls = new OrbitControls(camera, canvas);
  controls.target.fromArray(parseVectorParam('cameraTarget', [0, 0.95, 0]));
  controls.enableDamping = !regressionMode;
  controls.enabled = !regressionMode;

  // Flat lit stage — particles are unlit; keep fill gentle and dim for dark preview.
  scene.add(new AmbientLight(0xffffff, regressionMode ? 0.55 : 0.28));
  const sun = new DirectionalLight(0xffffff, regressionMode ? 0.35 : 0.16);
  sun.position.set(4, 8, 2);
  scene.add(sun);

  // Interactive preview has no ground plane. Oracle regression may opt in with stage=1
  // because Unity captures include that reference floor.
  if (regressionMode && urlParams.get('stage') === '1') {
    const ground = new Mesh(
      new PlaneGeometry(36, 36),
      new MeshBasicMaterial({
        color: 0x7a7e82,
        map: makeCheckerFloorTexture(),
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
  }

  // Interactive-only modeling grid (no solid floor). Kept out of regression buffers.
  if (!regressionMode) {
    const grid = new GridHelper(36, 36, 0x1a2228, 0x2a333c);
    grid.position.y = 0.002;
    const gridMaterial = grid.material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.28;
    gridMaterial.depthWrite = false;
    scene.add(grid);
  }

  const physicsResolver = {
    resolve(position: any, normal: any) {
      if (position.y > 0) return false;
      position.y = 0;
      normal.set(0, 1, 0);
      return true;
    },
  };
  // Thin artifact playback is the only production path. Legacy/runtime2 require an
  // explicit query switch so a failed qualification can never silently fall back.
  const player: QuarksEffectPlayer | ArtifactQuarksPlayer = runtimeV2Mode || compareLegacy
    ? new (legacyModule as NonNullable<typeof legacyModule>).QuarksEffectPlayer({ physicsResolver })
    : new ArtifactQuarksPlayer({ physicsResolver });
  const artifactUrl = urlParams.get('artifact') ?? '';
  const artifactBase = artifactUrl.includes('/') ? artifactUrl.slice(0, artifactUrl.lastIndexOf('/')) : '';
  const compiledPlayer = runtimeV2Mode
    ? new (legacyModule as NonNullable<typeof legacyModule>).CompiledEffectPlayer(
      new (legacyModule as NonNullable<typeof legacyModule>).ThreeRuntimeBackend(),
      { parent: scene, resourceBaseUrl: urlParams.get('runtimeBase') ?? artifactBase },
    )
    : null;
  const v3Player = runtimeV3Mode
    ? new V3ArtifactPlayer(new ThinArtifactBackend(player as ArtifactQuarksPlayer))
    : null;
  if (runtimeV2Mode) (window as Window & { __VFX_RUNTIME2__?: unknown }).__VFX_RUNTIME2__ = compiledPlayer;
  if (urlParams.get('debug') === '1') {
    (window as unknown as { __vfxDebugPlayer?: unknown }).__vfxDebugPlayer = player;
  }
  if (!runtimeV2Mode) scene.add(player.root);

  const canLiveTweak = typeof (player as QuarksEffectPlayer).applyLiveTweaks === 'function'
    && !runtimeV2Mode
    && !thinPlayerMode;
  if (tweakPanel) tweakPanel.hidden = !canLiveTweak;

  const syncTweakLabels = () => {
    if (tweakHdr && tweakHdrVal) tweakHdrVal.textContent = formatTweak(Number(tweakHdr.value));
    if (tweakOpacity && tweakOpacityVal) tweakOpacityVal.textContent = formatTweak(Number(tweakOpacity.value));
    if (tweakScale && tweakScaleVal) tweakScaleVal.textContent = formatTweak(Number(tweakScale.value));
    if (tweakSpeed && tweakSpeedVal) tweakSpeedVal.textContent = formatTweak(Number(tweakSpeed.value));
  };

  const resetTweakUi = () => {
    if (tweakTint) tweakTint.value = '#ffffff';
    if (tweakHdr) tweakHdr.value = '1';
    if (tweakOpacity) tweakOpacity.value = '1';
    if (tweakScale) tweakScale.value = '1';
    if (tweakSpeed) tweakSpeed.value = '1';
    syncTweakLabels();
  };

  const pushLiveTweaks = () => {
    if (!canLiveTweak) return;
    (player as QuarksEffectPlayer).applyLiveTweaks({
      tint: hexToRgb01(tweakTint?.value ?? '#ffffff'),
      hdrGain: Number(tweakHdr?.value ?? 1),
      opacityGain: Number(tweakOpacity?.value ?? 1),
      scale: Number(tweakScale?.value ?? 1),
      speed: Number(tweakSpeed?.value ?? 1),
    });
  };

  if (canLiveTweak) {
    for (const el of [tweakTint, tweakHdr, tweakOpacity, tweakScale, tweakSpeed]) {
      el?.addEventListener('input', () => {
        syncTweakLabels();
        pushLiveTweaks();
      });
    }
    tweakResetBtn?.addEventListener('click', () => {
      resetTweakUi();
      (player as QuarksEffectPlayer).resetLiveTweaks();
    });
    syncTweakLabels();
  }

  (window as Window & { __VFX_REGRESSION__?: unknown }).__VFX_REGRESSION__ = {
    get contract() { return player.semanticContract; },
    setSolo: (name: string | null) => player.setSolo(name),
    stepTo: (seconds: number) => player.stepTo(seconds),
    snapshot: () => player.snapshotState(),
    debugLifecycleState: () => player.debugLifecycleState,
    dumpLiveMaterialStamp: () => {
      const dump = (player as { dumpLiveMaterialStamp?: () => unknown }).dumpLiveMaterialStamp;
      if (typeof dump !== 'function') {
        throw new Error('dumpLiveMaterialStamp unavailable on current player');
      }
      return dump.call(player);
    },
  };

  // camera-baked oracle frames are ARGB32. Use the same LDR blend target only for raw
  // comparison; production tonemap/final keeps EffectComposer's default half-float HDR.
  const oracleTarget = captureLayer === 'raw'
    ? new WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: UnsignedByteType })
    : undefined;
  const composer = new EffectComposer(renderer, oracleTarget);
  composer.addPass(new RenderPass(scene, camera));
  // Keep the deterministic oracle stack unchanged, but use a restrained interactive bloom:
  // the Web material program preserves Unity HDR peaks and the old 0.6 pass intensity made
  // overlapping particles wash out the scene. Preview bloom is still visible, just not a
  // second exposure multiplier on top of ACES.
  const bloom = new UnrealBloomPass(
    new Vector2(window.innerWidth, window.innerHeight),
    regressionMode ? 0.6 : 0.08,
    regressionMode ? 0.4 : 0.15,
    regressionMode ? 1.5 : 2.5,
  );
  // Match Unity Scene/Prefab view when its Post Processing toggle is disabled.
  const postEnabled = captureLayer === 'final';
  if (postEnabled) composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Build a common catalog first; the v3 disposition gate below then exposes
  // candidates only under the explicit artist/debug query switches.
  const [productionManifest, candidateManifest, runtimeV3Manifest] = await Promise.all([
    loadQuarksManifest(false, frozenQuarks ? '/assets/frozen-quarks' : '/assets/quarks'),
    loadQuarksManifest(true, frozenQuarks ? '/assets/frozen-quarks' : '/assets/quarks'),
    runtimeV3Mode ? loadRuntimeV3Manifest() : Promise.resolve(null),
  ]);
  if (frozenQuarks) {
    // A frozen manifest is authoritative: rejected source effects are not selectable and
    // therefore cannot be mistaken for a runtime regression caused by a missing artifact.
    productionManifest.effects = productionManifest.effects.filter((entry: any) => entry.status === 'compiled');
    candidateManifest.effects = candidateManifest.effects.filter((entry: any) => entry.status === 'compiled');
  }
  const productionById = new Map(productionManifest.effects.map((entry) => [entry.id, entry]));
  const candidateById = new Map(candidateManifest.effects.map((entry) => [entry.id, entry]));
  const runtimeV3ById = new Map<string, RuntimeV3ManifestEntry>(
    (runtimeV3Manifest?.effects ?? []).map((entry) => [entry.id, entry]),
  );
  const allEntries = [
    ...candidateManifest.effects.map((entry) => productionById.get(entry.id) ?? entry),
    ...productionManifest.effects.filter((entry) => !candidateById.has(entry.id)),
  ].map((entry) => ({
    ...entry,
    isCandidate: !productionById.has(entry.id),
    runtimeV3: runtimeV3ById.get(entry.id),
  }));
  const showAllCandidates = new URLSearchParams(location.search).get('all') === '1';
  // Candidate catalog hygiene: hide exports that contain particles but no renderable
  // material/geometry. They remain available through ?all=1 for diagnostics; production
  // entries are never hidden by this heuristic.
  const hasRenderableEmitter = (json: any): boolean => {
    const materials = new Map<string, any>((json?.materials ?? []).map((m: any) => [m.uuid, m]));
    let renderable = false;
    const walk = (o: any) => {
      if (renderable || !o || typeof o !== 'object') return;
      if (o.type === 'ParticleEmitter' && (o.ps?.unityInitialState?.length ?? 0) > 0) {
        const mat = materials.get(o.ps?.material);
        const profile = mat?.vfxProgram?.profile;
        const omitted = !mat || String(mat.name ?? '').includes('Missing') || profile?.opacity === 0;
        if (!omitted && (mat.map || o.ps?.instancingGeometry || o.ps?.renderMode === 1)) renderable = true;
      }
      (o.children ?? []).forEach(walk);
    };
    walk(json?.object);
    return renderable;
  };
  let entries = showAllCandidates ? allEntries : (await Promise.all(allEntries.map(async (entry) => {
    if (!entry.isCandidate) return entry;
    try {
      const response = await fetch(`/assets/quarks/${encodeURIComponent(entry.file)}`);
      if (!response.ok || !hasRenderableEmitter(await response.json())) return null;
    } catch { return null; }
    return entry;
  }))).filter((entry): entry is (typeof allEntries)[number] => entry !== null);
  if (runtimeV3Mode) {
    // Production preview lists only artifacts whose complete material/simulation/
    // trajectory closure is thin-ready. Candidates remain available in the
    // manifests and qualification tools, but cannot masquerade as playable Thin.
    entries = entries.filter((entry) => entry.runtimeV3?.status === 'compiled'
      && typeof entry.runtimeV3?.artifact === 'string'
      && entry.runtimeV3.artifact.length > 0
      && entry.runtimeV3.capabilities?.thinPlayer === true);
  }
  if (!entries.length) {
    setStatus(thinPlayerMode
      ? 'Thin 清单为空（无已编译 v3 artifact）'
      : '特效清单为空');
    return;
  }

  for (const e of entries) {
    const opt = document.createElement('option');
    opt.value = e.id;
    if (thinPlayerMode) {
      const evidence = e.runtimeV3?.qualification?.changedPixels === 0
        ? 'Pixel'
        : 'Manual';
      opt.textContent = `${e.label} · Thin ${evidence}`;
    } else {
      opt.textContent = `${e.label}${e.isCandidate ? ' · Candidate' : ''}`;
    }
    selectEl.appendChild(opt);
  }

  selectEl.value = entries[0].id;

  const current = () =>
    entries.find((e) => e.id === selectEl.value) ?? entries[0];

  hintEl.textContent =
    'Unity 导出步骤：\n' +
    '1. npm run setup:quarks-exporter -- "/你的Unity工程"\n' +
    '2. 选中 CFXR3 Fire Explosion B 根物体\n' +
    '3. Tools → Quarks → Export Selected Effect to JSON\n' +
    '4. 存到 public/assets/quarks/CFXR3 Fire Explosion B.json\n' +
    '详见 tools/unity-quarks-exporter/EXPORT_GUIDE.zh-CN.md';

  let paused = false;
  let loadedId = '';
  let referenceView: {
    fov: number;
    near: number;
    far: number;
    position: [number, number, number];
    target: [number, number, number];
  } | null = null;

  const applyReferenceView = () => {
    if (!referenceView) return;
    camera.fov = referenceView.fov;
    camera.near = referenceView.near;
    camera.far = referenceView.far;
    camera.position.fromArray(referenceView.position);
    controls.target.fromArray(referenceView.target);
    camera.updateProjectionMatrix();
    controls.update();
  };

  // Debug harness (mechanism, works for any effect):
  //   ?effect=<id>   pre-select effect
  //   ?solo=<name>   only that emitter runs
  //   ?freeze=<sec>  deterministically step to t then pause
  //   ?post=0        disable bloom for raw silhouette comparison
  //   ?cameraPosition=x,y,z&cameraTarget=x,y,z  interactive custom opening view
  //   ?presentation=auto|authored|force-z-up
  //        auto (default): lift only — keep Unity/authored Y-up (no host -90° X)
  //        authored: raw Unity orientation, no lift
  //        force-z-up: always apply host -90° X (debug / rare true Z-up)
  //   ?effectHeight=1.15      override the upright preview centre height above the floor
  const effectParam = urlParams.get('effect');
  const soloParam = urlParams.get('solo');
  const freezeParam = urlParams.get('freeze') ? Number(urlParams.get('freeze')) : null;
  const presentationParam = urlParams.get('presentation');
  const stagePresentationMode = presentationParam === 'authored'
    ? 'authored' as const
    : presentationParam === 'force-z-up'
      ? 'force-z-up' as const
      : 'auto' as const;
  // Manifest ids are lowercase; accept case-insensitive ?effect= so regressions
  // cannot silently fall through to the first catalog entry (false PASS).
  if (effectParam) {
    const matched = entries.find((e) => e.id === effectParam)
      ?? entries.find((e) => e.id.toLowerCase() === effectParam.toLowerCase());
    if (matched) selectEl.value = matched.id;
    else {
      throw new Error(
        `Unknown effect id '${effectParam}'. Refusing to fall back to the default catalog entry.`
        + ` catalog=${entries.length} has=${entries.some((e) => e.id.toLowerCase() === effectParam.toLowerCase())}`
        + ` frozen=${frozenQuarks} thin=${thinPlayerMode}`,
      );
    }
  }
  player.soloName = soloParam;

  const setPaused = (next: boolean) => {
    paused = next;
    pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (runtimeV2Mode) {
      if (paused) compiledPlayer?.pause();
      else compiledPlayer?.resume();
    } else if (paused) player.pause();
    else player.resume();
    const active = runtimeV2Mode ? compiledPlayer?.playbackState === 'playing' : player.isPlaying;
    const runtimeLabel = runtimeV2Mode
      ? ' · runtime=v2'
      : thinPlayerMode
        ? ' · runtime=v3-thin'
        : compareLegacy
          ? ' · runtime=legacy'
          : '';
    setStatus(`${paused ? 'Paused' : active ? 'Playing' : 'Ready'} · ${current().label}${runtimeLabel}`);
  };

  const play = async () => {
    // Freeze/regression loads must never expose a newly loaded playing system to one RAF
    // before deterministic stepping starts.
    // runtime@2 steps through its own transport state; keep it playing until the
    // deterministic stepping loop has populated the instance buffers.
    setPaused(!runtimeV2Mode && freezeParam != null && Number.isFinite(freezeParam));
    const entry = current();
    const useV3 = runtimeV3Mode;
    // Vite treats an encoded `+` path segment as an SPA fallback even though the real static
    // file contains a literal plus. Keep path separators and plus literal; encode spaces and
    // every other unsafe filename character normally.
    const artifactRoot = frozenQuarks ? '/assets/frozen-quarks' : '/assets/quarks';
    const url = `${artifactRoot}/${encodeURIComponent(entry.file)
      .replace(/%2F/gi, '/')
      .replace(/%2B/gi, '+')}`;
    try {
      setStatus(`Loading · ${entry.label}`);
      if (loadedId !== entry.id || !player.isPlaying) {
        if (useV3) {
          const v3Url = entry.runtimeV3?.artifact;
          if (!v3Url) throw new Error(`No runtime-v3 artifact declared for '${entry.id}'`);
          await v3Player?.load(v3Url, entry.label, entry.id, entry.runtimeV3?.sha256);
        } else if (runtimeV2ArtifactMode) {
          if (!artifactUrl) throw new Error('runtime=v2-artifact requires ?artifact=/path/runtime.json.');
          const artifactResponse = await fetch(artifactUrl);
          if (!artifactResponse.ok) throw new Error(`Failed to load compiled artifact (${artifactResponse.status}).`);
          await compiledPlayer?.loadBundle(artifactUrl);
        } else if (runtimeV2Mode) {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Failed to load source (${response.status}).`);
          const source = await response.json();
          const { compileLegacyQuarksSource } = await import('@vfx-factory/unity-vfx-compiler');
          const result = compileLegacyQuarksSource(source);
          const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
          if (!result.artifact || errors.length) {
            throw new Error(errors[0]?.message ?? 'Source could not be lowered to runtime@2.');
          }
          await compiledPlayer?.load(result.artifact);
        } else if (compareLegacy) {
          await player.loadAndPlay(url, entry.label);
        } else {
          throw new Error('No production artifact runtime selected. Use ?compare=legacy only for diagnostics.');
        }
        loadedId = entry.id;
      } else {
        if (runtimeV2Mode) compiledPlayer?.restart();
        else player.restart();
      }
      // Interactive presentation is host-only. `auto` lifts without tilting so authored
      // Unity Y-up stays upright (Magic fire / Big Splash). Regression stays authored.
      const requestedHeight = Number(urlParams.get('effectHeight') ?? 2.0);
      if (!runtimeV2Mode) {
        player.setStagePresentation({
          mode: regressionMode ? 'authored' : stagePresentationMode,
          lift: Number.isFinite(requestedHeight) ? requestedHeight : 2.0,
        });
      }
      const contract = runtimeV2Mode ? null : player.semanticContract;
      if (contract) {
        referenceView = contract.referenceCamera;
        // Playback and camera ownership are independent in the interactive preview. Regression
        // remains contract-locked; users can orbit, select another effect and restart without
        // losing their working view.
        if (regressionMode) applyReferenceView();
        // Regression diagnostic only: test a coordinate-system camera hypothesis without
        // mutating the qualified contract. The production path never supplies this parameter.
        const diagnosticCameraZ = urlParams.get('diagnosticCameraZ');
        if (regressionMode && diagnosticCameraZ != null && Number.isFinite(Number(diagnosticCameraZ)))
          camera.position.z = Number(diagnosticCameraZ);
        if (regressionMode) {
          camera.updateProjectionMatrix();
          controls.update();
        }
      }
      if (freezeParam != null && Number.isFinite(freezeParam)) {
        if (runtimeV2Mode) {
          const step = 1 / 60;
          for (let t = 0; t < freezeParam; t += step) compiledPlayer?.update(step);
          compiledPlayer?.pause();
          paused = true;
          pauseBtn.setAttribute('aria-pressed', 'true');
          pauseBtn.textContent = 'Resume';
        } else {
          setPaused(true);
          await player.stepTo(freezeParam);
          player.pause();
        }
      }
      // Re-apply preview tweaks after load/restart rebuilt batch materials.
      if (canLiveTweak) pushLiveTweaks();
      const runtimeTag = useV3
        ? ' · runtime=v3-thin'
        : compareLegacy
          ? (frozenQuarks ? ' · runtime=legacy-frozen' : ' · runtime=legacy')
          : runtimeV2Mode
            ? ' · runtime=v2'
            : '';
      setStatus(`${freezeParam != null ? 'Frozen' : 'Playing'} · ${entry.label}${soloParam ? ` · solo=${soloParam}` : ''}${freezeParam != null ? ` · t=${freezeParam}` : ''} · layer=${captureLayer}${runtimeTag}`);
      hintEl.textContent = '';
    } catch (err) {
      // A failed selection must never leave the previous successful effect on
      // screen under a new label.
      if (useV3) player.clear();
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(msg.split('\n')[0]);
      hintEl.textContent = msg;
      console.error(err);
    }
  };

  selectEl.addEventListener('change', () => {
    loadedId = '';
    if (canLiveTweak) {
      resetTweakUi();
      (player as QuarksEffectPlayer).resetLiveTweaks();
    }
    setStatus(`Selected · ${current().label}`);
  });
  playBtn.addEventListener('click', () => void play());
  pauseBtn.addEventListener('click', () => setPaused(!paused));
  resetCameraBtn.addEventListener('click', applyReferenceView);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      void play();
    } else if (e.code === 'KeyP' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setPaused(!paused);
    } else if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      applyReferenceView();
    }
  });

  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  const clock = new Clock();
  let autoPlayed = false;

  setStatus('Ready · 导出 JSON 后按 Space 播放');
  renderer.setAnimationLoop(() => {
    const rawDt = clock.getDelta();
    const dt = paused ? 0 : Math.min(rawDt, 0.05);
    if (!regressionMode) controls.update();
    if (!paused) {
      const wasPlaying = runtimeV2Mode
        ? compiledPlayer?.playbackState === 'playing'
        : player.isPlaying;
      if (runtimeV2Mode) compiledPlayer?.update(dt);
      else player.update(dt);
      const isPlaying = runtimeV2Mode
        ? compiledPlayer?.playbackState === 'playing'
        : player.isPlaying;
      if (wasPlaying && !isPlaying) {
        setStatus(`Finished · ${current().label} · one-shot`);
      }
    }
    // Scene Color pre-pass for distortion/refraction materials (Free Slash Slash World etc.)
    if (!runtimeV2Mode) player.captureSceneColor(renderer, scene, camera);
    composer.render();

    if (!autoPlayed && clock.elapsedTime > 0.4) {
      autoPlayed = true;
      void play();
    }
  });
}

main().catch((err) => {
  console.error(err);
  setStatus(err instanceof Error ? err.message : String(err));
});
