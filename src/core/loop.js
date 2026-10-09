import { DT, TimeState } from './time.js';

/**
 * Fixed-step driver with render interpolation (docs/06 §3).
 * Works headless (Node) as well as in the browser: the caller supplies
 * stepSim(dt) and render(alpha); nothing here touches the DOM.
 */
export class FrameLoop {
  constructor({ stepSim, render, onFrame }) {
    this.stepSim = stepSim;
    this.render = render;
    this.onFrame = onFrame || null;
    this.time = new TimeState();
    this.simMs = 0;
    this.renderMs = 0;
    this.fps = 0;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this._running = false;
  }

  /** One frame. `nowMs` = performance.now() (or any monotonic ms clock). */
  frame(nowMs) {
    const t0 = nowMs;
    const n = this.time.begin(nowMs);
    const s0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (let i = 0; i < n; i++) this.stepSim(DT);
    const s1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.simMs = this.simMs * 0.9 + (s1 - s0) * 0.1;

    const r0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.render(this.time.alpha);
    const r1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.renderMs = this.renderMs * 0.9 + (r1 - r0) * 0.1;

    this._fpsFrames++;
    this._fpsAcc += Math.max(0, nowMs - t0);
    if (this._fpsFrames >= 30) { this.fps = 1000 / (this._fpsAcc / this._fpsFrames); this._fpsFrames = 0; this._fpsAcc = 0; }

    if (this.onFrame) this.onFrame(this);
  }

  /** Attach to a renderer's animation loop (threejs-scene-setup pattern 3). */
  attach(setAnimationLoop) {
    this._running = true;
    setAnimationLoop((now) => { if (this._running) this.frame(now); });
  }
  stop(setAnimationLoop) { this._running = false; setAnimationLoop(null); }
}
