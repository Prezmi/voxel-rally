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

const S = 128;
const INK = '#1a1b1f';

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
  ctx.fillRect(ux(0.14), vy(0.56), ux(0.32) - ux(0.14), vy(0.36) - vy(0.56));

  // 3. One start-number roundel, centred in that band.
  const cx = ux(0.225), cy = vy(0.46), r = 9.0;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.stroke();
  const label = String(t.num);
  ctx.fillStyle = '#141414';
  ctx.font = `bold ${label.length > 1 ? 11 : 14}px monospace`;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx - ctx.measureText(label).width / 2, cy);
  ctx.textBaseline = 'alphabetic';

  // 4. One thin sponsor strip ahead of the door. A bar, not lettering.
  ctx.fillStyle = t.secondary;
  ctx.fillRect(ux(0.335), vy(0.335), ux(0.425) - ux(0.335), vy(0.305) - vy(0.335));
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
