// Pace-note sign boards drawn in Minecraft's oak-sign language (PLAN.md §10.1).
// A plank body with a few darker grain rows, a 1 px dark outline, two nail pixels, a
// BLOCKY arrow built from stacked squares (no antialiased lines), the severity as a big
// pixel digit, the Polish word and the distance counting down.
// Signs appear and leave in hard steps — a 2-frame pop, never a fade or an ease.
import { drawText, textWidth } from './pixel-font.js';

const WOOD = '#9C7E4E';         // oak plank
const WOOD_LIGHT = '#B4915C';   // light from the top-left
const WOOD_DARK = '#7A6138';    // grain
const EDGE = '#2A1F10';         // dark 1 px outline
const INK = '#22190E';          // carved lettering
const INK_DIM = '#4A3620';      // the small preview board: same carving, lighter
const NAIL = '#3E3E3E';

const H = 34;                  // whole strip stays inside 10 % of the frame height

// Bend glyphs: orthogonal polylines on an 8x8 cell grid (y down, x right, the car
// drives from the bottom of the glyph up). Authored for a LEFT bend; the RIGHT
// variants mirror the x axis. Sizes are deliberately coarse - a whole cell is 3 px
// on the active board, so the arrow reads at a glance.
//   plainLeft/Right     90 deg bend            (5 -> 4 class)
//   sharpLeft/Right     >90 deg, hooking back  (2 -> 3 class)
//   hairpinLeft/Right   full U-turn            (1 class / >150 deg)
const BENDS = {
  straight: [[3, 7], [3, 1]],
  plainLeft: [[4, 7], [4, 4], [1, 4]],
  sharpLeft: [[4, 7], [4, 2], [1, 2], [1, 5]],
  hairpinLeft: [[6, 7], [6, 1], [1, 1], [1, 6]],
};
const mirror = (cells) => cells.map(([x, y]) => [7 - x, y]);
// The RIGHT-handed glyphs are the LEFT ones mirrored on x, built once so a board can
// never draw an arrow that points the other way than the word next to it says.
for (const k of ['plain', 'sharp', 'hairpin']) BENDS[k + 'Right'] = mirror(BENDS[k + 'Left']);

/** severity / hairpin / direction -> glyph name; the name always ends with the side. */
export function bendKind(sev, hairpin, dir) {
  const side = dir === 'R' ? 'Right' : 'Left';
  if (hairpin) return 'hairpin' + side;
  if (sev <= 3) return 'sharp' + side;
  return 'plain' + side;
}

function cellsOf(kind) {
  return BENDS[kind] || BENDS.plainLeft;
}

/** The arrow: every cell of the polyline plus a blocky head at the tip. */
function drawArrow(ctx, ox, oy, B, kind, color) {
  const pts = cellsOf(kind);
  const on = new Set();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    on.add(a[0] + ',' + a[1]);
    if (i) {
      const b = pts[i - 1];
      const sx = Math.sign(a[0] - b[0]), sy = Math.sign(a[1] - b[1]);
      let x = b[0], y = b[1];
      while (x !== a[0] || y !== a[1]) {
        if (x !== a[0]) x += sx; else y += sy;
        on.add(x + ',' + y);
      }
    }
  }
  // Head: two wing cells at the tip and two one step back, offset ACROSS the travel
  // direction, so the arrow reads as a wide blocky head and not as a longer stem.
  const t = pts[pts.length - 1], p = pts.length > 1 ? pts[pts.length - 2] : [t[0], t[1] + 1];
  const dx = Math.sign(t[0] - p[0]), dy = Math.sign(t[1] - p[1]);
  const back = [t[0] - dx, t[1] - dy];
  const wing = dx === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
  on.add(t[0] + ',' + t[1]);
  for (const h of wing) {
    on.add((t[0] + h[0]) + ',' + (t[1] + h[1]));
    on.add((back[0] + h[0]) + ',' + (back[1] + h[1]));
  }
  ctx.fillStyle = color;
  for (const key of on) {
    const c = key.split(',');
    ctx.fillRect(ox + (+c[0]) * B, oy + (+c[1]) * B, B, B);
  }
}

/** Layout metrics of one board (no canvas needed) so the HUD can flow a row. */
export function signMetrics(spec) {
  const big = spec.big;  const B = big ? 3 : 2;
  const aw = 8 * B;
  const ds = big ? 2 : 1;
  const digitW = spec.sev ? 5 * ds + 9 : 0;   // digit + its separator column
  const distW = textWidth(spec.dist, ds) + 8;      // the distance sits in a carved plate
  const wordW = textWidth(spec.word, 1) + (spec.eta ? textWidth(spec.eta, 1) + 6 : 0);
  const colW = Math.max(digitW + distW, wordW);
  return { w: 3 + aw + 4 + colW + 3, h: H, B, ds, colW };
}

