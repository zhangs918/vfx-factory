
attribute vec3 instancePosition;
attribute vec3 instanceSize;
attribute vec4 instanceColor;
attribute float instanceFrame;
attribute vec4 instanceCustom1;
uniform float uTileColumns;
uniform float uTileRows;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vCustom1;
void main() {
  float tile = max(1.0, uTileColumns * uTileRows);
  float col = mod(instanceFrame, max(1.0, uTileColumns));
  float row = floor(instanceFrame / max(1.0, uTileColumns));
  vUv = (uv + vec2(col, row)) / vec2(max(1.0, uTileColumns), max(1.0, uTileRows));
  vColor = instanceColor;
  vCustom1 = instanceCustom1;
  vec3 p = position * instanceSize + instancePosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}