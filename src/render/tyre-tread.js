// The rubber's own skin: a procedural block tread for the tyre, so a wheel reads as a
// tyre with lugs instead of as a drum (queue P12).
//
// Before this module the tyre shader patch (src/render/carMesh.js `attachTyreDirt`)
// only ever wrote `diffuseColor` and `roughnessFactor` - it never touched `normal`, and
// the dirt mask was built from a plain value-noise spatter. A caked tyre therefore had
// no shape at all: the whole wheel came out as one brown cylinder whose only detail was
// a colour smear, and the tread was invisible at every distance, exactly where a rally
// car spends its frame time looking at its own wheels.
//
// The pattern is a function of the wheel's OWN coordinates (angle around the rolling
// axis + axial position), so it spins with the wheel for free and needs no extra
// geometry: 0 added triangles, ~3 cheap evaluations per tyre fragment.
//
// THREE-free on purpose, like render/road-skin.js and render/car-asset.js: the shipped
// numbers and the shape of the field have to be assertable headless, and a constant
// that lives only inside a GLSL string is not. The GLSL below is generated FROM this
// table, and treadCell()/treadReliefAmp() below are the node-side mirror of it, so
// src/debug/tests.js (T46) measures the same field the shader compiles.

export const TYRE_TREAD = {
  // Pitch, in metres of tyre surface.
  lugPitch: 0.058,        // lateral groove every 58 mm -> 36 lugs around a 0.335 m tyre
  blocks: 4,              // columns of blocks across the tread width
  groove: 0.18,           // groove half-width as a fraction of the pitch (21 mm wide)
  feather: 0.16,          // how fast a groove wall rises to the lug crest (fraction)
  centreRib: 0.45,        // cut share at the tyre centre: 0 = rib never breaks, 1 = full block
  shoulderAt: 0.42,       // |axial| / halfW where the shoulder blocks start (staggered)
  shoulderRamp: 0.50,     // ...and where the tread is gone (the sidewall is smooth rubber)
  crownStart: 0.62,       // rr (radius / tyre radius) where the lugs start: no tread on the rim
  crownRamp: 0.26,        // ...and where they reach full height
  stagger: true,          // shoulder columns offset by half a pitch (a directional tread)

  // Relief: the pattern is used as a height field, and its gradient tilts the normal.
  depth: 0.008,           // m of lug depth = the amplitude; 8 mm, a real off-road lug
  maxTilt: 1.15,          // cap on |dn| (~49 deg) so a groove wall can never flip the normal
  fd: 0.10,               // finite-difference step, in pattern units (10 % of a pitch)
  cakedKeep: 0.62,        // relief left under a fully caked tyre: crust rounds, it does not erase
  wetSmooth: 0.25,        // water rounds the block edges (a wet tyre glints, it does not read blocks)
  grooveDirt: 0.35,       // grooves keep darker, damper mud than the worn block tops
};

/**
 * Uniform values for one wheel mesh. `halfW` is half the tyre width along the rolling
 * axis, `rMax` the tyre radius, both measured off the exported geometry in metres.
 * Everything the shader needs is derived here so the GLSL never does unit maths.
 */
export function treadPlan(halfW, rMax, T = TYRE_TREAD) {
  const w = Math.max(1e-3, halfW);
  const r = Math.max(1e-3, rMax);
  const pitchRad = T.lugPitch / r;                 // rad between lateral grooves
  const pitchAx = (2 * w) / Math.max(1, T.blocks); // m between circumferential grooves
  return {
    pitchRad, pitchAx, rMax: r, halfW: w, blocks: Math.max(1, T.blocks),
    lugCount: Math.round((2 * Math.PI * r) / T.lugPitch),
    // uTyreTread: bands per radian, columns per metre, stagger threshold in c units,
    //             groove half-width
    tread: [1 / pitchRad, 1 / pitchAx, T.shoulderAt * Math.max(1, T.blocks) * 0.5, T.groove],
    // uTyreCrown: rr start, rr end, side start, side end
    crown: [T.crownStart, T.crownStart + T.crownRamp, T.shoulderAt, T.shoulderAt + T.shoulderRamp],
    // uTyreRelief: lug depth (m), tilt cap, caked keep, wet smoothing
    relief: [T.depth, T.maxTilt, T.cakedKeep, T.wetSmooth],
    rib: T.centreRib,                              // uTyreRib
    groove: T.grooveDirt,                          // uTyreGroove
  };
}

