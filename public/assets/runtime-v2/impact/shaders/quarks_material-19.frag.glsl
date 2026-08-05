
precision highp float;
uniform sampler2D uMainMap;
uniform sampler2D uMask;
uniform sampler2D uSceneColor;
uniform float uUseMask;
uniform float uUseSceneColor;
uniform float uUseDissolve;
uniform vec4 uTint;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vCustom1;
void main() {
  vec4 texel = texture2D(uMainMap, vUv);
  float coverage = texel.r;
  if (uUseDissolve > 0.5) coverage *= smoothstep(vCustom1.x - 0.05, vCustom1.x + 0.05, texel.a);
  if (uUseMask > 0.5) coverage *= texture2D(uMask, vUv).r;
  vec3 rgb = uTint.rgb * vColor.rgb;
  if (uUseSceneColor > 0.5) rgb += texture2D(uSceneColor, vUv).rgb;
  float alpha = coverage * uTint.a * vColor.a;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(rgb, alpha);
}