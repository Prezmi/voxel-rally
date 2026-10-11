// The thumb overlay as NUMBERS, not as CSS overrides (queue P10).
//
// The left-handed layout used to be five `#touch-ui.lefty` rules plus a
// `transform: scaleX(-1)` on the cluster and a counter-flip on its buttons. Nothing
// could prove that overlay was right: no layout engine runs in node, so no check
// could see whether the mirrored pads overlapped each other, walked off the screen,
// fell under the 72 px minimum target, or climbed into the band the HUD owns. The one
// thing that could be verified was that a class had been toggled.
//
// So the geometry moved here: one table per orientation, resolved against a viewport,
// and handedness applied as an exact geometric mirror (x' = width - x - w) of every
// rect. That makes the whole overlay contract assertable - T43 in src/debug/tests.js
// walks the phone viewport matrix and pins: no overlap, inside the viewport, inside
// the HUD band, never under MIN_HIT, groups contain their children, and
// left == mirror(right) to the pixel.
//
// Pure module: no DOM, no three, no window. Coordinates are CSS px in the CSS box of
// #touch-ui (which is position:fixed;inset:0), x from the LEFT edge, y from the
// BOTTOM edge - the bottom band is where thumbs live.

/** Gap between the overlay and the viewport edge (never scaled: it is a screen edge,
 *  not a control, and a safe-area inset already adds to it). */
export const EDGE = 8;
/** Gap between pads of one cluster. */
export const GAP = 8;
/** Gap between the utility minis, and between the steer pad and the rail above it. */
export const RAIL_GAP = 16;
/** px, WCAG 2.5.5 minimum target size. Enforced at EVERY scale, which the old
 *  `--s:.8` media query silently broke (it made the 72 px minis 57.6 px). */
export const MIN_HIT = 72;
/** px along the bottom main.js reserves for this overlay (setTouchInset). Every pad
 *  stays inside it: the HUD lifts the dial, the gear readout, the wheel strip, the
 *  revs bar and the pace-note boards above this line. A bottom safe-area inset may
 *  push the stack up by exactly that inset, never further. */
export const TOUCH_BAND = 240;
/** Hard ceiling on how high the overlay may reach, whatever the screen is: past this
 *  the pads would be walking into the HUD's own panels. */
export const BAND_MAX = 280;
/** Landscape narrower than this loses 20 % like portrait does (the old media query). */
export const SMALL_LANDSCAPE_W = 640;
/** Narrowest the analog steering plank may be squeezed to make room for the drive
 *  cluster: below this the thumb has no travel left, so the fit search keeps the
 *  collision (and the suite goes red) instead of shipping a useless plank. */
export const STEER_MIN_W = 88;
/** Gap multipliers the fit search tries, in order: the layout keeps its pad sizes
 *  (MIN_HIT is a contract) and spends its air first. */
export const GAP_STEPS = [1, 0.5, 0];
/** Scale multipliers the fit search tries after the gaps are gone: on a narrow screen
 *  the overlay gives up travel and margin before it gives up a tap target. */
export const SCALE_STEPS = [1, 0.9, 0.8, 0.7];

export const PAD_CLS = {
  steer: 'tg-steer', throttle: 'tg-throttle', brake: 'tg-brake', hand: 'tg-hand',
  menu: 'tg-menu', camera: 'tg-camera', restart: 'tg-restart',
};
export const GROUP_OF = { throttle: 'cluster', brake: 'cluster', hand: 'cluster', menu: 'rail', camera: 'rail', restart: 'rail' };
export const GROUP_CLS = { cluster: 'tg-cluster', rail: 'tg-rail' };
export const INTERACTIVE = ['throttle', 'brake', 'hand', 'menu', 'camera', 'restart'];

