import {
  ACESFilmicToneMapping, AmbientLight, CanvasTexture, Clock, Color, GridHelper,
  Mesh, MeshBasicMaterial, NoToneMapping, PerspectiveCamera, PlaneGeometry,
  RepeatWrapping, Scene, SRGBColorSpace, DirectionalLight, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CompiledEffectPlayer } from '../packages/vfx-web-runtime/src/runtime2/CompiledEffectPlayer';
import { ThreeRuntimeBackend } from '../packages/vfx-web-runtime/src/runtime2/ThreeRuntimeBackend';

type RuntimeEntry = { id: string; label: string; artifact: string; status: string };
const statusEl = document.querySelector('#status') as HTMLElement;
const selectEl = document.querySelector('#effectSelect') as HTMLSelectElement;
const playBtn = document.querySelector('#playBtn') as HTMLButtonElement;
const pauseBtn = document.querySelector('#pauseBtn') as HTMLButtonElement;
const resetBtn = document.querySelector('#resetCameraBtn') as HTMLButtonElement;
const hintEl = document.querySelector('#exportHint') as HTMLElement;
const canvas = document.querySelector('#c') as HTMLCanvasElement;
const params = new URLSearchParams(location.search);
const setStatus = (value: string) => { statusEl.textContent = value; };

function checkerTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 2;
  const ctx = c.getContext('2d')!; ctx.fillStyle = '#a4aaad'; ctx.fillRect(0, 0, 2, 2);
  ctx.fillStyle = '#70777b'; ctx.fillRect(0, 0, 1, 1); ctx.fillRect(1, 1, 1, 1);
  const texture = new CanvasTexture(c); texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping; texture.repeat.set(18, 18);
  return texture;
}

const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = params.get('post') === '0' ? NoToneMapping : ACESFilmicToneMapping;
const scene = new Scene(); scene.background = new Color(0x315a72);
scene.add(new AmbientLight(0xffffff, 0.5)); const sun = new DirectionalLight(0xffffff, 0.35); sun.position.set(4, 8, 2); scene.add(sun);
const floor = new Mesh(new PlaneGeometry(36, 36), new MeshBasicMaterial({ map: checkerTexture() }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
const grid = new GridHelper(36, 36, 0x30383d, 0x50595e); grid.position.y = 0.002; scene.add(grid);
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
camera.position.fromArray((params.get('cameraPosition')?.split(',').map(Number) as [number, number, number]) ?? [2.15, 1.55, 4.55]);
const controls = new OrbitControls(camera, canvas); controls.target.set(0, 0.95, 0); controls.enableDamping = true;
const player = new CompiledEffectPlayer(new ThreeRuntimeBackend(), { parent: scene, resourceBaseUrl: '' });
(window as any).__VFX_RUNTIME2__ = player;

let entries: RuntimeEntry[] = []; let paused = false; let loaded = '';
const artifactRoot = params.get('candidates') === '1' ? '/assets/runtime-v2-candidates' : '/assets/runtime-v2';
const current = () => entries.find((entry) => entry.id === selectEl.value) ?? entries[0];
const setPaused = (next: boolean) => {
  paused = next; pauseBtn.textContent = paused ? 'Resume' : 'Pause'; pauseBtn.setAttribute('aria-pressed', String(paused));
  if (paused) player.pause(); else player.resume();
};
const play = async () => {
  const entry = current(); if (!entry) return;
  try {
    setStatus(`Loading · ${entry.label}`);
    const url = `${artifactRoot}/${entry.artifact}`;
    if (loaded !== entry.id || !player.currentArtifact) { await player.loadBundle(url); loaded = entry.id; } else player.restart();
    const freeze = Number(params.get('freeze'));
    if (Number.isFinite(freeze)) {
      paused = false; player.resume(); for (let t = 0; t < freeze; t += 1 / 60) player.update(1 / 60);
      player.pause(); paused = true; pauseBtn.textContent = 'Resume'; pauseBtn.setAttribute('aria-pressed', 'true');
      setStatus(`Frozen · ${entry.label} · t=${freeze} · runtime=v2-artifact`);
    } else setStatus(`Playing · ${entry.label} · runtime=v2-artifact`);
  } catch (error) { const message = error instanceof Error ? error.message : String(error); setStatus(message); hintEl.textContent = message; console.error(error); }
};

const manifest = await fetch(`${artifactRoot}/manifest.json`).then((response) => response.json()) as { effects: RuntimeEntry[] };
entries = manifest.effects.filter((entry) => entry.status === 'compiled');
for (const entry of entries) { const option = document.createElement('option'); option.value = entry.id; option.textContent = `${entry.label} · Artifact${params.get('candidates') === '1' ? ' · Candidate' : ''}`; selectEl.appendChild(option); }
const effectParam = params.get('effect'); if (effectParam && entries.some((entry) => entry.id === effectParam)) selectEl.value = effectParam;
selectEl.addEventListener('change', () => { loaded = ''; void play(); }); playBtn.addEventListener('click', () => void play());
pauseBtn.addEventListener('click', () => { setPaused(!paused); }); resetBtn.addEventListener('click', () => { camera.position.set(2.15, 1.55, 4.55); controls.target.set(0, 0.95, 0); });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
const clock = new Clock(); let started = false;
renderer.setAnimationLoop(() => { const dt = Math.min(clock.getDelta(), 0.05); if (!paused) player.update(dt); controls.update(); renderer.render(scene, camera); if (!started && clock.elapsedTime > 0.4) { started = true; void play(); } });
