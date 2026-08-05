export default {
  "schema": "semantic-adapter-registry@1",
  "adapters": [
    {
      "id": "legacy-vertex-color-raw",
      "version": 1,
      "kind": "material",
      "fidelity": "material-guid-locked-raw-linear-color-attribute",
      "requiresOracle": true,
      "semantics": {
        "vertexColor": "COLOR UNorm is consumed directly; no sRGB texture decode",
        "materials": [
          { "sourceMaterialGuid": "c1b09b1ca8ba05d4682ccf6db6b1102d", "gain": 1.0 },
          { "sourceMaterialGuid": "219882489a1df4042823f03b5b903103", "gain": 0.65 }
        ]
      }
    },
    {
      "id": "legacy-vertex-color-gain",
      "version": 1,
      "kind": "material",
      "fidelity": "material-guid-locked-linear-color-attribute-gain",
      "requiresOracle": true,
      "semantics": {
        "materials": [
          { "sourceMaterialGuid": "b479681f08574fd4188237f92866cbac", "gain": 1.1 }
        ]
      }
    },
    {
      "id": "legacy-additive-explicit-alpha-factor",
      "version": 1,
      "kind": "material",
      "fidelity": "material-guid-locked-legacy-additive-fragment-and-blend-lowering",
      "requiresOracle": true,
      "semantics": {
        "rgb": "2 * texture.rgb * vertex.rgb * tint.rgb",
        "alpha": "texture.a * vertex.a * tint.a * alphaFactor",
        "blend": "SrcAlpha One",
        "materials": [
          { "sourceMaterialGuid": "c1b09b1ca8ba05d4682ccf6db6b1102d", "alphaFactor": 1.0, "vertexColorSpace": "raw-linear-attribute" },
          { "sourceMaterialGuid": "c6c72eb3fd1471c489daf719f70f62aa", "alphaFactor": 1.0 },
          { "sourceMaterialGuid": "749ea6f567709834fbe474b44674e1ed", "alphaFactor": 1.0 },
          { "sourceMaterialGuid": "a9b550a3d81ca7845b9fb15672984986", "alphaFactor": 1.0 },
          { "sourceMaterialGuid": "b03f3e8f44fe09d48af2ab4d04ddbddb", "alphaFactor": 1.0 },
          { "sourceMaterialGuid": "7cd73ef8e5a31a244a672ae32c0f6ddb", "alphaFactor": 1.0 },
          { "sourceMaterialGuid": "f12d680b3c37c3c4fae5c220798d9977", "alphaFactor": 1.0 },
          { "sourceMaterialGuid": "35db7f8fdfbb7fe4eae9054b84300460", "alphaFactor": 1.0 },
          { "sourceMaterialGuid": "695873166113ab64997efed81c2426c7", "alphaFactor": 1.0 }
        ]
      }
    },
    {
      "id": "sampled-unity-perlin-light",
      "version": 1,
      "kind": "simulation",
      "fidelity": "unity-mathf-perlin-domain-lut-with-live-speed-and-amplitude",
      "requiresOracle": true,
      "semantics": {
        "timeDomain": "effect-local-reference-phase@0",
        "lookup": "Unity Mathf.PerlinNoise(x,0) sampled at dx=1/128",
        "editable": ["baseIntensity", "addIntensity", "smoothFactor", "color", "range"]
      }
    },
    {
      "id": "unity-velocity-over-lifetime",
      "version": 1,
      "kind": "simulation",
      "fidelity": "live-linear-xyz-velocity-offset-with-two-curves",
      "requiresOracle": true,
      "semantics": {
        "linear": "current velocity = accumulated base velocity + evaluated XYZ offset",
        "twoCurves": "independent sample-once random lane per axis",
        "spaces": ["local", "world"]
      }
    },
    {
      "id": "unity-limit-velocity",
      "version": 1,
      "kind": "simulation",
      "fidelity": "live-vector-magnitude-clamp-with-authored-per-step-dampen",
      "requiresOracle": true,
      "semantics": {
        "operation": "lerp(current velocity, normalized(current)*limit(lifetime), 1-(1-dampen)^(delta*30)) when exceeded",
        "timebase": "Unity legacy 30 Hz normalized damping response"
      }
    },
    {
      "id": "unity-size-over-lifetime",
      "version": 1,
      "kind": "simulation",
      "fidelity": "exact-weighted-unity-animation-curve-scalar-size",
      "requiresOracle": true
    },
    {
      "id": "unity-limit-velocity-3d",
      "version": 1,
      "kind": "simulation",
      "fidelity": "live-separate-axis-clamp-with-authored-dampen",
      "requiresOracle": true,
      "semantics": {
        "operation": "per-axis lerp(current, sign(current)*limit(axis,lifetime), dampen) when exceeded",
        "space": "local"
      }
    },
    {
      "id": "constant-euler-rotation",
      "version": 1,
      "kind": "simulation",
      "fidelity": "authored-degrees-per-second-self-or-world-space",
      "requiresOracle": true,
      "semantics": {
        "integration": "fixed-step quaternion composition",
        "unityEulerOrder": "ZXY (equivalent intrinsic YXZ composition)",
        "handedness": "LH angular vector reflected once into RH"
      }
    },
    {
      "id": "unity-two-curves",
      "version": 1,
      "kind": "simulation",
      "fidelity": "sample-once-random-lane-between-live-hermite-curves",
      "requiresOracle": true,
      "semantics": {
        "random": "one interpolation factor sampled at particle birth",
        "evaluation": "lerp(minHermite(emitterOrLifetimeT), maxHermite(emitterOrLifetimeT), factor)"
      }
    },
    {
      "id": "unity-volume-emitter-shapes",
      "version": 1,
      "kind": "simulation",
      "fidelity": "live-box-volume-and-cone-volume-spawn-domain",
      "requiresOracle": true,
      "semantics": {
        "box": "uniform canonical unit-box volume followed by Shape-module TRS",
        "coneVolume": "uniform axial slice and uniform disk at radius + z*tan(angle)",
        "direction": "authored cone ray before Shape-module rotation"
      }
    },
    {
      "id": "unity-effect-lifecycle",
      "version": 1,
      "kind": "simulation",
      "fidelity": "one-shot-root-instance-with-conservative-natural-terminal-time",
      "requiresOracle": true,
      "semantics": {
        "rootLoopPolicy": "one-shot",
        "terminalAction": "stop-and-clear",
        "timeDomain": "unity-root-fixed-step@60hz"
      }
    },
    {
      "id": "slash-screen",
      "version": 2,
      "kind": "material",
      "sourceGraphHash": "cf675eab2cba896fd7a253ca2ecbca3e",
      "fidelity": "reviewed-manual",
      "requiresOracle": true,
      "semantics": {
        "mainUv": "uv0 * tiling + vec2(particleCustom1.y, 0)",
        "dissolveUv": "scrollUV(uv0, dissolveScroll, time)",
        "dissolve": "saturate(lerp(1-dissolve.r, 0, custom1.x) + step(custom1.x, 1-dissolve.r))",
        "baseColor": "selectedColor * (sceneColor(distortedScreenUv) + 1)",
        "alpha": "softDepth * vertex.a * saturate(main.r * opacity) * dissolve * mask.r",
        "softDepth": "saturate((sceneDepthEye-screenPositionRaw.w) * _Soft_Particle * 0.1)",
        "depthConvention": "urp-scene-depth-eye-to-webgl-eye@1"
      }
    },
    {
      "id": "slash-world",
      "version": 3,
      "kind": "material",
      "sourceGraphHash": "e393b829bceade6e945866814a05b88d",
      "fidelity": "reviewed-manual",
      "requiresOracle": true,
      "semantics": {
        "mainUv": "uv0 * tiling + vec2((customUv != 0 ? customUv : particleCustom1.xy).y, (customUv != 0 ? customUv : particleCustom1.xy).x)",
        "vertexStreamBinding": "ParticleSystem Custom1.xy -> TEXCOORD1.xy",
        "baseColor": "sceneColor(screenUv + normalFromTexture(mainUv, offset=0.5, strength=8) * rectangle(mainUv) * distortion * horizontalWindow * displacedUv.y + offset/100) + main.rgb * selectedColor.rgb * colorPower",
        "alpha": "softDepth * (distortion == 0 ? main.r : selectedColor.a)",
        "ignoredLegacyProperties": ["_Opacity"],
        "softDepth": "saturate((sceneDepthEye-screenPositionRaw.w) * _Soft_Particle)",
        "depthConvention": "urp-scene-depth-eye-to-webgl-eye@1"
      }
    },
    {
      "id": "orb-warp",
      "version": 1,
      "kind": "material",
      "sourceGraphHash": "d5a9e535b32c64fc6402563dd1d6ca04",
      "fidelity": "reviewed-manual",
      "requiresOracle": true,
      "semantics": {
        "domain": "uv0 * noiseScale + noiseAnimation * time",
        "noise": "pow((distortion(domain + warpSpeed*time).r + noise((domain + distortion.r*domainWarp)*frequency*octaveFrequency).r*amplitude*octaveAmplitude)/(amplitude+amplitude*octaveAmplitude), noisePower)",
        "baseColor": "lerp(noise*colour, fresnelColor.rgb, fresnelColor.a*fresnel(worldNormal, viewDirection, fresnelPower))",
        "alpha": "saturate(alphaTex.r * vertex.g)",
        "alphaClip": "clip * uv0.x"
      }
    },
    {
      "id": "orb-warp-lit",
      "version": 1,
      "kind": "material",
      "sourceGraphHash": "f686d83dfe1eb51b2412cc31e75994da",
      "fidelity": "reviewed-manual",
      "requiresOracle": true,
      "semantics": {
        "domain": "uv0 * noiseScale + noiseAnimation * time",
        "noise": "same two-octave texture domain warp as orb-warp@1",
        "baseColor": "lerp(noise*colour, fresnelColor.rgb, fresnelColor.a*fresnel(worldNormal, viewDirection, fresnelPower))",
        "alpha": "saturate(alphaTex.r * vertex.a)",
        "alphaClip": "clip * uv0.x"
      }
    },
    {
      "id": "trail-front-face",
      "version": 2,
      "kind": "material",
      "sourceGraphHash": "5dec7e398437ea7cc9af539891fa91ea",
      "fidelity": "reviewed-manual",
      "requiresOracle": true,
      "semantics": {
        "baseColor": "selectedVertex.rgb * softDepth * (frontFace ? frontColor : backColor) * pow(main.rgba, texPower).rgb",
        "alpha": "selectedVertex.a * softDepth * main.r * mask.r",
        "alphaClip": "_Clip * ((_CustomUV > 0) ? 1 : particleCustom1.x)",
        "materialFoldRequirement": "_CustomUV <= 0 selects particleCustom1.x",
        "ignoredLegacyProperties": ["_Opacity", "_Soft_Particle"]
      }
    },
    {
      "id": "parallax-occlusion",
      "version": 1,
      "kind": "material",
      "sourceGraphHash": "a756d5c487fb511ac5631b75e5c9fb63",
      "fidelity": "reviewed-manual",
      "requiresOracle": true
    },
    {
      "id": "unity-urp-lit-reference",
      "version": 1,
      "kind": "material",
      "sourceGraphHash": "builtin",
      "fidelity": "reviewed-ambient-sh9-reference-lighting",
      "requiresOracle": true,
      "semantics": {
        "lighting": "Unity RenderSettings ambientProbe evaluated as linear SH9 against the particle world normal",
        "culling": "Unity material cull mode lowered to explicit WebGL front/back/double-sided state",
        "scope": "URP Lit particle materials whose exported result is ambient-probe driven"
      }
    },
    {
      "id": "unity-legacy-particle-multiply",
      "version": 1,
      "kind": "material",
      "sourceGraphHash": "builtin",
      "fidelity": "reviewed-unity-builtin-source",
      "requiresOracle": true,
      "semantics": {
        "fragment": "prev=vertexColor*mainTex; rgb=lerp(1,prev.rgb,prev.a)",
        "blend": "Zero SrcColor",
        "colorMask": "RGB"
      }
    },
    {
      "id": "unity-legacy-particle-premultiply",
      "version": 1,
      "kind": "material",
      "sourceGraphHash": "builtin",
      "fidelity": "reviewed-unity-builtin-source",
      "requiresOracle": true,
      "semantics": {
        "fragment": "vertexColor*mainTex*vertexColor.a",
        "blend": "One OneMinusSrcAlpha",
        "colorMask": "RGB"
      }
    },
    {
      "id": "unity-trail-semantics",
      "version": 2,
      "kind": "simulation",
      "fidelity": "live-second-lifetime-distance-sampling-width-color-and-death",
      "requiresOracle": true
    },
    {
      "id": "unity-trail-geometry",
      "version": 1,
      "kind": "simulation",
      "fidelity": "sampled-camera-independent-unity-trail-topology",
      "requiresOracle": true
    },
    {
      "id": "unity-trail-geometry",
      "version": 2,
      "kind": "simulation",
      "fidelity": "sampled-camera-independent-unity-trail-topology-compact-binary",
      "requiresOracle": true
    },
    {
      "id": "unity-noise-simplex-offset",
      "version": 1,
      "kind": "simulation",
      "fidelity": "approximate",
      "requiresOracle": true
    },
    {
      "id": "reference-ground-plane",
      "version": 1,
      "kind": "scene-input",
      "fidelity": "host-contract",
      "requiresOracle": true
    },
    {
      "id": "particle-trajectory-cache",
      "version": 4,
      "kind": "simulation",
      "fidelity": "legacy-sampled-camera-independent-state-seed-keyed",
      "requiresOracle": true
    },
    {
      "id": "particle-trajectory-cache",
      "version": 5,
      "kind": "simulation",
      "fidelity": "sampled-camera-independent-particle-state-custom-streams-stable-id-and-terminal-death",
      "requiresOracle": true
    },
    {
      "id": "particle-trajectory-cache",
      "version": 6,
      "kind": "simulation",
      "fidelity": "sampled-camera-independent-state-with-explicit-last-visible-first-absent-terminal-contract",
      "requiresOracle": true
    },
    {
      "id": "unity-mesh-renderer-basis",
      "version": 1,
      "kind": "geometry",
      "fidelity": "source-mesh-reflect-z-once-renderer-pivot-before-live-current-size-trs",
      "requiresOracle": true
    },
    {
      "id": "unity-renderer-alignment",
      "version": 1,
      "kind": "geometry",
      "fidelity": "local-billboard-live-instanced-quad-in-emitter-basis",
      "requiresOracle": true
    },
    {
      "id": "unity-renderer-uv-flip",
      "version": 1,
      "kind": "geometry",
      "fidelity": "renderer-baked-per-particle-atlas-cell-reflection",
      "requiresOracle": true
    },
    {
      "id": "unity-sub-emitter-lifecycle",
      "version": 1,
      "kind": "simulation",
      "fidelity": "parent-event-owned-live-instance-bounded-by-child-duration",
      "requiresOracle": true
    },
    {
      "id": "unity-sub-emitter-inheritance",
      "version": 1,
      "kind": "simulation",
      "fidelity": "event-edge-parent-current-size-and-color-with-strict-rejection-of-rotation-lifetime",
      "requiresOracle": true
    },
    {
      "id": "calibrated-spawn-schedule",
      "version": 1,
      "kind": "simulation",
      "fidelity": "deterministic-camera-independent-spawn",
      "requiresOracle": true
    },
    {
      "id": "unity-effect-controller",
      "version": 1,
      "kind": "simulation",
      "fidelity": "reviewed-capsule-grounded-emitter-gate-and-host-projectile-contract",
      "requiresOracle": true
    },
    {
      "id": "deterministic-light-fade",
      "version": 1,
      "kind": "simulation",
      "fidelity": "authored-delay-linear-intensity-and-terminal-state",
      "requiresOracle": true
    }
  ]
}
;

