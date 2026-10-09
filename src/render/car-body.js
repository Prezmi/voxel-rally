// Rally-car volumes (PLAN §10.2 "auto pokazane z szacunkiem dla kształtu").
// No BoxGeometry slabs: every volume is either a CHAMFERED box (cut edges + cut
// corners, so the body reads as shaped sheet metal and not as a toy box) or a
// LOFTED side profile (a real silhouette: nose, bonnet, sloped windscreen, roof,
// sloped rear screen, deck, tail, underbody).
//
// Everything is baked once into one non-indexed vertex set carrying, per vertex:
//   position / normal / color   - geometry + face shading
//   aPanel  (0..15)             - the dirt panel of that volume (src/dirt/panel-dirt.js order)
//   aLivUv, aLiv                - livery texture coords + how strongly the livery applies
//   aLamp                       - 0 none, 1 headlight, 2 tail-light (emissive hook)
// Nothing here runs per frame (docs/06 §1 "pule obiektów wszędzie").
import * as THREE from 'three';
import { TYRE_BASE } from '../car/car-params.js';
import { PANEL_INDEX } from '../dirt/panel-dirt.js';

const TAU = Math.PI * 2;
export const CAR_MAT = {
  paintShade: 1.0,
  glass: 0x1d2831,
  trim: 0x25272b,
  dark: 0x1a1c20,
  chrome: 0xb4bcc2,
  steel: 0x8a9298,
  rubber: 0x15161a,
  rubberWall: 0x24262b,
  lamp: 0xe9e4cf,
  tail: 0xa8241c,
};

/** Hard-edged face shading: keeps the body modelled even under flat light. */
function shadeOf(nx, ny, nz) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ay >= ax && ay >= az) return ny > 0 ? 1.0 : 0.54;
  if (az >= ax) return nz > 0 ? 0.93 : 0.70;
  return nx > 0 ? 0.88 : 0.78;
}

/**
 * Car-local dimensions derived from the sim parameters (X forward, Y up, Z right,
 * origin = CoM, so the ground plane sits at y = -comY).
 */
export function carShape(p) {
  const g = -p.comY;
  const wb = p.wheelbase / 2, tf = p.trackFront / 2, tr = p.trackRear / 2;
  const floor = g + 0.15, belt = g + 0.82, roof = belt + 0.46;
  const hx = p.hull.x, hz = p.hull.z;
  const wing = !!(p.aero && p.aero.downforce >= 0.5);
  // Wheel order is normative (FL FR RL RR); wheel.js puts the left side at -Z.
  const mounts = [{ x: wb, z: -tf }, { x: wb, z: tf }, { x: -wb, z: -tr }, { x: -wb, z: tr }];
  const archPanel = [PANEL_INDEX.archFL, PANEL_INDEX.archFR, PANEL_INDEX.archRL, PANEL_INDEX.archRR];
  // src/dirt/panel-dirt.js puts flankL/sillL at +Z, wheel.js puts the left side at
  // -Z. The dirt data is what actually gets deposited, so follow panel-dirt here.
  const flankPanel = { minusZ: PANEL_INDEX.flankR, plusZ: PANEL_INDEX.flankL };
  const sillPanel = { minusZ: PANEL_INDEX.sillR, plusZ: PANEL_INDEX.sillL };
  return {
    g, floor, belt, roof, hx, hz, wb, tf, tr, wing, mounts, archPanel, flankPanel, sillPanel,
    wheelW: 0.25,
    bounds: { x: hx + 0.28, z: hz + 0.34, yb: floor - 0.08, yt: roof + 0.14 },
  };
}