// The table, RIGHT-handed (steer under the left thumb, drive pads under the right).
// [key, side, xSpec, ySpec, w, h] in px at scale 1:
//   side 'l'/'r'   which viewport edge the pad is measured from ('r' also means the
//                  `after` chain runs leftwards)
//   xSpec {px}       near edge this many px in from that edge
//         {after, gap} this many px past that pad, in the side's direction
//   ySpec {px}       this many px above the bottom edge (the bottom inset is added on
//                  top of it)
//         {above, gap} this many px above that pad's top
// Offsets are DERIVED from resolved rects rather than spelled out as coordinates,
// which is what keeps the layout collision-free once the MIN_HIT floor starts
// disagreeing with a scaled offset - the old CSS bug: at --s:.8 the portrait throttle
// and brake landed on top of each other, and a 44 px side inset pushed the utility
// rail across the brake pad. Chain the pads of a cluster off each other and the gap
// is a gap at every scale, floors included.
//
// Landscape is the design case (the way this game is played). Portrait has no room for
// a third column, so the cluster runs as two short rows and the rail sits on top.
export const PAD_TABLE = {
  landscape: [
    ['steer', 'l', { px: 0 }, { px: 0 }, 214, 118],
    ['throttle', 'r', { px: 0 }, { px: 90 }, 96, 96],
    ['hand', 'r', { after: 'throttle', gap: 6 }, { px: 0 }, 116, 90],
    ['brake', 'r', { after: 'hand', gap: 6 }, { above: 'hand', gap: 6 }, 88, 88],
    ['menu', 'l', { px: 0 }, { above: 'steer', gap: RAIL_GAP }, 72, 72],
    ['camera', 'l', { after: 'menu', gap: RAIL_GAP }, { above: 'steer', gap: RAIL_GAP }, 72, 72],
    ['restart', 'l', { after: 'camera', gap: RAIL_GAP }, { above: 'steer', gap: RAIL_GAP }, 72, 72],
  ],
  portrait: [
    ['steer', 'l', { px: 0 }, { px: 0 }, 200, 118],
    ['brake', 'r', { px: 0 }, { px: 0 }, 90, 90],
    ['throttle', 'r', { px: 0 }, { above: 'brake', gap: GAP }, 90, 90],
    ['hand', 'r', { after: 'brake', gap: 10 }, { px: 0 }, 150, 90],
    ['menu', 'r', { px: 0 }, { above: 'throttle', gap: GAP }, 90, 90],
    ['camera', 'r', { after: 'menu', gap: RAIL_GAP }, { above: 'throttle', gap: GAP }, 90, 90],
    ['restart', 'r', { after: 'camera', gap: RAIL_GAP }, { above: 'throttle', gap: GAP }, 90, 90],
  ],
};

/** The one scale rule (the old CSS had it split over two media queries). */
export function touchScale(width, height) {
  return (height > width || width <= SMALL_LANDSCAPE_W) ? 0.8 : 1;
}

/** `?hand=left|right` - the headless verification hook, same family as `?touch=on`
 *  and `?steer=`. Null means "no opinion, follow settings.touchHandedness". */
export function parseHandedness(search) {
  const q = new URLSearchParams(typeof search === 'string' ? search : (search?.search || ''));
  const v = String(q.get('hand') || q.get('handedness') || '').toLowerCase();
  return v === 'left' || v === 'right' ? v : null;
}

/** Every pad + group rect keyed, for the suite and for the DOM. */
export function rectMap(layout) {
  const m = {};
  for (const p of layout.pads) m[p.key] = p;
  for (const g of layout.groups) m[g.key] = g;
  return m;
}

/** Overlap area of two rects (0 when they only touch). */
export function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return (w > 0 && h > 0) ? w * h : 0;
}

/**
 * Everything wrong with a resolved layout, as messages: pads off the viewport, pads
 * over the band, tap targets under MIN_HIT, pads on top of each other, children
 * outside their group box. The fit search below scores this; T43 asserts it is empty.
 */
