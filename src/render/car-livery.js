// Livery generated in code (PLAN §10.2 "Auto z numerem i barwami zespołu"):
// one nearest-neighbour canvas per car id, baked once at boot, no assets.
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
// The HUD's own pixel bitmap (src/game/pixel-font.js), so the door number and the
// rally signs speak the same language - and so the number is geometry the suite can
// measure instead of a system-font glyph that changes with the platform.
import { glyphRows, GW } from '../game/pixel-font.js';

const TEAM = {
  A: { primary: '#c4262a', secondary: '#f4f1ea', num: 7 },
  B: { primary: '#1c3f8c', secondary: '#f4f1ea', num: 3 },
  C: { primary: '#2c6a34', secondary: '#eae4d4', num: 12 },
  D: { primary: '#d8a416', secondary: '#22242a', num: 5 },
};

// 1024, not 512: the flank half of the atlas is 0.46 of the canvas over a 4.1 m body
// (T35/T38), so a 512 canvas gives the 0.35 m roundel only ~20 texels across, and a
// digit inside it 11-14 texels with 1-2 texel strokes. Past ~15 m the roundel is
// smaller on screen than it is in the map, so those hairline strokes lose whole
// texels and the number dissolves (queue P9). At 1024 the roundel is ~40 texels and
// a stroke is 4-5 texels, i.e. it survives two mip levels. Cost: 4 MB RGBA (+1.3 MB
// of mips) per car instead of 1 MB, which is what the one hero decal on the car costs.
export const LIVERY_TEXEL = 1024;
const S = LIVERY_TEXEL;
const INK = '#1a1b1f';

/** Ring around the roundel, in texels. Kept thick for the same reason as the digits:
 *  a 2 texel hairline is gone in the first mip level, and the ring is what separates
 *  the white disc from the body colour at distance. */
const RING_W = Math.max(2, Math.round(S / 341));

/**
 * How the competition number is painted (queue P9). It is NOT text: every lit cell of
 * the pixel bitmap becomes one filled rect, so the digit is resolvable geometry that
 * `liveryNumberRects` can report and src/debug/tests.js T42 can measure.
 *   gap    empty bitmap columns between two digits
 *   bold   every cell rect is cell+bold texels across, so a stroke is a block and not
 *          a hairline (this is the legibility trick: it costs the counters of 0/6/8/9
 *          one texel each and buys every stroke one)
 *   margin texels kept between the lit box and the roundel edge
 */
export const LIVERY_NUM = { gap: 1, bold: 1, margin: 1 };

/**
 * Sampler spec (queue P9, the other half of the fix). MAGNIFICATION stays nearest so
 * the block digit stays a block; MINIFICATION must not stay nearest, because with no
 * mip chain a roundel that is 40 texels in the map and 14 texels on screen samples 14
 * of them and drops the other 26 at random - the number shimmering away past 15 m is
 * that aliasing, not only a lack of resolution. Mip levels average the digit INTO the
 * white disc instead of punching holes in it.
 */
export const LIVERY_SAMPLE = { mips: true, aniso: 8 };

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

/**
 * The competition number as GEOMETRY, in canvas texels: one rect per lit cell of the
 * 5x7 bitmap, sized to the biggest integer cell that still sits inside the roundel
 * (a circle is convex, so a whose-box-inside-the-circle test bounds every rect). Pure:
 * no canvas, no DOM, so node can measure the strokes and the fit (T42).
 * Returns { rects:[[x,y,w,h]...], cell, bold, cap, inkW, inkH, cx, cy, r, label }.
 */
export function liveryNumberRects(carId) {
  const label = String(liveryFor(carId).num);
  const cx = ux(LIVERY_ROUND.u), cy = vy(LIVERY_ROUND.v);
  const r = LIVERY_ROUND.r * S;
  const b = LIVERY_NUM.bold;

  // Lit cells in one shared column space, plus the tight box they occupy.
  const cells = [];
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
  for (let i = 0; i < label.length; i++) {
    const rows = glyphRows(label[i]) || glyphRows(' ');
    const base = i * (GW + LIVERY_NUM.gap);
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < GW; col++) {
        if (rows[row][col] !== '1') continue;
        cells.push([base + col, row]);
        if (base + col < c0) c0 = base + col;
        if (base + col > c1) c1 = base + col;
        if (row < r0) r0 = row;
        if (row > r1) r1 = row;
      }
    }
  }
  const inkW = Math.max(1, c1 - c0 + 1), inkH = Math.max(1, r1 - r0 + 1);

  // Biggest integer cell pitch whose lit box (bold growth included) fits the disc.
  const reach = 2 * (r - LIVERY_NUM.margin);
  let cell = 1;
  while (Math.hypot(inkW * (cell + 1) + b, inkH * (cell + 1) + b) <= reach) cell++;

  // Centre the lit box - not the glyph box - on the roundel.
  const ox = cx - (inkW * cell + b) / 2 - c0 * cell;
  const oy = cy - (inkH * cell + b) / 2 - r0 * cell;
  const rects = cells.map(([col, row]) => [
    Math.round(ox + col * cell), Math.round(oy + row * cell), cell + b, cell + b,
  ]);
  return { rects, cell, bold: b, cap: inkH * cell + b, inkW, inkH, cx, cy, r, label };
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
  ctx.lineWidth = RING_W;
  ctx.stroke();

  // 3b. The number, drawn cell by cell (queue P9). The old path was
  // `ctx.font = 'bold 14px monospace'; fillText(...)`: a system-font outline whose
  // strokes were 1-2 texels of a 20 texel roundel, unreadable past 15 m and different
  // on every platform. Blocks of a known bitmap at a known pitch are neither.
  const num = liveryNumberRects(carId);
  ctx.fillStyle = '#141414';
  for (const [x, y, w, h] of num.rects) ctx.fillRect(x, y, w, h);

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
  const mip = THREE.LinearMipmapLinearFilter !== undefined
    ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = mip;
  tex.generateMipmaps = LIVERY_SAMPLE.mips;
  tex.anisotropy = LIVERY_SAMPLE.aniso;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
