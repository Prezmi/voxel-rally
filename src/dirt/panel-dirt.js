// PANEL DIRT — the 16 scalar panels of docs/04 §4.2 (A).
// This is the cheap layer: it decides *where* the car gets dirty, it drives the
// washing logic and it is what the acceptance tool reads headless (no GPU).
// The visual layer (dirtMap + shader) only renders what is in these arrays.
//
// Layout rule (docs/06 §1 "pule obiektów wszędzie tam, gdzie coś się tworzy w
// klatce"): one static typed-array graph, created once, written in place.
// Nothing here allocates after construction.

// Panel order is normative: render/carMesh.js bakes one panel index per vertex
// and reads one texel of the 16x1 state texture with that index.
export const PANELS = [
  { key: 'hood', name: 'MASKA', flow: [-1.00, -0.10, 0.00] },
  { key: 'roof', name: 'DACH', flow: [-1.00, -0.06, 0.00] },
  { key: 'screenF', name: 'SZYBA PRZEDNIA', flow: [-0.40, -1.00, 0.00] },
  { key: 'screenR', name: 'SZYBA TYLNA', flow: [-1.00, -0.50, 0.00] },
  { key: 'sillL', name: 'PRÓG L', flow: [-1.00, 0.02, 0.00] },
  { key: 'sillR', name: 'PRÓG P', flow: [-1.00, 0.02, 0.00] },
  { key: 'flankL', name: 'BOK L', flow: [-1.00, -0.18, 0.00] },
  { key: 'flankR', name: 'BOK P', flow: [-1.00, -0.18, 0.00] },
  { key: 'archFL', name: 'NADKOLE P·L', flow: [-1.00, -0.40, 0.00] },
  { key: 'archFR', name: 'NADKOLE P·P', flow: [-1.00, -0.40, 0.00] },
  { key: 'archRL', name: 'NADKOLE T·L', flow: [-1.00, -0.40, 0.00] },
  { key: 'archRR', name: 'NADKOLE T·P', flow: [-1.00, -0.40, 0.00] },
  { key: 'rear', name: 'TYŁ', flow: [-1.00, -0.20, 0.00] },
  { key: 'front', name: 'PRZÓD', flow: [-1.00, -0.10, 0.00] },
  { key: 'under', name: 'SPÓD', flow: [-1.00, 0.00, 0.00] },
  { key: 'wing', name: 'SKRZYDŁO', flow: [-1.00, -0.10, 0.00] },
];

export const PANEL_COUNT = PANELS.length; // 16 (docs/04 §4.2)
export const DRY_BASE = 3.0; // 1/s baseline when a panel has never been dirtied

const P = {};
for (let i = 0; i < PANELS.length; i++) P[PANELS[i].key] = i;
export const PANEL_INDEX = P;

/**
 * Panel boxes in car-local space (X forward, Y up, Z right — same frame as the
 * body geometry in render/carMesh.js). Built once per car from `params.hull`
 * and the wheel mounts, then used to bake one panel index per vertex.
 * Returns a Float32Array of 16 * 6: cx,cy,cz,hx,hy,hz.
 */
export function panelBoxes(params) {
  const h = params.hull;
  const wb = params.wheelbase / 2;
  const tf = params.trackFront / 2;
  const tr = params.trackRear / 2;
  const out = new Float32Array(PANEL_COUNT * 6);
  const put = (key, cx, cy, cz, hx, hy, hz) => {
    const i = PANEL_INDEX[key];
    out[i * 6] = cx; out[i * 6 + 1] = cy; out[i * 6 + 2] = cz;
    out[i * 6 + 3] = hx; out[i * 6 + 4] = hy; out[i * 6 + 5] = hz;
  };

  put('hood', h.x * 0.60, h.cy + 0.30, 0, h.x * 0.42, 0.14, h.z * 0.92);
  put('roof', -0.14, h.cy + 0.72, 0, 0.80, 0.10, h.z - 0.16);
  put('screenF', 0.55, h.cy + 0.50, 0, 0.36, 0.24, h.z - 0.22);
  put('screenR', -0.78, h.cy + 0.50, 0, 0.34, 0.24, h.z - 0.24);
  put('sillL', 0, h.cy - 0.26, h.z - 0.02, h.x - 0.5, 0.10, 0.10);
  put('sillR', 0, h.cy - 0.26, -(h.z - 0.02), h.x - 0.5, 0.10, 0.10);
  put('flankL', -0.10, h.cy + 0.04, h.z - 0.03, h.x - 0.75, 0.28, 0.10);
  put('flankR', -0.10, h.cy + 0.04, -(h.z - 0.03), h.x - 0.75, 0.28, 0.10);
  put('archFL', wb, h.cy + 0.02, tf, 0.46, 0.34, 0.24);
  put('archFR', wb, h.cy + 0.02, -tf, 0.46, 0.34, 0.24);
  put('archRL', -wb, h.cy + 0.02, tr, 0.46, 0.34, 0.24);
  put('archRR', -wb, h.cy + 0.02, -tr, 0.46, 0.34, 0.24);
  put('rear', -(h.x - 0.08), h.cy - 0.02, 0, 0.16, 0.34, h.z);
  put('front', h.x - 0.06, h.cy - 0.04, 0, 0.16, 0.34, h.z);
  put('under', 0, h.cy - 0.34, 0, h.x - 0.35, 0.10, h.z - 0.10);
  put('wing', -(h.x - 0.16), h.cy + 0.74, 0, 0.22, 0.10, h.z - 0.02);
  return out;
}