/** spec: { kind, dir, sev, word, dist, big, spoken, pop }  -> board width. */
export function drawSignBoard(ctx, x, y, spec) {
  const m = signMetrics(spec);
  const INK2 = spec.dim ? INK_DIM : INK;
  const w = m.w, h = m.h;
  // 2-frame pop: the board is drawn 2 px larger for two redraws, then it is normal.
  // Hard steps only — no easing, no alpha (PLAN.md §10.1).
  const pop = spec.pop > 0 ? 2 : 0;
  const X = Math.round(x - (pop ? 1 : 0)), Y = Math.round(y - (pop ? 1 : 0));
  const W = w + pop, H2 = h + pop;
  ctx.fillStyle = EDGE; ctx.fillRect(X, Y, W, H2);
  ctx.fillStyle = WOOD; ctx.fillRect(X + 1, Y + 1, W - 2, H2 - 2);
  ctx.fillStyle = WOOD_LIGHT;
  ctx.fillRect(X + 1, Y + 1, W - 2, 1);          // lit top edge
  ctx.fillRect(X + 1, Y + 1, 1, H2 - 2);         // lit left edge
  ctx.fillStyle = WOOD_DARK;
  ctx.fillRect(X + 1, Y + H2 - 2, W - 2, 1);     // shaded bottom edge
  ctx.fillRect(X + W - 2, Y + 1, 1, H2 - 2);     // shaded right edge
  // grain: a few darker pixel rows, broken like plank grain (fixed pattern, no RNG)
  for (let g = 0; g < GRAIN.length; g++) {
    const gy = GRAIN[g][0], skip = GRAIN[g][1];
    if (gy >= H2 - 2) continue;
    for (let px = 3; px < W - 3; px++) {
      if ((px + skip) % 7 === 0 || (px + skip) % 11 === 0) continue;
      ctx.fillRect(X + px, Y + gy, 1, 1);
    }
  }
  ctx.fillStyle = NAIL;                            // two nail pixels
  ctx.fillRect(X + 2, Y + 3, 1, 1);
  ctx.fillRect(X + W - 3, Y + 3, 1, 1);
  // a called-out note gets a 1 px light inner border instead of any glow
  if (spec.spoken) {
    ctx.fillStyle = '#FDFDFD';
    ctx.fillRect(X + 1, Y + 2, W - 2, 1);
    ctx.fillRect(X + 2, Y + 2, 1, H2 - 4);
  }
  drawArrow(ctx, X + 3, Y + Math.round((h - 8 * m.B) / 2), m.B, spec.kind, INK2);
  let cx = X + 3 + 8 * m.B + 4;
  const cy = Y + 4;
  if (spec.sev) {
    drawText(ctx, String(spec.sev), cx, cy, m.ds, INK2);
    cx += 5 * m.ds + 4;
    ctx.fillStyle = INK2;                      // separator: the note digit vs the metres
    ctx.fillRect(cx, cy - 1, 1, 7 * m.ds + 4);
    cx += 4;
  }
  // the counting-down distance, carved into its own darker plate so the big digit and
  // the metres never merge into one number
  const dw = textWidth(spec.dist, m.ds) + 6;
  ctx.fillStyle = WOOD_DARK;
  ctx.fillRect(cx - 2, cy - 1, dw, 7 * m.ds + 2);
  ctx.fillStyle = '#5D4826';
  ctx.fillRect(cx - 2, cy - 1, dw, 1);
  drawText(ctx, spec.dist, cx, cy, m.ds, INK2);
  const wx = X + 3 + 8 * m.B + 4, wy = Y + 4 + 7 * m.ds + 4;
  drawText(ctx, spec.word, wx, wy, 1, INK2);
  // seconds left at the current speed - the countdown the callout is really timed on
  if (spec.eta) drawText(ctx, spec.eta, wx + textWidth(spec.word, 1) + 6, wy, 1, INK2);
  return w;
}

const GRAIN = [[6, 0], [12, 3], [19, 5], [26, 1]];

import { t } from '../core/i18n.js';
import { FEATURE } from '../world/road-spline.js';

// Feature word keys (src/core/i18n.js): EN CREST / DIP / JUMP / WATER / BRIDGE,
// PL the words the game shipped with (GARB / DOŁ / SKOK / WODA / MOST).
const FEATURE_WORD = {
  [FEATURE.CREST]: 'note.crest', [FEATURE.DIP]: 'note.dip', [FEATURE.JUMP]: 'note.jump',
  [FEATURE.WATER]: 'note.water', [FEATURE.BRIDGE]: 'note.bridge',
};

/** Polish word for a note: LEWO / PRAWO / OSTRO LEWO / SZYBKI PRAWO / feature words.
 *  English uses the same call structure in idiomatic rally vocabulary: LEFT / RIGHT /
 *  SHARP LEFT / EASY RIGHT / DON'T CUT LEFT. The side is always stated, in both. */
export function signWord(note) {
  if (note.kind !== 'corner') {
    if (note.text === 'HANT' || note.kind === 'straight') return t('note.hant');
    if (FEATURE_WORD[note.featureId]) return t(FEATURE_WORD[note.featureId]);
    return note.text.split(' ')[0];              // the build-time word already on the note
  }
  const sideKey = note.dir === 'L' ? 'note.left' : 'note.right';   // LEWO / LEFT
  if (note.hairpin) return `${t('note.dontCut')} ${t(sideKey)}`;
  if (note.severity <= 3) return t(note.dir === 'L' ? 'note.sharpLeft' : 'note.sharpRight');
  if (note.severity >= 5) return t(note.dir === 'L' ? 'note.easyLeft' : 'note.easyRight');
  return t(sideKey);
}
