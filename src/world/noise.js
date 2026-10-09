// Hand-rolled gradient noise (docs/03 §2). Zero-dependency rule (PLAN P4 /
// docs/06 §1) means we cannot pull FastNoiseLite, so this is a proper hashed
// gradient lattice, validated in debug/tests.js for range, smoothness and
// determinism. All noise is pure: same (x,y,seed) -> same value, always.

const PERM_SIZE = 512;

function buildPerm(seed) {
  // Deterministic Fisher-Yates over a byte permutation.
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(PERM_SIZE);
  for (let i = 0; i < PERM_SIZE; i++) perm[i] = p[i & 255];
  return perm;
}

const permCache = new Map();
function perm(seed) {
  let p = permCache.get(seed);
  if (!p) { p = buildPerm(seed); permCache.set(seed, p); }
  return p;
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }

const GRAD2 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
];

/** 2D Perlin-style gradient noise, output in [-1, 1]. */
export function noise2(x, y, seed = 0) {
  const P = perm(seed);
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const X = xi & 255, Y = yi & 255;
  const g = (ix, iy) => GRAD2[P[P[ix & 255] + (iy & 255)] & 7];
  const n00 = dotg(g(X, Y), xf, yf);
  const n10 = dotg(g(X + 1, Y), xf - 1, yf);
  const n01 = dotg(g(X, Y + 1), xf, yf - 1);
  const n11 = dotg(g(X + 1, Y + 1), xf - 1, yf - 1);
  const u = fade(xf), v = fade(yf);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.38; // normalize ~[-1,1]
}
function dotg(gv, x, y) { return gv[0] * x + gv[1] * y; }
function dot2(gx, gy, x, y) { return gx * x + gy * y; }

/** 3D gradient noise (used for micro-relief and block patterns), [-1, 1]. */
export function noise3(x, y, z, seed = 0) {
  const P = perm(seed ^ 0x5bd1e995);
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const g = (ix, iy, iz) => {
    const h = P[P[P[ix & 255] + (iy & 255)] + (iz & 255)] & 15;
    const G = GRAD3[h & 7];
    return (h & 8) ? [-G[0], -G[1], -G[2]] : G;
  };
  const d = (ix, iy, iz, dx, dy, dz) => { const G = g(ix, iy, iz); return G[0] * dx + G[1] * dy + G[2] * dz; };
  const X = xi & 255, Y = yi & 255, Z = zi & 255;
  const n000 = d(X, Y, Z, xf, yf, zf), n100 = d(X + 1, Y, Z, xf - 1, yf, zf);
  const n010 = d(X, Y + 1, Z, xf, yf - 1, zf), n110 = d(X + 1, Y + 1, Z, xf - 1, yf - 1, zf);
  const n001 = d(X, Y, Z + 1, xf, yf, zf - 1), n101 = d(X + 1, Y, Z + 1, xf - 1, yf, zf - 1);
  const n011 = d(X, Y + 1, Z + 1, xf, yf - 1, zf - 1), n111 = d(X + 1, Y + 1, Z + 1, xf - 1, yf - 1, zf - 1);
  const x00 = lerp(n000, n100, u), x10 = lerp(n010, n110, u);
  const x01 = lerp(n001, n101, u), x11 = lerp(n011, n111, u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 1.15;
}
const GRAD3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]];

/** Hash-based value noise, [-1, 1]. Cheaper than gradient noise; used for scatter. */
export function value2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (ix, iy) => {
    let n = (ix * 374761393 + iy * 668265263 + seed * 2246822519) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 2147483648 - 1; // [-1, 1)
  };
  const u = fade(xf), v = fade(yf);
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v);
}

/**
 * fBm with renormalization (procedural-gen skill: "adding octaves without
 * renormalizing pushes values out of range").
 * Returns 0..1.
 */
export function fbm2(x, y, { octaves = 4, lacunarity = 2.0, gain = 0.5, seed = 0, freq = 1 } = {}) {
  let total = 0, amp = 1, f = freq, norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += amp * noise2(x * f, y * f, seed + i * 1013);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return 0.5 + 0.5 * (total / norm);
}

/** Ridged multifractal: 1 - |n| -> sharp crests (docs/03 §2 `ridge`). 0..1 */
export function ridge2(x, y, { octaves = 4, lacunarity = 2.0, gain = 0.5, seed = 0, freq = 1 } = {}) {
  let total = 0, amp = 1, f = freq, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * f, y * f, seed + i * 7919));
    total += amp * n * n;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return total / norm;
}

/** Domain warp (docs/03 §2): noise sampled through noise. */
export function warp2(x, z, seed, amount = 12) {
  const wx = noise2(x * 0.01 + 31.7, z * 0.01 - 11.3, seed + 5087);
  const wz = noise2(x * 0.01 - 27.1, z * 0.01 + 19.9, seed + 9187);
  return [x + amount * wx, z + amount * wz];
}

/** Voronoi crackle (block-scale surface detail), 0..1 */
export function voronoi2(x, y, seed = 0, cells = 1) {
  const xi = Math.floor(x * cells), yi = Math.floor(y * cells);
  let best = 1e9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox, cy = yi + oy;
      const h1 = hash01(cx, cy, seed), h2 = hash01(cx, cy, seed ^ 0x9e3779b9);
      const px = cx + h1, py = cy + h2;
      const d = (px - x * cells) ** 2 + (py - y * cells) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

export function hash01(x, y, seed) {
  let n = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

export function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
