/**
 * CFXR production ubershader fragment body.
 * Thin ArtifactQuarksPlayer never loads this — offline quarks-fragment-v1 wins.
 */
import { VFX_TRANSPARENT_OVERDRAW_ALPHA_FLOOR, VFX_UV_EDGE_CLAMP_EPS } from '@vfx-factory/artifact-schema';

/** GLSL numeric-stability floors (frozen-sensitive parallax / orb / AA paths). */
const CFXR_GLSL_DET_EPS = 1e-6;
const CFXR_GLSL_VIEW_Z_EPS = 1e-5;
const CFXR_GLSL_SECANT_DENOM_EPS = 1e-6;
const CFXR_GLSL_ORB_NOISE_EPS = 1e-6;
const CFXR_GLSL_FWIDTH_EPS = 1e-6;
/** Unity PerPixelDisplacement: amplitude authored in centimetres. */
const CFXR_PARALLAX_AMPLITUDE_CM_TO_M = 0.01;
const CFXR_PARALLAX_STEPS = 5;

export const CFXR_UBERSHADER_FRAGMENT = /* glsl */ `
#include <common>
#include <color_pars_fragment>
#include <map_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
#include <tile_pars_fragment>

uniform float hdrMultiply;
uniform float dissolveSmooth;
uniform sampler2D dissolveMap;
uniform vec2 dissolveScroll;
uniform sampler2D maskMap;
uniform vec2 maskSpeed;
uniform float maskRotation;
uniform vec2 maskRotationCenter;
uniform vec2 maskOffset;
uniform float trailUvRotation;
uniform float trailUvStretch;
uniform float trailUvStretchY;
uniform vec2 trailUvScroll;
uniform vec2 trailUvTiling;
uniform vec2 trailUvOffset;
uniform float trailUvDistortionPower;
uniform vec2 trailUvDistortionSpeed;
uniform float maskNoiseScale;
uniform float effectTime;
uniform sampler2D distortionMap;
uniform sampler2D sceneColorMap;
uniform sampler2D sceneDepthMap;
uniform sampler2D heightMap;
uniform float parallaxAmplitude;
uniform sampler2D orbAlphaMap;
uniform sampler2D orbNoiseMap;
uniform vec3 orbColour;
uniform vec4 orbFresnelColor;
uniform vec2 orbNoiseAnimation;
uniform vec2 orbWarpSpeed;
uniform float orbFresnelPower;
uniform float orbNoiseScale;
uniform float orbNoiseFrequency;
uniform float orbNoiseAmplitude;
uniform float orbOctaveFrequencyScale;
uniform float orbOctaveAmplitudeScale;
uniform float orbOctaveDomainWarping;
uniform float orbNoisePower;
uniform float orbUvClipScale;
uniform vec3 sceneColorSize;
uniform float distortionAmount;
uniform float distortionAlphaFloor;
uniform vec2 slashWorldScreenOffset;
uniform float vertColorRgbOn;
uniform float vertColorAlphaOn;
uniform float vertColorGain;
uniform vec3 backColorMul;
uniform float softFadeAmount;
uniform float softParticleStrength;
uniform float cameraNear;
uniform float cameraFar;
uniform float opacityGain;
uniform float legacyAlphaTintFactor;
uniform float alphaClipThreshold;
uniform float dynamicAlphaClipScale;
uniform float texPower;
uniform float colorPower;
uniform vec3 materialColor;
uniform vec3 ambientSky;
uniform vec3 ambientEquator;
uniform vec3 ambientGround;
uniform vec3 ambientSH[9];
uniform vec2 tileCounts;
varying vec4 vCfxrCustom1;
varying vec4 vCfxrCustom2;
varying vec2 vCfxrUvFlip;
varying vec2 vCfxrUv1;
varying vec3 vCfxrWorldPosition;
out vec4 cfxrFragColor;

vec2 applyParticleUvFlip(vec2 uv) {
  vec2 counts = max(tileCounts, vec2(1.0));
  vec2 scaled = min(uv, vec2(1.0 - ${VFX_UV_EDGE_CLAMP_EPS})) * counts;
  vec2 cell = floor(scaled);
  vec2 localUv = fract(scaled);
  #ifdef CFXR_FLIP_X
    localUv.x = 1.0 - localUv.x;
  #endif
  #ifdef CFXR_FLIP_Y
    localUv.y = 1.0 - localUv.y;
  #endif
  localUv = mix(localUv, vec2(1.0) - localUv, vCfxrUvFlip);
  return (cell + localUv) / counts;
}

vec2 applyParallaxOcclusion(vec2 uv) {
  #ifndef CFXR_PARALLAX_OCCLUSION
    return uv;
  #else
    vec3 dpdx = dFdx(vCfxrWorldPosition);
    vec3 dpdy = dFdy(vCfxrWorldPosition);
    vec2 duvdx = dFdx(uv);
    vec2 duvdy = dFdy(uv);
    float det = duvdx.x * duvdy.y - duvdx.y * duvdy.x;
    vec3 tangent = normalize((dpdx * duvdy.y - dpdy * duvdx.y) / max(abs(det), ${CFXR_GLSL_DET_EPS}));
    vec3 bitangent = normalize((-dpdx * duvdy.x + dpdy * duvdx.x) / max(abs(det), ${CFXR_GLSL_DET_EPS}));
    vec3 normal = normalize(cross(tangent, bitangent));
    vec3 viewWorld = normalize(cameraPosition - vCfxrWorldPosition);
    vec3 viewTs = vec3(dot(viewWorld, tangent), dot(viewWorld, bitangent), abs(dot(viewWorld, normal)));

    // Exact constants and units from this source-hash-locked Shader Graph node:
    // Amplitude is authored in centimetres, Tiling/PrimitiveSize are (1,1), Steps=5,
    // LOD=0. Unity normalizes the UV-space view vector before marching.
    float maxHeight = parallaxAmplitude * ${CFXR_PARALLAX_AMPLITUDE_CM_TO_M};
    vec3 viewUv = normalize(vec3(viewTs.xy * maxHeight, max(viewTs.z, ${CFXR_GLSL_VIEW_Z_EPS})));
    const float steps = ${CFXR_PARALLAX_STEPS}.0;
    const float stepSize = 1.0 / steps;
    vec2 texOffsetPerStep = stepSize * (viewUv.xy / -max(viewUv.z, ${CFXR_GLSL_VIEW_Z_EPS}));

    vec2 texOffset = vec2(0.0);
    float prevHeight = texture2D(heightMap, uv + texOffset).r;
    texOffset += texOffsetPerStep;
    float currHeight = texture2D(heightMap, uv + texOffset).r;
    float rayHeight = 1.0 - stepSize;
    for (int i = 0; i < ${CFXR_PARALLAX_STEPS}; i++) {
      if (currHeight > rayHeight) break;
      prevHeight = currHeight;
      rayHeight -= stepSize;
      texOffset += texOffsetPerStep;
      currHeight = texture2D(heightMap, uv + texOffset).r;
    }

    // Unity PerPixelDisplacement.hlsl refines the linear hit with three secant steps.
    float pt0 = rayHeight + stepSize;
    float pt1 = rayHeight;
    float delta0 = pt0 - prevHeight;
    float delta1 = pt1 - currHeight;
    vec2 refinedOffset = texOffset;
    for (int i = 0; i < 3; i++) {
      float denom = delta1 - delta0;
      if (abs(denom) < ${CFXR_GLSL_SECANT_DENOM_EPS}) break;
      float intersectionHeight = (pt0 * delta1 - pt1 * delta0) / denom;
      refinedOffset = (1.0 - intersectionHeight) * texOffsetPerStep * steps;
      currHeight = texture2D(heightMap, uv + refinedOffset).r;
      float delta = intersectionHeight - currHeight;
      if (abs(delta) <= 0.01) break;
      if (delta < 0.0) {
        delta1 = delta;
        pt1 = intersectionHeight;
      } else {
        delta0 = delta;
        pt0 = intersectionHeight;
      }
    }
    return uv + refinedOffset;
  #endif
}

float unityNoiseHash(vec2 uv) {
  // Exact RandomValue kernel emitted by Unity Shader Graph's Simple Noise node. A different
  // hash may look equally noisy, but it changes the mask texture's second-stage lookup.
  return fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);
}
float unityValueNoise(vec2 uv) {
  vec2 i = floor(uv);
  vec2 f = fract(uv);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(unityNoiseHash(i), unityNoiseHash(i + vec2(1.0, 0.0)), f.x),
             mix(unityNoiseHash(i + vec2(0.0, 1.0)), unityNoiseHash(i + vec2(1.0)), f.x), f.y);
}
float unitySimpleNoise(vec2 uv, float scale) {
  return unityValueNoise(uv * scale) * 0.125
       + unityValueNoise(uv * (scale * 0.5)) * 0.25
       + unityValueNoise(uv * (scale * 0.25)) * 0.5;
}

void main() {
    #include <clipping_planes_fragment>
    vec4 vertColor = vColor;
    #include <logdepthbuf_fragment>

    vec4 texSample = vec4(1.0);
    vec4 coverageSample = vec4(1.0);
    #ifdef USE_MAP
      vec2 mainUv = applyParticleUvFlip(vUv);
      #ifdef CFXR_MAIN_UV_SHEAR
        mainUv.x += mainUv.y;
      #endif
      #ifdef CFXR_MAIN_UV_CUSTOM1_Y
        mainUv.x += vCfxrCustom1.y;
      #endif
      #ifdef CFXR_MAIN_UV_CUSTOM1_YX
        mainUv += vCfxrCustom1.yx;
      #endif
      #ifdef CFXR_MAIN_UV_Y_CUSTOM1_Y
        mainUv.y += vCfxrCustom1.y;
      #endif
      #ifdef CFXR_MAIN_UV_OFFSET_UV1
        mainUv += vCfxrUv1;
      #endif
      #ifdef CFXR_TRAIL_UV_V2
        vec2 centeredTrailUv = mainUv - vec2(0.5);
        float trailAngle = radians(trailUvRotation);
        float trailCs = cos(trailAngle);
        float trailSn = sin(trailAngle);
        // Shader Graph Rotate multiplies a row UV by float2x2(c,-s,s,c); GLSL uses
        // column vectors, so transpose that matrix here.
        mainUv = mat2(trailCs, -trailSn, trailSn, trailCs) * centeredTrailUv + vec2(0.5);
        if (trailUvStretch > 0.0) {
          if (trailUvStretchY > 0.5) mainUv.y = pow(max(mainUv.y, 0.0), trailUvStretch);
          else mainUv.x = pow(max(mainUv.x, 0.0), trailUvStretch);
        }
        vec2 trailDistUv = vUv + trailUvDistortionSpeed * effectTime;
        float trailDistSample = texture2D(distortionMap, trailDistUv).r;
        vec2 trailDistortion = clamp(
          pow(max((vUv + trailUvOffset) * trailDistSample, vec2(0.0)),
              vec2(trailUvDistortionPower)),
          vec2(0.0), vec2(1.0));
        vec2 trailScroll = trailUvScroll;
        #ifdef CFXR_TRAIL_SPEED_CUSTOM2
          trailScroll *= vCfxrCustom2.xy;
        #endif
        mainUv = (mainUv + trailDistortion) * trailUvTiling + trailScroll * effectTime;
      #endif
      coverageSample = texture2D(map, mainUv);
      mainUv = applyParallaxOcclusion(mainUv);
      texSample = texture2D(map, mainUv);
      #ifdef TILE_BLEND
        vec2 nextMainUv = applyParticleUvFlip(vUvNext);
        #ifdef CFXR_MAIN_UV_SHEAR
          nextMainUv.x += nextMainUv.y;
        #endif
        #ifdef CFXR_MAIN_UV_CUSTOM1_Y
          nextMainUv.x += vCfxrCustom1.y;
        #endif
        #ifdef CFXR_MAIN_UV_CUSTOM1_YX
          nextMainUv += vCfxrCustom1.yx;
        #endif
        #ifdef CFXR_MAIN_UV_OFFSET_UV1
          nextMainUv += vCfxrUv1;
        #endif
        vec4 nextCoverageSample = texture2D(map, nextMainUv);
        coverageSample = mix(coverageSample, nextCoverageSample, vUvBlend);
        nextMainUv = applyParallaxOcclusion(nextMainUv);
        texSample = mix(texSample, texture2D(map, nextMainUv), vUvBlend);
      #endif
    #endif

    float lum = max(texSample.r, max(texSample.g, texSample.b));
    // Trail / Slash graphs: pow(tex, _TexPower) before tint
    if (texPower > 1.001) {
      texSample.rgb = pow(max(texSample.rgb, 0.0), vec3(texPower));
      lum = pow(max(lum, 0.0), texPower);
    }
    vec3 rgb;
    float alpha;

    // Unity linear project (CFXR_PASSES):
    // - Shuriken vertex colors are gamma-authored → linearize
    // - _Color / _HdrMultiply are linear gains (may be >1) → apply AFTER linearize
    // - Albedo map already linear if SRGBColorSpace; coverage map is NoColorSpace
    vec3 vertLin = mix(
      vertColor.rgb / 12.92,
      pow(max(vertColor.rgb + 0.055, 0.0) / 1.055, vec3(2.4)),
      step(0.04045, vertColor.rgb)
    );
    #ifdef CFXR_VERTEX_COLOR_RAW
      vertLin = vertColor.rgb;
    #endif
    vertLin *= vertColorGain;
    #ifndef CFXR_SLASH_WORLD_V2
    if (colorPower > 1.001) {
      vertLin = pow(max(vertLin, 0.0), vec3(colorPower));
    }
    #endif
    // Shader Graph wiring: graphs that never sample Vertex Color must not be tinted/faded by it
    vertLin = mix(vec3(1.0), vertLin, vertColorRgbOn);
    float vertAlpha = mix(1.0, vertColor.a, vertColorAlphaOn);
    #ifdef CFXR_LEGACY_MULTIPLY
      vec4 legacyPrev = vec4(vertLin, vertAlpha) * texSample;
      rgb = mix(vec3(1.0), legacyPrev.rgb, legacyPrev.a);
      // Unity masks framebuffer alpha; keep a non-zero shader alpha so the generic
      // transparent-material overdraw cutoff cannot alter multiply semantics.
      alpha = mix(1.0, legacyPrev.a, legacyPrev.a);
    #elif defined(CFXR_LEGACY_PREMULTIPLY)
      rgb = vertLin * texSample.rgb * vertAlpha;
      alpha = texSample.a * vertAlpha * vertAlpha;
    #elif defined(CFXR_LEGACY_MULTIPLY_COLORED)
      // Cartoon FX/Legacy/Particle Multiply Colored.shader:
      // lerp(1, TintColor * vertex, texture * vertex.a), then Blend DstColor Zero.
      rgb = mix(vec3(1.0), materialColor * vertLin, texSample.rgb * vertAlpha);
      alpha = coverageSample.a * vertAlpha;
    #elif defined(CFXR_ORB_WARP_V1)
      // Source-hash-locked lowering shared by Orb Warp and Orb Warp Lit. The graph builds a
      // normalized two-octave, texture-authored domain warp, then applies a view Fresnel lerp.
      vec2 orbBaseUv = vUv * orbNoiseScale + orbNoiseAnimation * effectTime;
      float orbDomain = texture2D(
        distortionMap, orbBaseUv + orbWarpSpeed * effectTime).r;
      vec2 orbOctaveUv = (orbBaseUv + vec2(orbDomain * orbOctaveDomainWarping))
        * (orbNoiseFrequency * orbOctaveFrequencyScale);
      float orbOctave = texture2D(orbNoiseMap, orbOctaveUv).r;
      float orbDenominator = max(
        orbNoiseAmplitude * (1.0 + orbOctaveAmplitudeScale), ${CFXR_GLSL_ORB_NOISE_EPS});
      float orbNoise = pow(max(
        (orbDomain + orbOctave * orbNoiseAmplitude * orbOctaveAmplitudeScale)
          / orbDenominator,
        0.0), orbNoisePower);
      vec3 orbDx = dFdx(vCfxrWorldPosition);
      vec3 orbDy = dFdy(vCfxrWorldPosition);
      vec3 orbNormal = normalize(cross(orbDx, orbDy));
      vec3 orbView = normalize(cameraPosition - vCfxrWorldPosition);
      float orbFresnel = pow(1.0 - saturate(abs(dot(orbNormal, orbView))), orbFresnelPower);
      float orbFresnelWeight = orbFresnelColor.a * orbFresnel;
      rgb = mix(orbNoise * orbColour, orbFresnelColor.rgb, orbFresnelWeight);
      #ifdef CFXR_ORB_ALPHA_TEXTURE
        float orbCoverage = texture2D(orbAlphaMap, vUv).r;
      #else
        float orbCoverage = 1.0;
      #endif
      #ifdef CFXR_ORB_ALPHA_GREEN
        alpha = orbCoverage * vertColor.g;
      #else
        alpha = orbCoverage * vertColor.a;
      #endif
    #elif defined(CFXR_SLASH_WORLD_V2)
      rgb = vertLin * texSample.rgb * colorPower;
      #ifdef CFXR_SLASH_WORLD_VERTEX_ALPHA
        alpha = vertAlpha;
      #else
        alpha = coverageSample.r * vertAlpha;
      #endif
    #elif defined(CFXR_TRAIL_FRONT_FACE_V2)
      // Exact, source-hash-locked lowering of Trail.shadergraph:
      // BaseColor = selectedVertex.rgb * softDepth
      //             * (IsFrontFace ? _FrontColor : _BackColor)
      //             * pow(MainTex.rgba, _TexPower).rgb
      // Alpha = selectedVertex.a * softDepth * MainTex.r * MaskTex.r.
      // Soft depth is applied below after reconstructing scene eye depth.
      vec3 faceTint = gl_FrontFacing ? materialColor : backColorMul;
      rgb = vertLin * faceTint * texSample.rgb;
      alpha = coverageSample.r * vertAlpha;
    #elif defined(CFXR_SINGLE_CHANNEL)
      rgb = vertLin * materialColor;
      #ifdef CFXR_COVERAGE_ALPHA
        alpha = coverageSample.a * vertAlpha;
      #elif defined(CFXR_COVERAGE_RED)
        #ifdef CFXR_SLASH_SCREEN_V1
          // Slash.shadergraph saturates the high-gain main coverage before the
          // downstream dissolve and mask products. Moving saturate after mask
          // expands low-valued mask texels by _Opacity and makes the arc 4–5× thicker.
          alpha = saturate(coverageSample.r * opacityGain) * vertAlpha;
        #else
          alpha = coverageSample.r * vertAlpha;
        #endif
      #elif defined(CFXR_COVERAGE_GREEN)
        alpha = coverageSample.g * vertAlpha;
      #else
        alpha = lum * vertAlpha;
      #endif
    #else
      #ifdef CFXR_FRONT_BACK
        // Trail-family Shader Graph: BaseColor = lerp(_BackColor, _FrontColor, tex)
        #ifdef CFXR_FRONT_FACE_SELECT
          vec3 faceTint = gl_FrontFacing ? materialColor : backColorMul;
          rgb = vertLin * mix(backColorMul, faceTint, saturate(lum));
        #else
          rgb = vertLin * mix(backColorMul, materialColor, saturate(lum));
        #endif
      #else
        rgb = vertLin * texSample.rgb * materialColor;
      #endif
      #ifdef CFXR_COVERAGE_ALPHA
        alpha = coverageSample.a * vertAlpha;
      #elif defined(CFXR_COVERAGE_RED)
        alpha = coverageSample.r * vertAlpha;
      #else
        alpha = lum * vertAlpha;
      #endif
    #endif

    #ifdef CFXR_URP_LIT_REFERENCE
      // The camera oracle has no realtime main light. URP Lit still evaluates the scene's
      // ambient probe; reconstruct a geometric world normal and apply the exported three-band
      // ambient gradient. This is an explicit scene-input lowering, not a material-name tint.
      vec3 litDx = dFdx(vCfxrWorldPosition);
      vec3 litDy = dFdy(vCfxrWorldPosition);
      vec3 litNormal = normalize(cross(litDx, litDy));
      if (!gl_FrontFacing) litNormal = -litNormal;
      // Unity's ShadeSH9 packing expanded back into its nine SphericalHarmonicsL2
      // coefficients. These coefficients already contain Unity's irradiance convolution.
      vec3 ambientProbe = ambientSH[0]
        + ambientSH[3] * litNormal.x
        + ambientSH[1] * litNormal.y
        + ambientSH[2] * litNormal.z
        + ambientSH[4] * (litNormal.x * litNormal.y)
        + ambientSH[5] * (litNormal.y * litNormal.z)
        + ambientSH[6] * (3.0 * litNormal.z * litNormal.z - 1.0)
        + ambientSH[7] * (litNormal.x * litNormal.z)
        + ambientSH[8] * (litNormal.x * litNormal.x - litNormal.y * litNormal.y);
      rgb *= max(ambientProbe, vec3(0.0));
    #endif

    #ifdef CFXR_MASK
      // The Slash graph has two independent UV branches. Rotation feeds only the first
      // _MaskTex sample; ScrollUV(default UV, speed, time) feeds Simple Noise. Reusing the
      // rotated coordinate for both silently changes the graph whenever rotation/offset is
      // authored, so keep the two values explicit in the lowering.
      vec2 maskUv = vUv + maskOffset;
      vec2 maskNoiseUv = vUv + maskSpeed * effectTime;
      float angle = radians(maskRotation);
      float cs = cos(angle);
      float sn = sin(angle);
      vec2 centeredMaskUv = maskUv - maskRotationCenter;
      // Shader Graph Rotate uses mul(rowUV, float2x2(c,-s,s,c)). GLSL multiplies
      // column vectors, so its constructor must contain the transposed coefficients.
      maskUv = mat2(cs, -sn, sn, cs) * centeredMaskUv + maskRotationCenter;
      #ifdef CFXR_MASK_WARP_SIMPLE_NOISE
        float innerMask = texture2D(maskMap, maskUv).r;
        // Graph topology: Rotate(UV0) feeds the inner mask directly; ScrollUV is used
        // only by Simple Noise. Applying scroll to the inner sample erases long streaks.
        float maskNoise = unitySimpleNoise(maskNoiseUv, maskNoiseScale);
        maskUv = vec2(innerMask * maskNoise);
      #endif
      vec4 maskSample = texture2D(maskMap, maskUv);
      #ifdef CFXR_MASK_ALPHA
        float mask = maskSample.a;
      #else
        float mask = maskSample.r;
      #endif
      alpha *= mask;
    #endif

    // _Opacity only exists in the connected Alpha DAGs that declare it. The reviewed
    // Trail graph has a stale property with this name, so its adapter excludes the gain.
    #if defined(CFXR_TRAIL_FRONT_FACE_V2) || defined(CFXR_SLASH_WORLD_V2) || defined(CFXR_SLASH_SCREEN_V1)
      alpha = saturate(alpha);
    #else
      alpha = saturate(alpha * opacityGain);
    #endif

    #ifdef CFXR_LEGACY_DOUBLE_TINT
      // Unity's reviewed built-in Additive/Alpha Blended particle programs return
      // 2 * texture * vertexColor * _TintColor before fixed-function blending.
      rgb *= 2.0;
      alpha = saturate(alpha * legacyAlphaTintFactor);
    #endif

    // Output linear HDR — the composer's OutputPass applies ACES + sRGB exactly like
    // the Unity demo Volume (Tonemapping mode: ACES), so no shader-side compression here.
    if (hdrMultiply > 0.0) {
      rgb *= hdrMultiply;
    }

    #ifdef CFXR_DISTORTION
      // Unity Slash-style BaseColor = refracted Scene Color + own emission chain (Add node);
      // both operands are linear HDR here, matching the graph's Add.
      vec2 distUv = gl_FragCoord.xy / max(sceneColorSize.xy, vec2(1.0));
      vec2 n;
      #ifdef CFXR_SLASH_WORLD_V2
        // Exact Slash World.shadergraph lowering:
        // NormalFromTexture(R, offset=.5, strength=8) × Rectangle(mainUv,1,1), then
        // horizontal smoothstep window × displaced UV.y before adding to screen UV.
        float normalOffset = 0.0125; // pow(0.5, 3) * 0.1
        float normalBase = texture2D(distortionMap, mainUv).r;
        float normalU = texture2D(distortionMap, mainUv + vec2(normalOffset, 0.0)).r;
        float normalV = texture2D(distortionMap, mainUv + vec2(0.0, normalOffset)).r;
        vec3 graphNormal = normalize(vec3(
          -(normalU - normalBase) * 8.0,
          -(normalV - normalBase) * 8.0,
          1.0));
        vec2 rectangleD = abs(mainUv * 2.0 - 1.0) - vec2(1.0);
        vec2 rectangleCoverage = saturate(1.0 - rectangleD / max(fwidth(rectangleD), vec2(${CFXR_GLSL_FWIDTH_EPS})));
        float rectangle = min(rectangleCoverage.x, rectangleCoverage.y);
        vec2 meshDistortion = graphNormal.xy * distortionAmount * rectangle;
        vec2 displacedMeshUv = vUv + meshDistortion;
        float edgeWindow = smoothstep(0.0, 0.5, displacedMeshUv.x)
          * smoothstep(1.0, 0.5, displacedMeshUv.x)
          * displacedMeshUv.y;
        n = graphNormal.xy;
        distUv += meshDistortion * edgeWindow + slashWorldScreenOffset / 100.0;
      #else
        n = texture2D(distortionMap, vUv).rg * 2.0 - 1.0;
        distUv += n * distortionAmount;
      #endif
      vec3 scene = texture2D(sceneColorMap, clamp(distUv, 0.0, 1.0)).rgb;
      #ifdef CFXR_SLASH_SCREEN_V1
        rgb = scene * rgb + rgb;
      #else
        rgb = scene + rgb;
      #endif
      alpha = max(alpha, saturate(length(n)) * distortionAlphaFloor);
    #endif

    #ifdef CFXR_SLASH_SCREEN_V1
      float slashDissolve = 1.0 - texture2D(
        dissolveMap, vUv + dissolveScroll * effectTime).r;
      float slashDissolveTime = clamp(vCfxrCustom1.x, 0.0, 1.0);
      alpha *= saturate(
        mix(slashDissolve, 0.0, slashDissolveTime)
        + step(slashDissolveTime, slashDissolve));
    #elif defined(CFXR_DISSOLVE)
      float dissolveTime = clamp(vCfxrCustom1.x, 0.0, 1.0);
      float dissolveTex = texture2D(dissolveMap, vUv).r;
      #ifdef CFXR_INVERT_DISSOLVE
        dissolveTex = 1.0 - dissolveTex;
      #endif
      // Match CFXR.cginc: lerp(-sm, 1+sm, dissolveTime) + smoothstep(dissolve±sm, time)
      float sm = max(dissolveSmooth, 0.01);
      float dt = mix(-sm, 1.0 + sm, dissolveTime);
      alpha *= smoothstep(dissolveTex - sm, dissolveTex + sm, dt);
    #endif

    #ifdef CFXR_SOFT_FADE
      vec2 depthUv = gl_FragCoord.xy / max(sceneColorSize.xy, vec2(1.0));
      float sceneDepth = texture2D(sceneDepthMap, depthUv).x;
      float sceneViewZ = -(cameraNear * cameraFar)
        / ((cameraFar - cameraNear) * sceneDepth - cameraFar);
      float particleViewZ = -(cameraNear * cameraFar)
        / ((cameraFar - cameraNear) * gl_FragCoord.z - cameraFar);
      // The leading minus in the reconstruction converts three.js view Z to the same
      // positive eye-distance convention used by Shader Graph Scene Depth (Eye).
      float depthFade = saturate((sceneViewZ - particleViewZ) * softParticleStrength);
      float appliedDepthFade = mix(1.0, depthFade, softFadeAmount);
      alpha *= appliedDepthFade;
      #ifdef CFXR_TRAIL_FRONT_FACE_V2
        rgb *= appliedDepthFade;
      #endif
    #endif

    // Match Shader Graph Alpha Clip. Keep the tiny generic cutoff only for non-clipped
    // transparent materials to avoid zero-alpha overdraw.
    #ifdef CFXR_ORB_WARP_V1
      if (alpha < clamp(vUv.x * orbUvClipScale, 0.0, 1.0)) discard;
    #endif
    #ifdef CFXR_DYNAMIC_ALPHA_CLIP
      #ifdef CFXR_DYNAMIC_ALPHA_CLIP_Y
        float dynamicClipSource = vCfxrCustom1.y;
      #elif defined(CFXR_DYNAMIC_ALPHA_CLIP_Z)
        float dynamicClipSource = vCfxrCustom1.z;
      #elif defined(CFXR_DYNAMIC_ALPHA_CLIP_W)
        float dynamicClipSource = vCfxrCustom1.w;
      #elif defined(CFXR_DYNAMIC_ALPHA_CLIP_UV1_X)
        float dynamicClipSource = vCfxrUv1.x;
      #elif defined(CFXR_DYNAMIC_ALPHA_CLIP_UV1_Y)
        float dynamicClipSource = vCfxrUv1.y;
      #else
        float dynamicClipSource = vCfxrCustom1.x;
      #endif
      if (alpha < clamp(dynamicClipSource * dynamicAlphaClipScale, 0.0, 1.0)) discard;
    #endif
    if (alphaClipThreshold > 0.0) {
      if (alpha < alphaClipThreshold) discard;
    } else if (alpha < ${VFX_TRANSPARENT_OVERDRAW_ALPHA_FLOOR}) {
      discard;
    }
    cfxrFragColor = vec4(rgb, saturate(alpha));
}
`;
