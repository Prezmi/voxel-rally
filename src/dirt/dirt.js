// DIRT SYSTEM — one façade over panel dirt, the world spray map, the emitters,
// the evolution and the lens (docs/06 §2 dirt/). main.js calls exactly two
// methods: step() in the fixed sim step and frame() in the render pass.
//
// Budget (docs/07 "budżety techniczne"): the whole system must stay under 1.2 ms
// per frame. It is measured every frame into stats.msMean / stats.msP95 so the HUD
// shows it and tools/dirtmask.mjs asserts on it.
import { PanelDirt } from './panel-dirt.js';
import { DirtMap } from './dirt-map.js';
import { emitAll, makeScratch } from './emitters.js';
import { wash, rainWash } from './wash.js';
import { LensDirt } from './lens.js';

export class DirtSystem {
  constructor() {
    this.panels = new PanelDirt();
    this.map = new DirtMap();
    this.lens = new LensDirt();
    this.scratch = makeScratch();
    // Stage conditions (docs/07 F6 will fill these in; the dirt reads them now).
    this.env = { wet: 0, rain: 0, wind: 3.0, temp: 12, sprayR: 0.55, sprayG: 0.5, sprayB: 0.42 };
    this.scratch.wet = 0;
    this.stats = { msMean: 0, msP95: 0, msMax: 0, splats: 0, emission: 0, samples: 0 };
    this._hist = new Float32Array(128);
    this._histN = 0;
    this._vib = 0;
  }

  /** Fixed-step part: emission + evolution. `dt` is DT (1/120). */
  step(car, dt) {
    const t0 = performance.now();
    const b = car.body;
    this.map.follow(b.pos.x, b.pos.z);
    this.map.addBudget(dt * 1000);

    // Vibration feeds the fling rate: a car being hammered by the terrain shakes
    // its dirt off (docs/04 "flingRate(speed, vibration)").
    let vib = 0;
    for (let i = 0; i < car.wheels.length; i++) {
      const w = car.wheels[i];
      vib += Math.min(1, Math.abs(w.suspVel) * 0.9) + (w.edgeStep > 0.08 ? 0.25 : 0);
    }
    vib = vib / car.wheels.length;
    this._vib += (vib - this._vib) * Math.min(1, dt * 6);

    this.scratch.wet = this.env.wet;
    const emission = emitAll(this.panels, this.map, car, dt, this.scratch, this.env);

    this.env.vibration = this._vib;
    this.env.speed = b.groundSpeed;
    this.panels.evolve(dt, this.env);
    rainWash(this.panels, dt, this.env.rain, b.groundSpeed);
    this.map.tick(dt, b.groundSpeed);

    // The lens is a render-side thing, but its state must be driven by the sim
    // clock so the look is identical at 30 and at 144 fps (docs/06 §3).
    this.lens.update(dt, emission, b.groundSpeed, this.env.rain, this.panels.load(2));

    const ms = performance.now() - t0;
    const s = this.stats;
    s.msMean = s.msMean ? s.msMean * 0.9 + ms * 0.1 : ms;
    if (ms > s.msMax) s.msMax = ms;
    this._hist[this._histN++ & 127] = ms;
    if (this._histN >= 300 && s.msP95 === 0) s.msP95 = this.p95();
    s.emission = emission;
    return emission;
  }

  p95() {
    const n = Math.min(128, this._histN);
    if (!n) return 0;
    const a = this._hist.slice(0, n).sort((x, y) => x - y);
    return a[Math.min(n - 1, Math.floor(n * 0.95))];
  }

  /** Render-side: textures/uniforms are pushed by render/carMesh.js from here. */
  frame(car) {
    this.map.follow(car.body.pos.x, car.body.pos.z);
    this.stats.splats = this.map.beginFrame();
  }

  washFull(strength = 1) { wash(this.panels, this.map, strength); }
  washPartial() { wash(this.panels, null, 0.45); }
  wipeLens() { this.lens.sweep(); }
  rain(v) { this.env.rain = v; this.env.wet = Math.max(this.env.wet, v * 0.6); }

  summary() {
    return `brud ${this.panels.summary()} | obiektyw ${(this.lens.severity() * 100).toFixed(0)}%`;
  }
}