export class VolumeBuilder {
  constructor(bounds) {
    this.pos = []; this.nor = []; this.col = [];
    this.panel = []; this.uv = []; this.liv = []; this.lamp = [];
    this.b = bounds;
    this.ranges = {}; this._marks = {};
  }
  mark(name) { this._marks[name] = this.pos.length / 3; }
  close(name) { this.ranges[name] = [this._marks[name], this.pos.length / 3]; }
  _uv(x, y, z, nx, ny, nz) {
    const b = this.b;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (az >= ax && az >= ay) return [(x + b.x) / (2 * b.x), (y - b.yb) / (b.yt - b.yb)];
    if (ay >= ax) return [(x + b.x) / (2 * b.x), (z + b.z) / (2 * b.z)];
    return [(z + b.z) / (2 * b.z), (y - b.yb) / (b.yt - b.yb)];
  }
  _v(x, y, z, nx, ny, nz, o) {
    const hex = o.hex, t = (o.tint === undefined ? 1 : o.tint) * shadeOf(nx, ny, nz);
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(((hex >> 16) & 255) / 255 * t, ((hex >> 8) & 255) / 255 * t, (hex & 255) / 255 * t);
    const uv = this._uv(x, y, z, nx, ny, nz);
    this.uv.push(uv[0], uv[1]);
    this.panel.push(o.panel === undefined ? 0 : o.panel);
    this.liv.push(o.liv === undefined ? 0 : o.liv);
    this.lamp.push(o.lamp === undefined ? 0 : o.lamp);
  }
  /** Triangle; winding is auto-corrected against the intended outward normal. */
  tri(a, b, c, nRef, o) {
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    if (nx * nx + ny * ny + nz * nz < 1e-12) return;
    let flip = false;
    if (nRef) {
      if (nx * nRef[0] + ny * nRef[1] + nz * nRef[2] < 0) flip = true;
      nx = nRef[0]; ny = nRef[1]; nz = nRef[2];
    } else {
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    }
    if (flip) { this._v(b[0], b[1], b[2], nx, ny, nz, o); this._v(a[0], a[1], a[2], nx, ny, nz, o); this._v(c[0], c[1], c[2], nx, ny, nz, o); }
    else { this._v(a[0], a[1], a[2], nx, ny, nz, o); this._v(b[0], b[1], b[2], nx, ny, nz, o); this._v(c[0], c[1], c[2], nx, ny, nz, o); }
  }
  quad(p0, p1, p2, p3, n, o) {
    this.tri(p0, p1, p2, n, o);
    this.tri(p0, p2, p3, n, o);
  }
  /** Box with every edge and every corner cut: the workhorse volume. */
  chamfer(cx, cy, cz, hx, hy, hz, ch, o) {
    const c = Math.max(0.004, Math.min(ch, hx * 0.85, hy * 0.85, hz * 0.85));
    const ix = hx - c, iy = hy - c, iz = hz - c;
    const A = (sx, sy, sz) => [cx + sx * hx, cy + sy * iy, cz + sz * iz];
    const B = (sx, sy, sz) => [cx + sx * ix, cy + sy * hy, cz + sz * iz];
    const C = (sx, sy, sz) => [cx + sx * ix, cy + sy * iy, cz + sz * hz];
    this.quad(A(1, 1, 1), A(1, -1, 1), A(1, -1, -1), A(1, 1, -1), [1, 0, 0], o);
    this.quad(A(-1, 1, 1), A(-1, 1, -1), A(-1, -1, -1), A(-1, -1, 1), [-1, 0, 0], o);
    this.quad(B(1, 1, 1), B(-1, 1, 1), B(-1, -1, 1), B(1, -1, 1), [0, 1, 0], o);
    this.quad(B(1, 1, -1), B(1, -1, -1), B(-1, -1, -1), B(-1, 1, -1), [0, -1, 0], o);
    this.quad(C(1, 1, 1), C(1, -1, 1), C(-1, -1, 1), C(-1, 1, 1), [0, 0, 1], o);
    this.quad(C(1, 1, -1), C(-1, 1, -1), C(-1, -1, -1), C(1, -1, -1), [0, 0, -1], o);
    for (const sy of [1, -1]) for (const sz of [1, -1]) this.quad(B(-1, sy, sz), B(1, sy, sz), C(1, sy, sz), C(-1, sy, sz), [0, sy, sz], o);
    for (const sx of [1, -1]) for (const sz of [1, -1]) this.quad(A(sx, -1, sz), A(sx, 1, sz), C(sx, 1, sz), C(sx, -1, sz), [sx, 0, sz], o);
    for (const sx of [1, -1]) for (const sy of [1, -1]) this.quad(A(sx, sy, -1), A(sx, sy, 1), B(sx, sy, 1), B(sx, sy, -1), [sx, sy, 0], o);
    for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) this.tri(A(sx, sy, sz), B(sx, sy, sz), C(sx, sy, sz), [sx, sy, sz], o);
  }
  /** Side-view profile [x,y,halfWidth] extruded across the car. Closed loop. */
  walls(pts, edgeOpts) {
    const n = pts.length;
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= n; cy /= n;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      let nx = dy, ny = -dx;
      const mx = (a[0] + b[0]) * 0.5 - cx, my = (a[1] + b[1]) * 0.5 - cy;
      if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }
      const l = Math.hypot(nx, ny) || 1;
      this.quad([a[0], a[1], a[2]], [b[0], b[1], b[2]], [b[0], b[1], -b[2]], [a[0], a[1], -a[2]],
        [nx / l, ny / l, 0], edgeOpts[i]);
    }
  }
  caps(pts, optPlus, optMinus) {
    const n = pts.length;
    let cx = 0, cy = 0, cz = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2]; }
    cx /= n; cy /= n; cz /= n;
    const cp = [cx, cy, cz], cm = [cx, cy, -cz];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      this.tri(cp, [a[0], a[1], a[2]], [b[0], b[1], b[2]], [0, 0, 1], optPlus);
      this.tri(cm, [b[0], b[1], -b[2]], [a[0], a[1], -a[2]], [0, 0, -1], optMinus);
    }
  }
  toGeometry(THREE_) {
    const T = THREE_ || THREE;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPanel', new T.Float32BufferAttribute(this.panel, 1));
    g.setAttribute('aLivUv', new T.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aLiv', new T.Float32BufferAttribute(this.liv, 1));
    g.setAttribute('aLamp', new T.Float32BufferAttribute(this.lamp, 1));
    g.computeBoundingSphere();
    return g;
  }
  get triangleCount() { return this.pos.length / 3; }
}

