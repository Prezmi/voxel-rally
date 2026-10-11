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

/** Pass list for one config — the graph composer.js really draws, and what T32
 *  asserts per quality preset. POST off -> zero composer passes: the renderer keeps
 *  the plain direct-to-canvas path it had before the post stack existed.
 *  Offscreen quads are capped at 4 (brightQ + blurQ [+ brightE + blurE]); the
 *  composite is the single pass that writes the canvas. */
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
