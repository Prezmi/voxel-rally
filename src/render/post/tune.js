// The post stack's data half: no THREE import, so it is headless-testable
// (node src/debug/tests.js) while composer.js keeps the GPU side.
export const BLOOM_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];

/** The one dial table for the whole stack (bloom + tone + grade). Everything here is
 *  a plain finite number inside the ranges tests.js pins (T33) — nothing else in the
 *  renderer carries a bloom/grade constant, so the look is dialled from one place. */
export const POST_TUNE = {
  exposure: 1.34,              // AgX sits darker/softer than ACES at the same key light
  bloom: {
    LOW: { threshold: 1.05, knee: 0.45, intensity: 0.30, radius: 1.00, taps: 3, sigma: 1.10, mips: 1 },
    MEDIUM: { threshold: 0.95, knee: 0.55, intensity: 0.58, radius: 1.35, taps: 5, sigma: 1.30, mips: 2 },
    HIGH: { threshold: 0.88, knee: 0.60, intensity: 0.74, radius: 1.70, taps: 7, sigma: 1.55, mips: 2 },
  },
  grade: {
    contrast: 0.30,            // gentle S curve about the mid grey (band width 1.15)
    shadowLift: 0.062,         // the shadow side never crushes to black
    warmHi: [1.075, 1.005, 0.885], coolSh: [0.855, 0.940, 1.110],
    warmAmt: 0.60, coolAmt: 0.40,
    satGreen: 0.24, satBrown: 0.12,
    vignette: 0.22, grain: 0.014, grainSpeed: 20.0,
  },
};

/** Clamp + sanitise a dial read from settings/save: a stale payload can never put a
 *  NaN, a negative tap count or a 40x bloom on the GPU. */
export function clampNum(v, lo, hi, fb) {
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : fb;
}

/** Offscreen quads are capped at 5 (brightQ + blurQ [+ brightE + blurE] + shafts);
 *  the composite is the single pass that writes the canvas. Total ceiling 6 — pinned
 *  by T40, and the whole atmosphere layer (shafts / lens / radial blur) never adds a
 *  pass of its own beyond that one shaft quad. */
export const MAX_POST_PASSES = 6;
export const MAX_OFFSCREEN_PASSES = 5;

// ------------------------------------------------------------ rally atmosphere
// The look half of the speed/feel layer: fake sun shafts, sun-keyed dirty lens and
// the edge radial blur. Kept OUT of POST_TUNE so the bloom/grade dial table stays
// exactly as T33 pins it; this table is pinned by T40 instead. Every entry is a
// plain finite number inside its pinned range, and every one is read through a
// clampNum'd helper, so a garbage dial can never reach the GPU.
export const ATMO_TUNE = {
  shafts: {
    samples: 6,          // radial march taps per pixel, eighth-res only
    decay: 0.72,         // per-sample falloff along the streak
    density: 0.90,       // procedural-noise frequency along the ray (canopy leak)
    drift: 0.35,         // noise scroll rate, rad/s — wind moving through the trees
    intensity: 0.55,     // ceiling on the additive alpha (sun dead centre, in frame)
    contrast: 0.60,      // how hard the noise modulates the shaft (0 = flat wash)
    spread: 0.55,        // fraction of the frame the streak marches across
    falloff: 1.35,       // exp falloff of the streak with distance from the sun
    edgeFade: 0.35,      // uv padding past the frame edge the sun still leaks from
  },
  lens: {
    blobs: 5,            // procedural smudge blobs (no texture, generated in-shader)
    ghosts: 3,           // flare ghosts along the sun -> centre axis
    smudge: 0.30,        // veiling haze weight (driven by settings.lensDirt)
    flare: 0.34,         // ghost disc weight
    halo: 0.12,          // soft halo around the sun
    spread: 0.30,        // ghost spacing along the axis, in uv
    edgeFade: 0.35,      // same pad as the shafts: near-frame sun still lights it
  },
  blur: {
    maxStrength: 0.055,  // uv units of smear AT the frame edge — capped by hand
    speedFull: 62,       // m/s at which the blur reaches its cap
    inner: 0.18,         // rr below this stays perfectly sharp (car + road centre)
    outer: 0.62,         // rr at which the smear is at full strength
    taps: 4,             // radial taps inside the composite
  },
};

/** Sun-in-frame visibility 0..1 for the shafts and the lens. Zero when the sun is
 *  behind the camera or outside the padded frame, so both are exactly 0 (never a
 *  faint residue) whenever the sun is out of frame. */
