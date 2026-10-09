// Deterministic RNG: mulberry32. Separate named streams so world/fx/audio never
// perturb the sim stream (docs/06 §1: determinism).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this._f = mulberry32(this.seed);
  }
  next() { return this._f(); }
  range(a, b) { return a + (b - a) * this._f(); }
  int(a, b) { return Math.floor(a + (b - a + 1) * this._f()); }
  sign() { return this._f() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this._f() * arr.length) % arr.length]; }
  /** Sample from a weighted table: [[value, weight], ...] */
  weighted(table) {
    let total = 0;
    for (const [, w] of table) total += w;
    let r = this._f() * total;
    for (const [v, w] of table) { r -= w; if (r <= 0) return v; }
    return table[table.length - 1][0];
  }
  /** Approx normal via sum of 3 uniforms, mapped through erf-ish. */
  gauss() { return (this._f() + this._f() + this._f() - 1.5) * 1.1547; }
}

/** The four streams used by the game (docs/06 §1). */
export function makeStreams(seed) {
  const s = seed >>> 0;
  return {
    sim: new Rng(s ^ 0x9e3779b9),
    world: new Rng(s ^ 0x85ebca6b),
    fx: new Rng(s ^ 0xc2b2ae35),
    audio: new Rng(s ^ 0x27d4eb2f),
  };
}

export function hash2(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
