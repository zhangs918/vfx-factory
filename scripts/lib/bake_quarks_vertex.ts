/**
 * Offline bake: Quarks stock vertex + CFXR string patches → artifact `.vert.glsl`.
 * Node-only (compile_runtime_v3). Thin player binds the result; production still
 * patches live stock at runtime.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCfxrVertexPatches } from '../../packages/vfx-web-runtime/src/cfxr-vertex-patches.ts';

export const QUARKS_VERTEX_EXECUTION = 'quarks-vertex-v1' as const;

/** three.quarks RenderMode numeric values. */
const QuarksRenderMode = {
  BillBoard: 0,
  StretchedBillBoard: 1,
  Mesh: 2,
  Trail: 3,
  HorizontalBillBoard: 4,
  VerticalBillBoard: 5,
} as const;

const require = createRequire(import.meta.url);

function resolveQuarksPackageRoot(): string {
  let dir = dirname(require.resolve('three.quarks'));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'shaders'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const workspace = join(here, '..', '..', 'node_modules', 'three.quarks');
  if (existsSync(join(workspace, 'src', 'shaders'))) return workspace;
  throw new Error('Unable to locate three.quarks package root for stock vertex templates');
}

function loadQuarksGlslTemplate(fileBase: string): string {
  const path = join(resolveQuarksPackageRoot(), 'src', 'shaders', `${fileBase}.glsl.ts`);
  const source = readFileSync(path, 'utf8');
  const match = source.match(/export default \/\* glsl \*\/ `([\s\S]*?)`;/);
  if (!match) {
    throw new Error(`Failed to extract Quarks GLSL template from ${path}`);
  }
  // Bundled three.quarks normalizes to LF; keep bake needles identical.
  return match[1].replace(/\r\n/g, '\n');
}

const PARTICLE_VERT = loadQuarksGlslTemplate('particle_vert');
const STRETCHED_BB_VERT = loadQuarksGlslTemplate('stretched_bb_particle_vert');
const LOCAL_PARTICLE_VERT = loadQuarksGlslTemplate('local_particle_vert');
const TRAIL_VERT = loadQuarksGlslTemplate('trail_vert');

function quarksStockVertexSource(renderMode: number): string {
  switch (renderMode) {
    case QuarksRenderMode.StretchedBillBoard:
      return STRETCHED_BB_VERT;
    case QuarksRenderMode.Mesh:
      return LOCAL_PARTICLE_VERT;
    case QuarksRenderMode.Trail:
      return TRAIL_VERT;
    case QuarksRenderMode.BillBoard:
    case QuarksRenderMode.HorizontalBillBoard:
    case QuarksRenderMode.VerticalBillBoard:
      return PARTICLE_VERT;
    default:
      throw new Error(`Unsupported Quarks renderMode for stock vertex bake: ${renderMode}`);
  }
}

export type BakedQuarksVertex = {
  vertex: string;
  applied: string[];
  vertexExecution: typeof QUARKS_VERTEX_EXECUTION;
  renderMode: number;
};

/** Bake a patched Quarks vertex program for one renderMode + patch list. */
export function bakeQuarksVertexModule(
  renderMode: number,
  patches: readonly string[],
): BakedQuarksVertex {
  const stock = quarksStockVertexSource(renderMode);
  const { vertexShader, applied } = applyCfxrVertexPatches(stock, patches);
  return {
    vertex: vertexShader,
    applied,
    vertexExecution: QUARKS_VERTEX_EXECUTION,
    renderMode,
  };
}

/** Stable key for detecting shader-id collisions across renderMode/patches. */
export function quarksVertexBakeKey(renderMode: number, patches: readonly string[]): string {
  return `${renderMode}|${[...patches].sort().join(',')}`;
}
