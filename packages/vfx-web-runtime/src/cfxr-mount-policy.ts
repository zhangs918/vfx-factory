/**
 * Mount / dual-path authority policy (URL rollback switches).
 * Thin-safe mount audit helpers live in artifact-emitter-sim.
 * Inject / mounts consume MountPolicy snapshots — they do not read location.
 * Individual flag readers stay module-private; call sites use resolveMountPolicy().
 */

export type BlendSource = 'bridge' | 'artifact';
export type UniformSource = 'bridge' | 'artifact';
export type VertexSource = 'bridge' | 'artifact';
export type FragmentSource = 'bridge' | 'artifact';

export type MountPolicy = {
  blend: BlendSource;
  uniform: UniformSource;
  vertex: VertexSource;
  fragment: FragmentSource;
};

function readPlayerFlag(name: string): string | null {
  if (typeof location === 'undefined') return null;
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/** Snapshot all dual-path URL switches once at lifecycle / batch edges. */
export function resolveMountPolicy(): MountPolicy {
  return {
    // Default artifact; ?blendSource=bridge rolls blend authority back to profile.
    blend: readPlayerFlag('blendSource') === 'bridge' ? 'bridge' : 'artifact',
    // Default artifact; ?uniformSource=bridge keeps inject-written constants.
    uniform: readPlayerFlag('uniformSource') === 'bridge' ? 'bridge' : 'artifact',
    // Default artifact; ?vertexSource=bridge keeps profile-derived patches.
    vertex: readPlayerFlag('vertexSource') === 'bridge' ? 'bridge' : 'artifact',
    // Default artifact; ?cfxrFragment=force reinstalls the CFXR ubershader body.
    fragment: readPlayerFlag('cfxrFragment') === 'force' ? 'bridge' : 'artifact',
  };
}
