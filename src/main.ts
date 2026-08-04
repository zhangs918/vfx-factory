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
  QuarksEffectPlayer,
  loadQuarksManifest,
  type QuarksManifestEntry,
} from './effects/QuarksEffectPlayer';

/** Neutral preview studio: shallow blue zenith fading into a bright horizon. */
function makePreviewSky() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, '#2f4c5e');
  g.addColorStop(0.48, '#466477');
  // Stay below bloom threshold: the sky is a clean stage, not an emissive buffer.
  g.addColorStop(0.76, '#617b89');
  g.addColorStop(1, '#788991');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Neutral one-metre checker floor used by the interactive VFX stage. */
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

function setStatus(msg: string) {
  statusEl.textContent = msg;
}

async function main() {
  const urlParams = new URLSearchParams(location.search);
  const regressionMode = urlParams.get('regression') === '1';
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

  // Flat lit stage — particles are unlit; keep fill gentle
  scene.add(new AmbientLight(0xffffff, 0.55));
  const sun = new DirectionalLight(0xffffff, 0.35);
  sun.position.set(4, 8, 2);
  scene.add(sun);

  const checkerFloor = regressionMode ? null : makeCheckerFloorTexture();
  const ground = new Mesh(
    new PlaneGeometry(36, 36),
    new MeshBasicMaterial({
      color: regressionMode ? 0x7a7e82 : 0xffffff,
      map: checkerFloor,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  // A prefab export does not own a scene collider. Keep the synthetic reference stage opt-in:
  // otherwise it can depth-occlude world-space particles that legitimately live below y=0.
  // Oracle regression passes stage=1 explicitly because its Unity capture includes this plane.
  ground.visible = !regressionMode || urlParams.get('stage') === '1';
  scene.add(ground);

  // Interactive-only modeling grid. Keeping it out of regression preserves the fixed oracle
  // buffers, while the slight lift avoids z-fighting with the solid ground plane.
  if (!regressionMode) {
    const grid = new GridHelper(36, 36, 0x30383d, 0x50595e);
    grid.position.y = 0.002;
    const gridMaterial = grid.material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.42;
    gridMaterial.depthWrite = false;
    scene.add(grid);
  }

  const player = new QuarksEffectPlayer();
  if (urlParams.get('debug') === '1') {
    (window as unknown as { __vfxDebugPlayer?: QuarksEffectPlayer }).__vfxDebugPlayer = player;
  }
  scene.add(player.root);
  (window as Window & { __VFX_REGRESSION__?: unknown }).__VFX_REGRESSION__ = {
    get contract() { return player.semanticContract; },
    setSolo: (name: string | null) => player.setSolo(name),
    stepTo: (seconds: number) => player.stepTo(seconds),
    snapshot: () => player.snapshotState(),
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

  // The preview catalog is the union of exported candidates and the production manifest.
  // Production qualification remains authoritative metadata; it no longer hides useful
  // in-progress effects from artists during ordinary preview work.
  const [productionManifest, candidateManifest] = await Promise.all([
    loadQuarksManifest(false),
    loadQuarksManifest(true),
  ]);
  const productionById = new Map(productionManifest.effects.map((entry) => [entry.id, entry]));
  const candidateById = new Map(candidateManifest.effects.map((entry) => [entry.id, entry]));
  const allEntries = [
    ...candidateManifest.effects.map((entry) => productionById.get(entry.id) ?? entry),
    ...productionManifest.effects.filter((entry) => !candidateById.has(entry.id)),
  ].map((entry) => ({ ...entry, isCandidate: !productionById.has(entry.id) }));
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
  const entries = showAllCandidates ? allEntries : (await Promise.all(allEntries.map(async (entry) => {
    if (!entry.isCandidate) return entry;
    try {
      const response = await fetch(`/assets/quarks/${encodeURIComponent(entry.file)}`);
      if (!response.ok || !hasRenderableEmitter(await response.json())) return null;
    } catch { return null; }
    return entry;
  }))).filter((entry): entry is (typeof allEntries)[number] => entry !== null);
  if (!entries.length) {
    setStatus('特效清单为空');
    return;
  }

  for (const e of entries) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = `${e.label}${e.isCandidate ? ' · Candidate' : ''}`;
    selectEl.appendChild(opt);
  }
  selectEl.value = entries[0].id;

  const current = (): QuarksManifestEntry =>
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
  //   ?presentation=authored  show raw Unity orientation instead of the upright preview stage
  //   ?effectHeight=1.15      override the upright preview centre height above the floor
  const effectParam = urlParams.get('effect');
  const soloParam = urlParams.get('solo');
  const freezeParam = urlParams.get('freeze') ? Number(urlParams.get('freeze')) : null;
  if (effectParam && entries.some((e) => e.id === effectParam)) selectEl.value = effectParam;
  player.soloName = soloParam;

  const setPaused = (next: boolean) => {
    paused = next;
    pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (paused) player.pause();
    else player.resume();
    setStatus(`${paused ? 'Paused' : player.isPlaying ? 'Playing' : 'Ready'} · ${current().label}`);
  };

  const play = async () => {
    // Freeze/regression loads must never expose a newly loaded playing system to one RAF
    // before deterministic stepping starts.
    setPaused(freezeParam != null && Number.isFinite(freezeParam));
    const entry = current();
    // Vite treats an encoded `+` path segment as an SPA fallback even though the real static
    // file contains a literal plus. Keep path separators and plus literal; encode spaces and
    // every other unsafe filename character normally.
    const url = `/assets/quarks/${encodeURIComponent(entry.file)
      .replace(/%2F/gi, '/')
      .replace(/%2B/gi, '+')}`;
    try {
      setStatus(`Loading · ${entry.label}`);
      if (loadedId !== entry.id || !player.isPlaying) {
        await player.loadAndPlay(url, entry.label);
        loadedId = entry.id;
      } else {
        player.restart();
      }
      // Interactive presentation is deliberately above the synthetic floor.  This is not an
      // authored-coordinate conversion: `effectHeight` is a host-only display transform and
      // remains overridable per URL for unusually large/small packs.
      const requestedHeight = Number(urlParams.get('effectHeight') ?? 2.0);
      const uprightPreview = !regressionMode && urlParams.get('presentation') !== 'authored';
      player.setVerticalGroundPresentation(
        uprightPreview,
        Number.isFinite(requestedHeight) ? requestedHeight : 2.0,
      );
      const contract = player.semanticContract;
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
        setPaused(true);
        await player.stepTo(freezeParam);
        player.pause();
      }
      setStatus(`${freezeParam != null ? 'Frozen' : 'Playing'} · ${entry.label}${soloParam ? ` · solo=${soloParam}` : ''}${freezeParam != null ? ` · t=${freezeParam}` : ''} · layer=${captureLayer}`);
      hintEl.textContent = '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(msg.split('\n')[0]);
      hintEl.textContent = msg;
      console.error(err);
    }
  };

  selectEl.addEventListener('change', () => {
    loadedId = '';
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
      const wasPlaying = player.isPlaying;
      player.update(dt);
      if (wasPlaying && !player.isPlaying) {
        setStatus(`Finished · ${current().label} · one-shot`);
      }
    }
    // Scene Color pre-pass for distortion/refraction materials (Free Slash Slash World etc.)
    player.captureSceneColor(renderer, scene, camera);
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
