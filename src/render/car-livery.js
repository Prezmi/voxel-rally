// Livery generated in code (PLAN §10.2 "Auto z numerem i barwami zespołu"):
// one 128x128 nearest-neighbour canvas per car id, baked once at boot, no assets.
//
// The map is an ATLAS, matched to the projection in render/car-asset.js:
//   u 0.05..0.45, v 0.05..0.95  -> the two flanks (u = length, v = height)
//   u 0.55..0.95, v 0.55..0.95  -> roof / bonnet / boot lid (u = length, v = width)
//   u 0.55..0.95, v 0.05..0.45  -> nose and tail faces (u = width, v = height)
// The old map smeared one full-body planar projection over every face, so the
// flanks (whose planar u collapses onto the texture edge) picked up the roof
// stripes, the dark nose/tail blocks and the sponsor text: grey panels with
// stray white and red patches.
//
// Approved design (tools/blender/RALLY-REFERENCE.md, shots/review-rally-v3.png):
// a clean red body, ONE white door band, ONE competition-number roundel,
// ONE thin sponsor strip. Nothing else - no lettering, no quarter panels,
// no dark end blocks, no belt-line webbing.
const TEAM = {
  A: { primary: '#c4262a', secondary: '#f4f1ea', num: 7 },
  B: { primary: '#1c3f8c', secondary: '#f4f1ea', num: 3 },
  C: { primary: '#2c6a34', secondary: '#eae4d4', num: 12 },
  D: { primary: '#d8a416', secondary: '#22242a', num: 5 },
};

// 512, not 128: the flank half of the atlas is 0.46 of the canvas over a 4.1 m
// body (T35/T38), so at 128 the 0.35 m roundel was under 4 texels wide and the
// number dissolved. At 512 it is ~20 texels across and the digit stays legible.
const S = 512;
const INK = '#1a1b1f';

/** Atlas rects the paint occupies (u/v, same space as the projection in
 *  render/car-asset.js). They sit BELOW the belt line, so the door band, the
 *  roundel and the sponsor strip can only land on the door / rear quarter
 *  panel skin, never on the greenhouse. car-asset.js parks every glass face at
 *  GLASS_UV, and src/debug/tests.js T35 asserts these rects stay glass-free. */
/**
 * METRIC numbers (T38): the flank projection in car-asset.js is isotropic at
 * mu = FLANK_UV.uSpan / bodyLength = 0.46 / 4.114 = 0.11182 atlas units per
 * METRE, so these rects convert straight back to metres on the door:
 *   band   x -0.794..+0.413 m, y -0.056..+0.223 m (the model's own white band,
 *          rows 6..8 cols 13..25, so baked and painted band are the same band)
 *   roundel centre x -0.075 m (mid door panel, arch gaps at -1.05 / +0.90),
 *          y +0.037 m (z 0.60, i.e. under the 0.85 m belt line), r = 0.175 m
 *          => a 0.35 m CIRCLE, never an ellipse, and clear of both arches
 *   strip  x +0.487..+0.785 m, z 0.76..0.80 m (ahead of the door, behind the
 *          front arch at +0.90 m, below the belt)
 * Nothing here reaches u > 0.34 or v > 0.115: the flank rect runs u 0.02..0.48,
 * v 0.03..0.198, glass is parked at GLASS_UV and every arch panel is masked.
 */
export const LIVERY_BAND = { u0: 0.1612, u1: 0.2962, v0: 0.0819, v1: 0.1131 };
export const LIVERY_ROUND = { u: 0.2469, v: 0.0917, r: 0.0196 };
export const LIVERY_STRIP = { u0: 0.3044, u1: 0.3375, v0: 0.1092, v1: 0.1133 };

const lerp = (a, b, k) => a + (b - a) * k;
/** Canvas x for a texture u in 0..1. */
const ux = (u) => u * S;
/** Canvas y for a texture v in 0..1 (CanvasTexture is flipY: v = 1 is row 0). */
const vy = (v) => (1 - v) * S;

export function liveryFor(carId) {
  return TEAM[carId] || TEAM.A;
}

export function drawLivery(ctx, carId) {
  const t = liveryFor(carId);

  // 1. Base paint: one flat field, everywhere. Red for the player's car.
  ctx.fillStyle = t.primary;
  ctx.fillRect(0, 0, S, S);

  // 2. The single white door band, on the flank half only. Its v range matches
  // the height of the one band the model carries (rows 6..8, 0.60-0.90 m), so
  // the baked band and the painted band are the same band, not two.
  ctx.fillStyle = t.secondary;
  ctx.fillRect(ux(LIVERY_BAND.u0), vy(LIVERY_BAND.v1), ux(LIVERY_BAND.u1) - ux(LIVERY_BAND.u0), vy(LIVERY_BAND.v0) - vy(LIVERY_BAND.v1));

  // 3. One start-number roundel, centred in that band.
  const cx = ux(LIVERY_ROUND.u), cy = vy(LIVERY_ROUND.v), r = LIVERY_ROUND.r * S;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.stroke();
  const label = String(t.num);
  ctx.fillStyle = '#141414';
  ctx.font = `bold ${label.length > 1 ? 11 : 14}px monospace`;   // ~2/3 of the 20 texel roundel
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx - ctx.measureText(label).width / 2, cy);
  ctx.textBaseline = 'alphabetic';

  // 4. One thin sponsor strip ahead of the door. A bar, not lettering.
  ctx.fillStyle = t.secondary;
  ctx.fillRect(ux(LIVERY_STRIP.u0), vy(LIVERY_STRIP.v1), ux(LIVERY_STRIP.u1) - ux(LIVERY_STRIP.u0), vy(LIVERY_STRIP.v0) - vy(LIVERY_STRIP.v1));
}

export function buildLiveryTexture(carId, THREE) {
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  drawLivery(ctx, carId);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