const frac01 = (x) => x - Math.floor(x);
/** Distance to the nearest groove centre, in pattern units (0 in the groove, 0.5 on a lug). */
const grooveDist = (f) => Math.min(frac01(f), 1 - frac01(f));
function smoothstep01(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Tread height at pattern coordinates `b` (bands around the circumference) and `c`
 * (columns across the width), 0 in a groove and 1 on a block top. `crown` masks the
 * rim and the sidewall, `side` is |axial| / halfW. Mirror of tyreTreadCell() below.
 */
export function treadCell(b, c, crown, side, plan, T = TYRE_TREAD) {
  if (crown <= 0) return 0;
  const u = plan.tread;
  const stagger = T.stagger && Math.abs(c) >= u[2] ? 0.5 : 0;
  const lugB = smoothstep01(u[3], u[3] + T.feather, grooveDist(b + stagger));
  const cut = T.centreRib + (1 - T.centreRib) * Math.max(0, Math.min(1, side));
  const lugC = 1 - cut * (1 - smoothstep01(u[3], u[3] + T.feather, grooveDist(c + 0.5)));
  return crown * lugB * lugC;
}

/** Crown mask of the tread band: 0 on the rim and on the smooth sidewall, 1 on the tread. */
export function treadCrown(rr, side, plan) {
  const q = plan.crown;
  return smoothstep01(q[0], q[1], rr) * (1 - smoothstep01(q[2], q[3], Math.abs(side)));
}

/**
 * How much of the lug depth survives: crust rounds the blocks over without erasing them
 * (P12 is precisely the case where the relief used to be zero), and water smooths the
 * edges further. Mirror of the amp term in the shader.
 */
export function treadReliefAmp(caked, wet, plan, T = TYRE_TREAD) {
  const keep = 1 - (1 - plan.relief[2]) * Math.max(0, Math.min(1, caked));
  const damp = 1 - T.wetSmooth * Math.max(0, Math.min(1, wet));
  return plan.relief[0] * keep * damp;
}

/**
 * The tilt the shader will apply, in the same units the GLSL computes it: forward
 * differences of the height field, mapped from pattern units to metres of tyre surface
 * (bands per radian / tyre radius around the circumference, columns per metre across),
 * scaled by the surviving lug depth and capped by the tilt ceiling.
 */
export function treadNormalTilt(ang, ax, rr, side, plan, caked = 0, wet = 0) {
  const T = TYRE_TREAD, e = T.fd;
  const crown = treadCrown(rr, side, plan);
  const h0 = treadCell(ang * plan.tread[0], ax * plan.tread[1], crown, side, plan);
  const dhb = (treadCell(ang * plan.tread[0] + e, ax * plan.tread[1], crown, side, plan) - h0) / e;
  const dhc = (treadCell(ang * plan.tread[0], ax * plan.tread[1] + e, crown, side, plan) - h0) / e;
  const gb = dhb * plan.tread[0] / Math.max(1e-3, plan.rMax);
  const gc = dhc * plan.tread[1];
  const amp = treadReliefAmp(caked, wet, plan) * crown;
  const raw = Math.hypot(gb, gc) * amp;
  const cap = plan.relief[1];
  return { h: h0, crown, tilt: Math.min(raw, cap), raw, amp, gb, gc };
}

/** GLSL helpers, generated from the table so the shader and the suite share one source. */
export const TYRE_TREAD_GLSL = `
// Block tread as a height field in the wheel's own coordinates (src/render/tyre-tread.js).
uniform vec4 uTyreTread;   // bands/rad, columns/m, stagger c-threshold, groove half-width
uniform vec4 uTyreCrown;   // rr start, rr end, side start, side end
uniform vec4 uTyreRelief;  // lug depth m, tilt cap, caked keep, wet smoothing
uniform float uTyreRib;    // centre-rib cut share
uniform float uTyreGroove; // how much darker/damper the grooves stay
float tyreTreadCell(float b, float c, float crown, float side) {
  float stagger = ${TYRE_TREAD.stagger ? '0.5 * step(uTyreTread.z, abs(c))' : '0.0'};
  float db = min(fract(b + stagger), 1.0 - fract(b + stagger));
  float lugB = smoothstep(uTyreTread.w, uTyreTread.w + ${TYRE_TREAD.feather}, db);
  float dc = min(fract(c + 0.5), 1.0 - fract(c + 0.5));
  float cut = mix(uTyreRib, 1.0, clamp(side, 0.0, 1.0));
  float lugC = 1.0 - cut * (1.0 - smoothstep(uTyreTread.w, uTyreTread.w + ${TYRE_TREAD.feather}, dc));
  return crown * lugB * lugC;
}
float tyreCrown(float rr, float side) {
  return smoothstep(uTyreCrown.x, uTyreCrown.y, rr)
       * (1.0 - smoothstep(uTyreCrown.z, uTyreCrown.w, side));
}
`;