/**
 * The body: two lofted volumes (tub + greenhouse) plus the bolted-on parts.
 * One geometry, one draw call, 16 dirt panels mapped explicitly per volume.
 */
export function buildBodyGeometry(car) {
  const p = car.params;
  const s = carShape(p);
  const vb = new VolumeBuilder(s.bounds);
  const P = PANEL_INDEX;
  const PAINT = { liv: 1, tint: 1 };
  const paint = (panel) => ({ hex: 0xffffff, panel, liv: 1 });   // colour comes from the livery map
  const glass = (panel) => ({ hex: CAR_MAT.glass, panel, liv: 0, tint: 1 });
  const trim = (panel, hex) => ({ hex: hex || CAR_MAT.trim, panel, liv: 0 });

  // ---- lower body: nose, bonnet, cowl, deck, tail, underbody ----
  const hx = s.hx, hz = s.hz, f = s.floor, bl = s.belt;
  const tub = [
    [hx - 0.34, f + 0.00, hz * 0.94],
    [hx - 0.06, f + 0.07, hz * 0.85],
    [hx + 0.02, f + 0.26, hz * 0.82],
    [hx - 0.16, bl - 0.02, hz * 0.90],
    [s.wb + 0.10, bl + 0.02, hz * 0.96],
    [0.55, bl + 0.05, hz * 0.94],
    [-0.82, bl + 0.06, hz * 0.96],
    [-hx + 0.32, bl + 0.02, hz * 0.92],
    [-hx + 0.02, bl - 0.16, hz * 0.84],
    [-hx - 0.02, f + 0.12, hz * 0.86],
    [-hx + 0.28, f + 0.00, hz * 0.94],
  ];
  vb.walls(tub, [
    trim(P.front, CAR_MAT.trim), trim(P.front, CAR_MAT.trim), trim(P.front, CAR_MAT.trim),
    paint(P.hood), paint(P.hood), { hex: 0xffffff, panel: P.hood, liv: 1 },
    paint(P.rear), paint(P.rear), paint(P.rear),
    { hex: CAR_MAT.dark, panel: P.under }, { hex: CAR_MAT.dark, panel: P.under }, { hex: CAR_MAT.dark, panel: P.under },
  ]);
  vb.caps(tub, { hex: 0xffffff, panel: s.flankPanel.plusZ, liv: 1 }, { hex: 0xffffff, panel: s.flankPanel.minusZ, liv: 1 });

  // ---- greenhouse: sloped windscreen, roof, sloped rear screen ----
  const cab = [
    [0.60, bl + 0.05, hz * 0.90],
    [0.14, s.roof - 0.02, hz * 0.80],
    [-0.66, s.roof - 0.04, hz * 0.80],
    [-0.96, bl + 0.06, hz * 0.90],
  ];
  vb.walls(cab, [
    glass(P.screenF), paint(P.roof), glass(P.screenR), { hex: CAR_MAT.dark, panel: P.under },
  ]);
  vb.caps(cab, glass(P.flankL), glass(P.flankR));
  // Pillars + belt line so the greenhouse is a frame, not a glass bubble.
  for (const z of [hz * 0.84, -hz * 0.84]) {
    vb.chamfer(0.42, bl + 0.24, z, 0.055, 0.22, 0.05, 0.02, trim(P.screenF, CAR_MAT.trim));
    vb.chamfer(-0.78, bl + 0.24, z, 0.05, 0.22, 0.05, 0.02, trim(P.screenR, CAR_MAT.trim));
    vb.chamfer(-0.16, bl + 0.02, z, 0.55, 0.035, 0.045, 0.015, trim(P.roof, CAR_MAT.trim));
  }

  // ---- wheel arches: flared overfenders cut around each wheel ----
  for (let i = 0; i < 4; i++) {
    const m = s.mounts[i];
    const zo = m.z + (m.z > 0 ? 0.09 : -0.09);
    vb.chamfer(m.x, s.belt - 0.06, zo, 0.54, 0.17, 0.12, 0.055, paint(s.archPanel[i]));
    vb.chamfer(m.x, s.belt + 0.11, zo, 0.46, 0.035, 0.10, 0.03, trim(s.archPanel[i], CAR_MAT.trim));
  }
  // ---- sills ----
  for (const z of [hz - 0.03, -(hz - 0.03)]) {
    vb.chamfer(0, f + 0.04, z, hx - 0.52, 0.055, 0.075, 0.03, trim(z > 0 ? s.sillPanel.plusZ : s.sillPanel.minusZ, CAR_MAT.dark));
  }
  // ---- bumpers (marked so a hit can physically knock / drop one) ----
  vb.mark('bumperF');
  vb.chamfer(hx + 0.08, f + 0.15, 0, 0.11, 0.115, hz * 0.88, 0.05, trim(P.front, CAR_MAT.trim));
  vb.chamfer(hx + 0.10, f + 0.28, 0, 0.06, 0.06, hz * 0.5, 0.03, trim(P.front, CAR_MAT.dark));
  vb.close('bumperF');
  vb.mark('bumperR');
  vb.chamfer(-hx - 0.08, f + 0.15, 0, 0.11, 0.11, hz * 0.88, 0.05, trim(P.rear, CAR_MAT.trim));
  vb.close('bumperR');
  // grille between the lamps
  vb.chamfer(hx + 0.06, f + 0.27, 0, 0.05, 0.075, hz * 0.44, 0.03, trim(P.front, CAR_MAT.dark));

  // ---- lamps (aLamp drives the emissive; a destroyed lamp is deleted geometry) ----
  for (const z of [hz * 0.60, -(hz * 0.60)]) {
    vb.mark(z > 0 ? 'lampFR' : 'lampFL');
    vb.chamfer(hx + 0.05, f + 0.30, z, 0.05, 0.07, 0.15, 0.035, { hex: CAR_MAT.lamp, panel: P.front, liv: 0, lamp: 1 });
    vb.close(z > 0 ? 'lampFR' : 'lampFL');
  }
  for (const z of [hz * 0.62, -(hz * 0.62)]) {
    vb.chamfer(-hx - 0.05, f + 0.30, z, 0.045, 0.06, 0.13, 0.03, { hex: CAR_MAT.tail, panel: P.rear, liv: 0, lamp: 2 });
  }

  // ---- roof scoop, mirrors on stalks, exhaust tips ----
  vb.chamfer(0.10, s.roof + 0.055, 0, 0.17, 0.055, 0.13, 0.03, paint(P.roof));
  vb.chamfer(0.26, s.roof + 0.05, 0, 0.05, 0.045, 0.10, 0.02, trim(P.roof, CAR_MAT.dark));
  for (const z of [hz + 0.10, -(hz + 0.10)]) {
    vb.chamfer(0.52, s.roof - 0.19, z * 0.92, 0.05, 0.018, Math.abs(z) - hz * 0.92, 0.012, trim(P.flankL, CAR_MAT.trim));
    vb.chamfer(0.50, s.roof - 0.14, z, 0.07, 0.055, 0.03, 0.02, trim(P.flankL, CAR_MAT.chrome));
  }
  vb.chamfer(-hx - 0.10, f + 0.06, hz * 0.34, 0.12, 0.045, 0.045, 0.02, trim(P.under, CAR_MAT.chrome));
  vb.chamfer(-hx - 0.02, f + 0.02, 0, 0.06, 0.05, hz * 0.7, 0.02, trim(P.rear, CAR_MAT.dark));

  // ---- rear wing (only the cars that have the downforce for one) ----
  if (s.wing) {
    for (const z of [hz - 0.10, -(hz - 0.10)]) {
      vb.chamfer(-hx + 0.20, bl + 0.30, z, 0.05, 0.24, 0.045, 0.02, trim(P.wing, CAR_MAT.trim));
    }
    vb.chamfer(-hx + 0.18, bl + 0.55, 0, 0.17, 0.035, hz - 0.02, 0.03, paint(P.wing));
    vb.chamfer(-hx + 0.30, bl + 0.50, 0, 0.06, 0.05, hz - 0.06, 0.025, trim(P.wing, CAR_MAT.trim));
  }

  const geo = vb.toGeometry(THREE);
  return { geo, ranges: vb.ranges, shape: s, tris: vb.triangleCount };
}