export function layoutDefects(layout) {
  const out = [], L = layout, bandCap = Math.min(L.height, BAND_MAX);
  for (const p of L.pads) {
    if (p.x < 0 || p.x + p.w > L.width) out.push(`${p.key} off the viewport x ${p.x}..${p.x + p.w}/${L.width}`);
    if (p.y + p.h > bandCap) out.push(`${p.key} reaches ${p.y + p.h} px, over the ${bandCap} px band`);
    if (p.y < 0) out.push(`${p.key} below the bottom edge`);
    if (p.hit && (p.w < MIN_HIT || p.h < MIN_HIT)) out.push(`${p.key} is ${p.w}x${p.h}, under the ${MIN_HIT} px target`);
  }
  for (let i = 0; i < L.pads.length; i++) {
    for (let j = i + 1; j < L.pads.length; j++) {
      const a = overlapArea(L.pads[i], L.pads[j]);
      if (a > 0) out.push(`${L.pads[i].key}/${L.pads[j].key} overlap ${a} px2`);
    }
  }
  for (const g of L.groups) {
    for (const p of L.pads.filter((p) => p.group === g.key)) {
      if (p.x < g.x || p.y < g.y || p.x + p.w > g.x + g.w || p.y + p.h > g.y + g.h) out.push(`${p.key} outside its ${g.key} box`);
    }
  }
  return out;
}

/**
 * Resolve the whole overlay for one viewport. `safe` = {left,right,bottom} env()
 * insets in px. Handedness is an exact mirror of every rect about the viewport
 * centre - which is also what turning the phone 180 degrees does to the notch, so the
 * side insets mirror with it.
 */
