/**
 * Host-only stage presentation for the interactive Y-up preview floor.
 *
 * Exported Unity content is already Y-up in authored space (Unity +Y → authored +Y).
 * Default `auto` therefore only lifts the effect above the floor — it must not invent
 * a -90° X tilt from root local +Z (that axis is particle forward, not display up).
 *
 * Authored particle IR stays untouched. World-space simulation must use
 * {@link findAuthoredEffectRoot} so an explicit host tilt never redefines Unity "world".
 */
import type { Object3D } from 'three';

export type StagePresentationMode = 'auto' | 'authored' | 'force-z-up';

export type StagePresentationOptions = {
  mode?: StagePresentationMode;
  /**
   * Legacy boolean: true → `auto`, false → `authored`.
   * Prefer `mode` for new call sites.
   */
  enabled?: boolean;
  lift?: number;
};

export type AuthoredParticleUpAxis = 'y' | 'z' | 'other';

/** Mark the loaded prefab root so world-space modules can ignore host tilt. */
export const VFX_AUTHORED_ROOT_USERDATA = 'vfxAuthoredRoot';

/** |dot| threshold for treating root local +Z as aligned to a stage axis. */
export const STAGE_UP_AXIS_ALIGN_EPS = 0.85;

export const DEFAULT_STAGE_PRESENTATION_LIFT = 1.15;

export function markAuthoredEffectRoot(root: Object3D): void {
  root.userData[VFX_AUTHORED_ROOT_USERDATA] = true;
}

export function clearAuthoredEffectRootMark(root: Object3D | null | undefined): void {
  if (!root) return;
  delete root.userData[VFX_AUTHORED_ROOT_USERDATA];
}

/** Walk to the marked prefab root; fall back to `from` if unmarked. */
export function findAuthoredEffectRoot(from: Object3D): Object3D {
  let node: Object3D | null = from;
  while (node) {
    if (node.userData?.[VFX_AUTHORED_ROOT_USERDATA]) return node;
    node = node.parent;
  }
  return from;
}

/**
 * Diagnostic: where effect-root local +Z points in authored space.
 * Not used to decide default stage tilt — Unity display up is authored +Y.
 */
export function detectAuthoredParticleUpAxis(effectRoot: Object3D): AuthoredParticleUpAxis {
  effectRoot.updateMatrix();
  const te = effectRoot.matrix.elements;
  // Column-major: local +Z axis in parent/authored space.
  const zy = te[9];
  const zz = te[10];
  const absY = Math.abs(zy);
  const absZ = Math.abs(zz);
  if (absY >= STAGE_UP_AXIS_ALIGN_EPS && absY >= absZ) return 'y';
  if (absZ >= STAGE_UP_AXIS_ALIGN_EPS && absZ >= absY) return 'z';
  return 'other';
}

export function resolveStagePresentationMode(
  options: StagePresentationOptions,
): StagePresentationMode {
  if (options.mode === 'auto' || options.mode === 'authored' || options.mode === 'force-z-up') {
    return options.mode;
  }
  if (options.enabled === false) return 'authored';
  return 'auto';
}

/**
 * Whether to apply host -90° X (authored +Z → scene +Y).
 * - auto / authored: never (Unity/authored Y-up)
 * - force-z-up: always (explicit debug / rare true Z-up content)
 */
export function shouldTiltZUpToYUp(
  mode: StagePresentationMode,
  _effectRoot: Object3D | null = null,
): boolean {
  return mode === 'force-z-up';
}

export function resolveStagePresentationPose(
  mode: StagePresentationMode,
  effectRoot: Object3D | null = null,
  lift = DEFAULT_STAGE_PRESENTATION_LIFT,
): { rotationX: number; positionY: number } {
  const tilt = shouldTiltZUpToYUp(mode, effectRoot);
  const liftY = mode === 'authored' ? 0 : Math.max(0, lift);
  return {
    rotationX: tilt ? -Math.PI / 2 : 0,
    positionY: liftY,
  };
}