/**
 * One wheel: tyre drum with real lugs (alternating tread radius + a centre
 * groove), sidewalls, rim barrel with 5 spokes, hub, brake discs on both sides
 * so the same geometry serves all four corners (drawn once, instanced 4x).
 */
export function buildWheelGeometry(car) {
  const vb = new VolumeBuilder({ x: 0.6, z: 0.2, yb: -0.4, yt: 0.4 });
  const r = TYRE_BASE.r, w = car.params ? 0.25 : 0.25;
  const N = 14;
  const tread = { hex: CAR_MAT.rubber, panel: 0 };
  const wall = { hex: CAR_MAT.rubberWall, panel: 0 };
  const rim = { hex: CAR_MAT.steel, panel: 0 };
  const disc = { hex: CAR_MAT.steel, panel: 0, tint: 0.8 };
  const hub = { hex: CAR_MAT.chrome, panel: 0 };

  // tread: two bands, alternating lug radius -> visible blocks of tread
  for (const band of [[-w * 0.5, -w * 0.15], [w * 0.15, w * 0.5]]) {
    for (let k = 0; k < N; k++) {
      const a0 = (k / N) * TAU, a1 = ((k + 1) / N) * TAU;
      const r0 = (k % 2 === 0) ? r : r - 0.028;
      const r1 = ((k + 1) % 2 === 0) ? r : r - 0.028;
      const am = (a0 + a1) * 0.5;
      vb.quad([Math.cos(a0) * r0, Math.sin(a0) * r0, band[0]], [Math.cos(a1) * r1, Math.sin(a1) * r1, band[0]],
        [Math.cos(a1) * r1, Math.sin(a1) * r1, band[1]], [Math.cos(a0) * r0, Math.sin(a0) * r0, band[1]],
        [Math.cos(am), Math.sin(am), 0], tread);
    }
  }
  // groove floor + sidewalls
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * TAU, a1 = ((k + 1) / N) * TAU;
    const rg = r - 0.020, am = (a0 + a1) * 0.5;
    vb.quad([Math.cos(a0) * rg, Math.sin(a0) * rg, -w * 0.15], [Math.cos(a1) * rg, Math.sin(a1) * rg, -w * 0.15],
      [Math.cos(a1) * rg, Math.sin(a1) * rg, w * 0.15], [Math.cos(a0) * rg, Math.sin(a0) * rg, w * 0.15],
      [Math.cos(am), Math.sin(am), 0], tread);
    for (const sgn of [1, -1]) {
      const z = sgn * w * 0.5;
      vb.quad([Math.cos(a0) * r * 0.98, Math.sin(a0) * r * 0.98, z], [Math.cos(a1) * r * 0.98, Math.sin(a1) * r * 0.98, z],
        [Math.cos(a1) * r * 0.56, Math.sin(a1) * r * 0.56, z * 0.86], [Math.cos(a0) * r * 0.56, Math.sin(a0) * r * 0.56, z * 0.86],
        [0, 0, sgn], wall);
    }
  }
  // rim: barrel, outer faces, 5 spokes, hub
  const rr = r * 0.56;
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * TAU, a1 = ((k + 1) / N) * TAU, am = (a0 + a1) * 0.5;
    vb.quad([Math.cos(a0) * rr, Math.sin(a0) * rr, -w * 0.42], [Math.cos(a1) * rr, Math.sin(a1) * rr, -w * 0.42],
      [Math.cos(a1) * rr, Math.sin(a1) * rr, w * 0.42], [Math.cos(a0) * rr, Math.sin(a0) * rr, w * 0.42],
      [Math.cos(am), Math.sin(am), 0], rim);
    for (const sgn of [1, -1]) {
      const z = sgn * w * 0.44;
      vb.tri([0, 0, z], [Math.cos(a0) * rr, Math.sin(a0) * rr, z], [Math.cos(a1) * rr, Math.sin(a1) * rr, z], [0, 0, sgn], rim);
    }
  }
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU, d = 0.19;
    for (const sgn of [1, -1]) {
      const z = sgn * w * 0.47;
      vb.quad([Math.cos(a - d) * rr * 0.98, Math.sin(a - d) * rr * 0.98, z], [Math.cos(a + d) * rr * 0.98, Math.sin(a + d) * rr * 0.98, z],
        [Math.cos(a + d) * rr * 0.30, Math.sin(a + d) * rr * 0.30, z], [Math.cos(a - d) * rr * 0.30, Math.sin(a - d) * rr * 0.30, z],
        [0, 0, sgn], { hex: CAR_MAT.chrome, panel: 0 });
    }
  }
  for (let k = 0; k < 10; k++) {
    const a0 = (k / 10) * TAU, a1 = ((k + 1) / 10) * TAU, am = (a0 + a1) * 0.5, rh = r * 0.20;
    vb.quad([Math.cos(a0) * rh, Math.sin(a0) * rh, -w * 0.58], [Math.cos(a1) * rh, Math.sin(a1) * rh, -w * 0.58],
      [Math.cos(a1) * rh, Math.sin(a1) * rh, w * 0.58], [Math.cos(a0) * rh, Math.sin(a0) * rh, w * 0.58],
      [Math.cos(am), Math.sin(am), 0], hub);
  }
  // brake discs, both sides (so one geometry serves L and R)
  for (const sgn of [1, -1]) {
    const z0 = sgn * (w * 0.5 + 0.005), z1 = sgn * (w * 0.5 + 0.035), rd = r * 0.44;
    for (let k = 0; k < N; k++) {
      const a0 = (k / N) * TAU, a1 = ((k + 1) / N) * TAU, am = (a0 + a1) * 0.5;
      vb.quad([Math.cos(a0) * rd, Math.sin(a0) * rd, z0], [Math.cos(a1) * rd, Math.sin(a1) * rd, z0],
        [Math.cos(a1) * rd, Math.sin(a1) * rd, z1], [Math.cos(a0) * rd, Math.sin(a0) * rd, z1],
        [Math.cos(am), Math.sin(am), 0], disc);
      vb.tri([0, 0, z1], [Math.cos(a0) * rd, Math.sin(a0) * rd, z1], [Math.cos(a1) * rd, Math.sin(a1) * rd, z1], [0, 0, sgn], disc);
      vb.tri([0, 0, z0], [Math.cos(a1) * rd, Math.sin(a1) * rd, z0], [Math.cos(a0) * rd, Math.sin(a0) * rd, z0], [0, 0, -sgn], disc);
    }
  }
  return { geo: vb.toGeometry(THREE), tris: vb.triangleCount };
}