export function padRects({ width = 0, height = 0, handedness = 'right', safe = {}, scale } = {}) {
  const W = Math.max(1, Math.round(width)), H = Math.max(1, Math.round(height));
  const portrait = H > W;
  const s = Number.isFinite(scale) ? scale : touchScale(W, H);
  const saL = Math.max(0, safe.left || 0), saR = Math.max(0, safe.right || 0), saB = Math.max(0, safe.bottom || 0);
  const left = handedness === 'left';

  const build = (gapMul, scaleMul) => {
    const sc = s * scaleMul;
    const pads = [], byKey = {};
    for (const [key, side, xSpec, ySpec, w, h] of PAD_TABLE[portrait ? 'portrait' : 'landscape']) {
      // Sizes get the floor: the steer plank is not a tap target so it only has to
      // stay big, every tappable pad must never fall under MIN_HIT.
      const floor = INTERACTIVE.includes(key) ? MIN_HIT : 1;
      const pw = Math.max(floor, Math.round(w * sc)), ph = Math.max(floor, Math.round(h * sc));
      let x;
      if (xSpec.after == null) {
        const off = EDGE + (side === 'l' ? saL : saR) + Math.round(xSpec.px * sc);
        x = side === 'l' ? off : W - off - pw;
      } else {
        const ref = byKey[xSpec.after];
        if (!ref) throw new Error(`pad "${key}" sits after unknown pad "${xSpec.after}"`);
        const gap = Math.round(xSpec.gap * sc * gapMul);
        x = side === 'l' ? ref.x + ref.w + gap : ref.x - gap - pw;
      }
      let y = EDGE + saB;
      if (ySpec.above == null) y += Math.round(ySpec.px * sc);
      else {
        const ref = byKey[ySpec.above];
        if (!ref) throw new Error(`pad "${key}" sits above unknown pad "${ySpec.above}"`);
        y = ref.y + ref.h + Math.round(ySpec.gap * sc * gapMul);
      }
      const pad = { key, cls: PAD_CLS[key], group: GROUP_OF[key] || null, side, x, y, w: pw, h: ph, hit: INTERACTIVE.includes(key) };
      pads.push(pad);
      byKey[key] = pad;
    }
    // Group boxes = bounding box of their children: containment holds by construction.
    const groups = [];
    for (const key in GROUP_CLS) {
      const kids = pads.filter((p) => p.group === key);
      if (!kids.length) continue;
      const x0 = Math.min(...kids.map((p) => p.x)), y0 = Math.min(...kids.map((p) => p.y));
      const x1 = Math.max(...kids.map((p) => p.x + p.w)), y1 = Math.max(...kids.map((p) => p.y + p.h));
      groups.push({ key, cls: GROUP_CLS[key], x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    return { width: W, height: H, portrait, scale: sc, gapScale: gapMul, inset: saB,
      handedness: 'right', pads, groups };
  };

  // Squeeze the analog plank, never a tap target, so the drive cluster keeps its place
  // on a screen too narrow for both columns. Runs in the right-handed frame, before
  // the mirror, so both handednesses get exactly the same geometry. The plank is
  // analog (its travel comes from its own track width), so losing width costs fine
  // control, never a pad.
  const squeezeSteer = (L) => {
    const steer = L.pads.find((p) => p.key === 'steer');
    if (!steer) return;
    const blockers = L.pads.filter((p) => p !== steer && p.side === 'r' && overlapArea({ x: 0, y: steer.y, w: W, h: steer.h }, p) > 0);
    if (!blockers.length) return;
    const room = Math.min(...blockers.map((p) => p.x)) - steer.x - Math.round(GAP * L.scale);
    if (room >= STEER_MIN_W && room < steer.w) steer.w = room;
  };

  let best = null, bestBad = Infinity;
  for (const sm of SCALE_STEPS) {
    for (const gm of GAP_STEPS) {
      const L = build(gm, sm);
      squeezeSteer(L);
      const bad = layoutDefects(L).length;
      if (bad < bestBad) { best = L; bestBad = bad; }
      if (bad === 0) break;
    }
    if (bestBad === 0) break;
  }
  // The mirror, once, on the winning layout: the left-handed overlay is the
  // right-handed one reflected about the viewport centre, which is also what rotating
  // the phone 180 degrees does to the notch, so the side insets mirror with it.
  if (left) for (const p of best.pads) { p.x = W - p.x - p.w; p.side = p.side === 'l' ? 'r' : 'l'; }
  for (const g of best.groups) g.x = left ? W - g.x - g.w : g.x;
  best.handedness = left ? 'left' : 'right';
  best.top = Math.max(...best.pads.map((p) => p.y + p.h));
  // What the overlay actually costs along the bottom. main.js hands this to the HUD
  // (setTouchInset) instead of a bare constant, so a bottom safe-area inset can never
  // hide a pad behind the dial.
  best.band = Math.min(BAND_MAX, Math.max(TOUCH_BAND, best.top));
  return best;
}

/**
 * Put a resolved layout on the DOM: containers get left/bottom/width/height, children
 * get offsets inside their container. `--s` follows the resolved scale so the in-pad
 * CSS (track, dead zone, knob) matches the box it lives in. Returns the number of
 * elements placed, which is what T43 asserts on.
 */
export function applyPadLayout(root, layout) {
  if (!root || !root.style || !layout) return 0;
  if (typeof root.style.setProperty === 'function') root.style.setProperty('--s', String(layout.scale));
  else root.style['--s'] = String(layout.scale);
  const find = (cls) => (typeof root.querySelector === 'function' ? root.querySelector('.' + cls) : (root.children || {})[cls]);
  const box = (el, x, y, w, h) => {
    el.style.left = `${Math.round(x)}px`;
    el.style.bottom = `${Math.round(y)}px`;
    el.style.width = `${Math.round(w)}px`;
    el.style.height = `${Math.round(h)}px`;
  };
  const g = rectMap(layout);
  let placed = 0;
  for (const grp of layout.groups) {
    const el = find(GROUP_CLS[grp.key]);
    if (!el || !el.style) continue;
    box(el, grp.x, grp.y, grp.w, grp.h);
    placed++;
  }
  for (const p of layout.pads) {
    const el = find(p.cls);
    if (!el || !el.style) continue;
    const parent = p.group ? g[p.group] : null;
    if (p.group && !parent) continue;
    box(el, parent ? p.x - parent.x : p.x, parent ? p.y - parent.y : p.y, p.w, p.h);
    placed++;
  }
  return placed;
}
