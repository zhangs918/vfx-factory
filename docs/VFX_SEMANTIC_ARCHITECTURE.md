# Unity VFX → Web semantic architecture

## Decision

Production artifacts are editable live programs. A `camera-baked@1` artifact is an offline
comparison oracle and is never a production fallback.

The compiler has four explicit outcomes:

1. `live-particles@1`: particle simulation and a versioned material program are lowered exactly.
2. `live-particles@1` plus a UV-domain material bake: allowed only for a view-independent material
   sub-expression; particles, curves, transforms and blending remain live. This tier is planned.
3. Rejected production export plus `camera-baked@1` oracle: required for view/scene-dependent or
   otherwise unsupported semantics.
4. Hard failure: neither a valid live program nor a trustworthy oracle was produced.

There is no path from a camera-baked artifact into `manifest.json`.

## Reviewed manual GLSL

Manual lowering is permitted only as a compiler backend operation, never as an effect-name case.
Each lowering is registered by the exact Shader Graph content hash and declares its texture roles,
coverage channel, required vertex streams and scene inputs in `particle-material-program@2`. Any
graph edit changes the hash and returns the material to strict rejection until it is reviewed.

The current reviewed lowerings are `slash-world@1`, `trail-front-face@1` and
`parallax-occlusion@1`. This is deliberately narrower than claiming general Shader Graph support:
Custom Function nodes can contain arbitrary HLSL, so an unrestricted translator would be another
shader compiler and still would not supply Unity/URP scene services.

## Implemented simulation transport

- independent `Custom1.xyzw` instanced attributes (never hidden in size or flipbook fields);
- weighted Unity animation curves and Two Curves random-lane calibration;
- independent-axis mesh rotation with Unity→Web handedness conversion;
- fractional-frame start delays;
- fixed-seed atlas-cell calibration for Unity's non-portable native RNG;
- hierarchy-driven Birth sub-emitters with calibrated child spawn state;
- explicit host `particle-scene-query@1` collision provider;
- full-hierarchy simulation with renderer-only isolation for oracle layer buffers.

Known non-exact adapters remain oracle-gated: Unity Noise uses a declared approximation because its
native kernel is not published; child-event scheduling and long-lived mesh rotation still require
further convergence where the image thresholds fail.

## Adversarial findings

### Shader Graph source

Regex parsing of `.shadergraph` JSON is a version-pinned compiler frontend, not a stable Unity API.
It must verify the graph/package fingerprint and reject unknown schema. The preferred frontend is
Unity-side graph deserialization for the pinned Shader Graph package. `ShaderData.Pass.SourceCode`
is useful as a compiler oracle, but translating the full generated URP HLSL is not a tractable
general-purpose WebGL strategy.

Whitelisting node class names is necessary but insufficient: lowering must prove the connected
expression, slots, constants, texture color spaces and branch specialization represented by each
IR operation. Unsupported view-independent UV expressions can be baked as material functions;
Scene Color, Scene Depth, front-face, collision and other scene inputs must stay live or be rejected.

### Simulation backend

`three.quarks` is a backend for the supported subset, not the semantic definition. Its scheduler,
billboard construction, curve phase and vertex streams can differ from Unity. Runtime adapters must
be covered by fixed-step state and image regression. If adapter patches keep growing, replace the
affected batch/simulation component rather than weakening the IR.

### Determinism versus editability

Unity documents deterministic playback through `randomSeed`, and every particle exposes its own
seed, but it does not specify a cross-runtime PRNG algorithm. Equal numeric seeds therefore do not
guarantee equal Unity and JavaScript samples.

The current `calibrated-spawn-state@1` stores only spawn-time particle attributes; motion, curves,
material evaluation and rendering remain live. It is not frame playback, but edits to shape and
start modules require calibration regeneration. This limitation is declared in the IR. The planned
replacement is `deterministic-random-lanes@1`: export normalized random choices and evaluate the
authored start modules in WebGL, preserving both cross-engine determinism and high-level editing.

## Required regression buffers

- fixed seed and fixed 1/60 simulation step;
- exported reference camera and exact integer frame indices;
- full composite, background, and one buffer per emitter;
- raw linear, tone-mapped, and final/bloom output;
- complete Web particle state and simulation-step trace;
- repeat capture equality plus Unity-oracle silhouette, energy, area and centroid checks.

## Sources

- Unity `useAutoRandomSeed`: https://docs.unity3d.com/2023.2/Documentation/ScriptReference/ParticleSystem-useAutoRandomSeed.html
- Unity per-particle `randomSeed`: https://docs.unity3d.com/2023.2/Documentation/ScriptReference/ParticleSystem.Particle-randomSeed.html
- Unity `ShaderUtil.GetShaderData`: https://docs.unity3d.com/2023.2/Documentation/ScriptReference/ShaderUtil.GetShaderData.html
- Unity `ShaderData.Pass.SourceCode`: https://docs.unity3d.com/2022.3/Documentation/ScriptReference/ShaderData.Pass.html
- Unity Shader Graph Custom Function node: https://docs.unity3d.com/Packages/com.unity.shadergraph@10.5/manual/Custom-Function-Node.html
- three.quarks repository: https://github.com/Alchemist0823/three.quarks