export function sunVisibility(ndcX, ndcY, inFront, edgeFade = ATMO_TUNE.shafts.edgeFade) {
  if (!inFront || !Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return 0;
  const pad = clampNum(edgeFade, 0.05, 1.0, ATMO_TUNE.shafts.edgeFade);
  const e = Math.max(Math.abs(ndcX), Math.abs(ndcY));   // 1 = on the frame edge
  if (e >= 1 + pad) return 0;
  return clampNum(1 - Math.max(0, e - 1) / pad, 0, 1, 0);
}

/** Additive shaft strength. 0 with POST off, 0 when the sun is out of frame. */
export function shaftAlpha(cfg = {}) {
  if (!cfg.post) return 0;
  const t = ATMO_TUNE.shafts;
  const vis = clampNum(cfg.sunVis, 0, 1, 0);
  if (vis <= 0) return 0;
  const sun = clampNum(cfg.sun, 0, 1, 1);
  const lvl = BLOOM_LEVELS.includes(cfg.bloom) ? cfg.bloom : 'MEDIUM';
  // LOW pays for the cheapest row, so the shaft rides the bloom row too.
  const rowMul = lvl === 'LOW' ? 0.65 : (lvl === 'HIGH' ? 1.0 : 0.85);
  return clampNum(t.intensity * vis * sun * rowMul, 0, t.intensity, 0);
}

/** Sun-keyed dirty-lens strength (settings.lensDirt is the player dial on top).
 *  Exactly 0 when the sun is out of frame or the dial is at 0. */
export function lensFlareAlpha(cfg = {}) {
  if (!cfg.post) return 0;
  const vis = clampNum(cfg.sunVis, 0, 1, 0);
  const dirt = clampNum(cfg.lensDirt, 0, 1, 0);
  if (vis <= 0 || dirt <= 0) return 0;
  return clampNum(vis * dirt, 0, 1, 0);
}

/** Edge radial-blur strength from ground speed. Exactly 0 at a standstill, capped
 *  at ATMO_TUNE.blur.maxStrength, and the shader ramps it in only outside the
 *  sharp centre disc, so the car and the road centre never smear. */
export function radialBlurAmount(cfg = {}) {
  if (!cfg.post) return 0;
  const t = ATMO_TUNE.blur;
  const spd = clampNum(cfg.speed, 0, 200, 0);
  if (spd <= 0) return 0;
  const full = clampNum(t.speedFull, 1, 200, 62);
  const gain = clampNum(cfg.gain, 0, 1, 1);
  return clampNum(t.maxStrength * Math.min(1, spd / full) * gain, 0, t.maxStrength, 0);
}

/** Pass list for one config — the graph composer.js really draws, and what T32
 *  asserts per quality preset. POST off -> zero composer passes: the renderer keeps
 *  the plain direct-to-canvas path it had before the post stack existed. */
export function passGraph(cfg = {}) {
  if (!cfg.post) return [];
  const level = BLOOM_LEVELS.includes(cfg.bloom) ? cfg.bloom : 'MEDIUM';
  const b = POST_TUNE.bloom[level];
  const passes = [
    { name: 'brightQ', kind: 'bright', res: 'quarter' },   // threshold + H gaussian
    { name: 'blurQ', kind: 'blurV', res: 'quarter' },      // V gaussian, quarter mip
  ];
  if (b.mips >= 2) {
    passes.push({ name: 'brightE', kind: 'bright', res: 'eighth' });
    passes.push({ name: 'blurE', kind: 'blurV', res: 'eighth' });
  }
  // One extra quad, eighth res: the sun-shaft radial streak. The dirty lens and the
  // edge radial blur are folded into the composite, so they cost no pass at all.
  if (cfg.shafts === true) passes.push({ name: 'shafts', kind: 'shafts', res: 'eighth' });
  passes.push({ name: 'composite', kind: 'composite', res: 'canvas' });
  return passes;
}

/** Tone mode of record: AgX when the vendored three exports it (r169 does), ACES
 *  otherwise. Takes the THREE namespace so the decision itself is testable. */
export function resolveToneMode(THREE_LIKE) {
  const hasAgx = !!(THREE_LIKE && typeof THREE_LIKE.AgXToneMapping === 'number' && THREE_LIKE.AgXToneMapping > 0);
  return hasAgx
    ? { mode: THREE_LIKE.AgXToneMapping, name: 'AgX' }
    : { mode: THREE_LIKE ? THREE_LIKE.ACESFilmicToneMapping : 0, name: 'ACESFilmic' };
}
