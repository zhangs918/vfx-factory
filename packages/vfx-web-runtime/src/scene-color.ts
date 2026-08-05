import {
  DepthTexture,
  LinearFilter,
  RGBAFormat,
  UnsignedIntType,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { BatchedRenderer } from 'three.quarks';
import {
  cfxrNeedsSceneColor,
  setCfxrSceneColorTexture,
} from './cfxrQuarksFidelity';

/** Host-side SceneColor prepass for materials whose IR explicitly requests refraction. */
export class SceneColorCapture {
  private target: WebGLRenderTarget | null = null;
  private readonly size = new Vector2();

  capture(renderer: WebGLRenderer, scene: Scene, camera: Camera, batches: BatchedRenderer) {
    if (!cfxrNeedsSceneColor()) return;
    const size = renderer.getSize(this.size);
    const w = Math.max(1, Math.floor(size.x * renderer.getPixelRatio()));
    const h = Math.max(1, Math.floor(size.y * renderer.getPixelRatio()));
    if (!this.target || this.target.width !== w || this.target.height !== h) {
      this.target?.dispose();
      this.target = new WebGLRenderTarget(w, h, {
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        format: RGBAFormat,
      });
      this.target.depthTexture = new DepthTexture(w, h, UnsignedIntType);
    }
    const visible = batches.visible;
    const previousTarget = renderer.getRenderTarget();
    batches.visible = false;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);
    batches.visible = visible;
    const perspective = camera as Camera & { near?: number; far?: number };
    setCfxrSceneColorTexture(
      this.target.texture,
      this.target.depthTexture,
      w,
      h,
      perspective.near ?? 0.1,
      perspective.far ?? 1000,
    );
  }

  dispose() {
    this.target?.dispose();
    this.target = null;
    setCfxrSceneColorTexture(null, null);
  }
}