/** Nearest panel box for a car-local point; used to bake the vertex attribute. */
export function classifyPanel(x, y, z, boxes) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < PANEL_COUNT; i++) {
    const k = i * 6;
    const dx = Math.abs(x - boxes[k]) / boxes[k + 3];
    const dy = Math.abs(y - boxes[k + 1]) / boxes[k + 4];
    const dz = Math.abs(z - boxes[k + 2]) / boxes[k + 5];
    const d = Math.max(dx, Math.max(dy, dz)); // < 1 inside the box
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * One static graph of dirt state (docs/04 §4.2):
 *  thick  — mud plate 0..1 (map channel `r`)
 *  wet    — moisture 0..1  (channel `g`)
 *  dust   — dry loose film 0..1 (channel `a`)
 *  streak — length/strength of the running streaks (docs "smugi")
 *  cr/cg/cb — current tone, weighted mean of everything deposited on the panel
 *  dry    — drying rate 1/s, weighted mean of the contributing surfaces
 *  rubber — per-tyre rubber film; survives washing (docs/04 §4.2 "kanał gumy")
 */
export class PanelDirt {
  constructor() {
    this.count = PANEL_COUNT;
    this.thick = new Float32Array(PANEL_COUNT);
    this.wet = new Float32Array(PANEL_COUNT);
    this.dust = new Float32Array(PANEL_COUNT);
    this.streak = new Float32Array(PANEL_COUNT);
    this.cr = new Float32Array(PANEL_COUNT);
    this.cg = new Float32Array(PANEL_COUNT);
    this.cb = new Float32Array(PANEL_COUNT);
    this.dry = new Float32Array(PANEL_COUNT).fill(DRY_BASE);
    this.fl = new Float32Array(PANEL_COUNT).fill(1);   // fling resistance per panel
    this.rubber = new Float32Array(4);                 // per wheel, order FL FR RL RR
    this.rubberR = 0.10; this.rubberG = 0.10; this.rubberB = 0.11;
    this.baseR = 1; this.baseG = 1; this.baseB = 1;    // panel tint the wash restores
    // bookkeeping for the HUD / tests (plain numbers, no allocation)
    this.deposited = 0; this.flung = 0; this.dried = 0; this.washed = 0;
  }

  /** Weighted 0..1 "how dirty is this panel" — used by the acceptance metrics. */
  load(i) {
    return this.thick[i] + 0.55 * this.dust[i] + 0.30 * this.wet[i];
  }

  /** Total dirt over the whole car (same weighting). */
  totalLoad() {
    let s = 0;
    for (let i = 0; i < PANEL_COUNT; i++) s += this.load(i);
    return s;
  }

  /**
   * Deposit onto one panel. Colour is a running weighted mean so a panel that
   * got gravel dust and then mud spray shows the mix, not the last writer.
   * Called from the substep loop: must stay allocation-free.
   */
  deposit(i, thick, wet, dust, r, g, b, dryRate, streakGain, fling) {
    const add = thick + wet + dust;
    if (add <= 1e-6) return 0;
    const prev = this.load(i);
    this.thick[i] = Math.min(1, this.thick[i] + thick);
    this.wet[i] = Math.min(1, this.wet[i] + wet);
    this.dust[i] = Math.min(1, this.dust[i] + dust);
    const now = prev + add;
    const k = add / now;
    this.cr[i] += (r - this.cr[i]) * k;
    this.cg[i] += (g - this.cg[i]) * k;
    this.cb[i] += (b - this.cb[i]) * k;
    this.dry[i] += (dryRate - this.dry[i]) * k;
    this.fl[i] += (fling - this.fl[i]) * k;
    this.streak[i] = Math.min(1, this.streak[i] + streakGain);
    this.deposited += add;
    return add;
  }

  /** Add worn rubber to a tyre; this channel is deliberately wash-resistant. */
  addRubber(wheel, amount, r, g, b) {
    const prev = this.rubber[wheel];
    const next = Math.min(1, prev + amount);
    if (next <= prev) return;
    const k = (next - prev) / next;
    this.rubberR += (r - this.rubberR) * k;
    this.rubberG += (g - this.rubberG) * k;
    this.rubberB += (b - this.rubberB) * k;
    this.rubber[wheel] = next;
  }

  /**
   * Evolution (docs/04 §4.2 "ewolucja w czasie"), written frame-rate independent
   * with exponentials instead of the doc's per-0.25 s tick.
   * env: {speed, vibration, rain, wind}
   */
  evolve(dt, env) {
    const speed = env.speed;
    // Fling: docs "grubość *= (1 - flingRate(speed, vibration))", at 140 km/h the
    // airflow strips dirt off. Airflow, not grip: wet mud sticks longer.
    const flingBase = (0.010 + 0.115 * (speed / 40) * (speed / 40) + 0.11 * env.vibration) * dt;
    const airFlow = (env.wind + speed * 0.35) * dt;
    const rain = env.rain;
    for (let i = 0; i < PANEL_COUNT; i++) {
      const before = this.thick[i] + this.wet[i] + this.dust[i];

      // Moisture: dries with airflow; rain adds it back.
      if (this.wet[i] > 0) {
        const w0 = this.wet[i];
        this.wet[i] = Math.max(0, w0 * Math.exp(-dt * (this.dry[i] * 0.45 + airFlow * 0.10)) - rain * -0);
        this.dried += w0 - this.wet[i];
      }

      // Thickness: stripped by airflow, then plates heavier than 0.85 slough off
      // in chunks (a thick plate does not evaporate, it falls off).
      const f = flingBase * this.fl[i] * (1 - 0.45 * this.wet[i]);
      if (f > 0 && this.thick[i] > 0) {
        const t0 = this.thick[i];
        this.thick[i] *= Math.exp(-f);
        this.flung += t0 - this.thick[i];
      }
      if (this.thick[i] > 0.85) {
        const over = (this.thick[i] - 0.85) * Math.min(1, dt * 2.4);
        this.thick[i] -= over;
        this.flung += over;
      }

      // Streaks (docs "smugi") only grow while there is moisture and speed; a dry
      // panel keeps a faded version of its streaks.
      const want = Math.min(1, this.wet[i] * 1.2 + this.thick[i] * 0.6) * Math.min(1, speed / 14);
      this.streak[i] += (want - this.streak[i]) * Math.min(1, dt * (0.35 + 1.6 * (this.wet[i] > 0 ? 1 : 0)));
      if (this.streak[i] < 0) this.streak[i] = 0;

      // Rain washes the car while driving (docs §6 "deszcz" layer).
      if (rain > 0) {
        const w = rain * dt * (0.22 + 0.012 * speed);
        this.thick[i] = Math.max(0, this.thick[i] - w * this.thick[i]);
        this.dust[i] = Math.max(0, this.dust[i] - w * 1.6 * this.dust[i]);
        this.washed += w;
      }

      // Dry dirt powders off the paint instead of staying a solid film.
      if (this.dust[i] > 0 && this.wet[i] < 0.15) {
        this.dust[i] = Math.max(0, this.dust[i] * Math.exp(-dt * 0.06 * this.fl[i]));
      }

      // Tone relaxes back to the paint when a panel has been cleaned off.
      const after = this.thick[i] + this.wet[i] + this.dust[i];
      if (after < 1e-3) {
        this.cr[i] = this.baseR; this.cg[i] = this.baseG; this.cb[i] = this.baseB;
        this.streak[i] = 0;
      }
      if (before === 0 && after === 0) this.streak[i] = 0;
    }
  }

  reset() {
    this.thick.fill(0); this.wet.fill(0); this.dust.fill(0); this.streak.fill(0);
    this.dry.fill(DRY_BASE); this.fl.fill(1);
    this.rubber.fill(0);
    this.deposited = 0; this.flung = 0; this.dried = 0; this.washed = 0;
  }

  /** Compact one-line summary for the HUD / acceptance tool (12 Hz use only). */
  summary() {
    let s = '';
    for (let i = 0; i < PANEL_COUNT; i++) {
      const l = this.load(i);
      if (l < 0.04) continue;
      s += `${PANELS[i].name} ${(l * 100).toFixed(0)}% `;
    }
    return s || 'CZYSTE';
  }
}
