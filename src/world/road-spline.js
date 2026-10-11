// Road: a walker -> centripetal Catmull-Rom -> arc-length resampled polyline
// with per-metre attributes (docs/03 §3). The road is the data source for
// carving, pace notes, timing gates and the reference ghost.
import { Rng } from '../core/rng.js';
import { fbm2, smoothstep } from './noise.js';
import { SURF } from './surfaces.js';

export const FEATURE = { NONE: 0, CREST: 1, DIP: 2, JUMP: 3, WATER: 4, HAIRPIN: 5, CHICANE: 6, BRIDGE: 7 };
export const FEATURE_NAMES = ['—', 'OVER CREST', 'DIP', 'JUMP', 'WATER', 'HAIRPIN', 'CHICANE', 'BRIDGE'];

const CAMBER_GAIN = 6.0;          // rad per (1/m) of curvature
const CAMBER_MAX = 0.105;         // 6 deg
export const WIDTH_DEFAULT = { gravel: 7.5, mud: 7.5, asphalt: 9.0, sand: 7.5, grass: 7.5, stone: 7.5 };
export const WIDTH_NARROW = 5.5;

function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Walker: step 22-40 m, direction changes sampled from a distribution with many
 * small ones and rare large ones, with the docs/03 §3 rules enforced:
 *  - never more than 3 sharp corners in a row
 *  - at least one straight >= 180 m per 400 m
 */
export function walkRoad({ seed, lengthTarget = 3400, terrainHeightAt }) {
  const rng = new Rng(seed ^ 0x51ed270b);
  const pts = [];
  let x = 0, z = 0, heading = rng.range(0, Math.PI * 2);
  pts.push({ x, z });

  let sharpRun = 0;
  let sinceStraight = 0;
  let straightLen = 0;
  let total = 0;
  let guard = 0;

  while (total < lengthTarget && guard++ < 400) {
    // Direction change distribution.
    let kind = rng.weighted([
      ['straight', 26], ['slight', 30], ['medium', 24], ['sharp', 12], ['hairpin', 4],
    ]);
    let dTheta = 0;
    if (kind === 'slight') dTheta = rng.range(4, 18);
    else if (kind === 'medium') dTheta = rng.range(22, 48);
    else if (kind === 'sharp') dTheta = rng.range(58, 105);
    else if (kind === 'hairpin') dTheta = rng.range(118, 158);
    dTheta *= rng.sign();

    const sharp = kind === 'sharp' || kind === 'hairpin';
    if (sharp && sharpRun >= 3) { dTheta = rng.range(4, 16) * rng.sign(); }
    // Force a straight if we have gone too long without one.
    if (sinceStraight >= 400) { dTheta = rng.range(-6, 6); }

    // A corner of turn angle a over chord L has R ~ L / (2 sin(a/2)). Keep the
    // radius drivable (docs/03: hairpins are tight, not cusps) by lengthening the
    // step instead of allowing a sub-16 m corner.
    const MIN_R = 16;
    const aRad = Math.abs(dTheta) * Math.PI / 180;
    let step;
    if (kind === 'straight') step = rng.range(180, 260);
    else if (kind === 'slight') step = rng.range(45, 90);
    else if (kind === 'medium') step = rng.range(34, 60);
    else if (kind === 'sharp') step = rng.range(45, 80);
    else step = rng.range(60, 100);                       // hairpin
    if (aRad > 0.05) step = Math.max(step, Math.min(2 * MIN_R * Math.sin(aRad / 2) * 1.35, 300));
    if (step > lengthTarget - total) step = lengthTarget - total;

    heading += dTheta * Math.PI / 180;

    const nx = x + Math.cos(heading) * step;
    const nz = z + Math.sin(heading) * step;

    // Reject gross self-intersection (keep the stage a loop-ish corridor, not a knot).
    let reject = false;
    for (let i = 0; i < pts.length - 3; i++) {
      const dx = pts[i].x - nx, dz = pts[i].z - nz;
      if (dx * dx + dz * dz < 30 * 30) { reject = true; break; }
    }
    if (reject) {
      heading += rng.range(60, 120) * rng.sign() * Math.PI / 180;
      continue;
    }

    x = nx; z = nz; total += step;
    pts.push({ x, z });

    if (sharp) { sharpRun++; } else { sharpRun = 0; }
    if (kind === 'straight') { straightLen = step; sinceStraight = 0; }
    else { sinceStraight += step; if (straightLen >= 180) { straightLen = 0; } }
  }

  return pts;
}

/** Centripetal Catmull-Rom through `pts` (Barry-Goldman form, explicit knots). */
function crSegment(p0, p1, p2, p3, t, knots, out) {
  const [t0, t1, t2, t3] = knots;
  const lerp = (a, b, u) => a + (b - a) * u;
  const u1 = (t - t0) / (t1 - t0), u2 = (t - t1) / (t2 - t1), u3 = (t - t2) / (t3 - t2);
  const ax = lerp(p0.x, p1.x, u1), az = lerp(p0.z, p1.z, u1);
  const bx = lerp(p1.x, p2.x, u2), bz = lerp(p1.z, p2.z, u2);
  const cx = lerp(p2.x, p3.x, u3), cz = lerp(p2.z, p3.z, u3);
  const v1 = (t - t0) / (t2 - t0), v2 = (t - t1) / (t3 - t1);
  const mx = lerp(ax, bx, v1), mz = lerp(az, bz, v1);
  const nx = lerp(bx, cx, v2), nz = lerp(bz, cz, v2);
  const w = (t - t1) / (t2 - t1);
  out.x = lerp(mx, nx, w);
  out.z = lerp(mz, nz, w);
  return out;
}

function knotSeq(arr) {
  const k = [0];
  for (let i = 1; i < arr.length; i++) {
    const d = Math.hypot(arr[i].x - arr[i - 1].x, arr[i].z - arr[i - 1].z);
    k.push(k[i - 1] + Math.sqrt(Math.max(1e-4, d)));
  }
  return k;
}

/** Dense sample of the spline (correct knot interval), then resample at 1 m arc. */
function resampleByArc(pts, spacing = 1.0) {
  const n = pts.length;
  // Pad the ends by extrapolation so the first/last segments have 4 distinct points.
  const a = pts[0], b = pts[1], z1 = pts[n - 2], z2 = pts[n - 1];
  const arr = [{ x: 2 * a.x - b.x, z: 2 * a.z - b.z }, ...pts,
               { x: 2 * z2.x - z1.x, z: 2 * z2.z - z1.z }];
  const knots = knotSeq(arr);

  const dense = [];
  const tmp = { x: 0, z: 0 };
  for (let i = 1; i <= n - 1; i++) {
    const p0 = arr[i - 1], p1 = arr[i], p2 = arr[i + 1], p3 = arr[i + 2];
    const kn = [knots[i - 1], knots[i], knots[i + 1], knots[i + 2]];
    const steps = Math.max(3, Math.ceil((kn[2] - kn[1]) * 2));   // ~0.5 m dense spacing
    for (let k = 0; k < steps; k++) {
      const t = kn[1] + (kn[2] - kn[1]) * (k / steps);
      crSegment(p0, p1, p2, p3, t, kn, tmp);
      dense.push({ x: tmp.x, z: tmp.z });
    }
  }
  dense.push({ x: arr[n].x, z: arr[n].z });

  const out = [{ x: dense[0].x, z: dense[0].z, s: 0 }];
  let acc = 0, carry = 0;
  for (let i = 1; i < dense.length; i++) {
    const d = Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z);
    acc += d;
    carry += d;
    while (carry >= spacing) {
      const f = 1 - (carry - spacing) / d;
      out.push({
        x: dense[i - 1].x + (dense[i].x - dense[i - 1].x) * f,
        z: dense[i - 1].z + (dense[i].z - dense[i - 1].z) * f,
        s: out[out.length - 1].s + spacing,
      });
      carry -= spacing;
    }
  }
  return out;
}

/**
 * Build the stage road: geometry + attributes.
 * `terrainHeightAt(x,z)` is the analytic terrain height field (docs/03 §2) so the
 * road profile is decided before any chunk exists.
 */
export function buildRoad({ seed, lengthTarget = 3400, terrainHeightAt, biome = 'FOREST' }) {
  const rng = new Rng(seed ^ 0x2f9b3d7d);
  const control = walkRoad({ seed, lengthTarget, terrainHeightAt });
  const dense = resampleByArc(control, 1.0);
  const n = dense.length;

  const x = new Float32Array(n), z = new Float32Array(n), s = new Float32Array(n);
  const tx = new Float32Array(n), tz = new Float32Array(n);
  const nx = new Float32Array(n), nz = new Float32Array(n);
  const heading = new Float32Array(n), kappa = new Float32Array(n);
  const grade = new Float32Array(n), hRaw = new Float32Array(n), h = new Float32Array(n);
  const camber = new Float32Array(n), width = new Float32Array(n);
  const surfaceId = new Uint8Array(n), feature = new Uint8Array(n);

  for (let i = 0; i < n; i++) { x[i] = dense[i].x; z[i] = dense[i].z; s[i] = dense[i].s; }

  // Tangents / normals / heading.
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let dx = x[b] - x[a], dz = z[b] - z[a];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    tx[i] = dx; tz[i] = dz;
    // Left-hand normal (Y-up world: normal = up x tangent).
    nx[i] = -dz; nz[i] = dx;
    heading[i] = Math.atan2(dz, dx);
  }

  // Curvature from heading derivative (unwrapped).
  for (let i = 1; i < n - 1; i++) {
    let d = wrapPi(heading[i + 1] - heading[i - 1]);
    kappa[i] = d / (s[i + 1] - s[i - 1]);
  }
  kappa[0] = kappa[1] || 0;
  kappa[n - 1] = kappa[n - 2] || 0;

  // Guarantee a drivable corner radius: clamp curvature and rebuild the path from
  // the clamped heading. Hairpins stay tight (docs/03), cusps disappear.
  enforceMinRadius(x, z, s, heading, kappa, n, MIN_DRIVE_RADIUS);

  // Recompute tangents / normals / curvature from the rebuilt path.
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let dx = x[b] - x[a], dz = z[b] - z[a];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    tx[i] = dx; tz[i] = dz;
    nx[i] = -dz; nz[i] = dx;
    heading[i] = Math.atan2(dz, dx);
  }
  for (let i = 1; i < n - 1; i++) {
    let d = wrapPi(heading[i + 1] - heading[i - 1]);
    kappa[i] = d / (s[i + 1] - s[i - 1]);
  }
  kappa[0] = kappa[1] || 0;
  kappa[n - 1] = kappa[n - 2] || 0;

  // Raw terrain height along the centreline, then smoothed into a drivable profile.
  for (let i = 0; i < n; i++) hRaw[i] = terrainHeightAt(x[i], z[i]);
  smoothProfile(hRaw, h, n, 18, 3);
  // Clamp longitudinal gradient so the stage is never a rollercoaster.
  for (let i = 1; i < n; i++) {
    const dh = h[i] - h[i - 1];
    if (Math.abs(dh) > 0.16) h[i] = h[i - 1] + Math.sign(dh) * 0.16;
  }
  smoothProfile(h, h, n, 8, 2);
  for (let i = 0; i < n; i++) grade[i] = i < n - 1 ? (h[i + 1] - h[i]) : (h[i] - h[i - 1]);

  // Surface assignment in blocks along the arc (docs/03 §3 step 4).
  const surfSeq = pickSurfaces(biome, rng);
  let at = 0, surf = surfSeq[0].id, nextChange = surfSeq[0].len;
  for (let i = 0; i < n; i++) {
    if (s[i] >= nextChange && at < surfSeq.length - 1) { at++; surf = surfSeq[at].id; nextChange += surfSeq[at].len; }
    surfaceId[i] = surf;
    width[i] = surf === SURF.ASPHALT ? WIDTH_DEFAULT.asphalt : WIDTH_DEFAULT.gravel;
  }

  // Camber (docs/03 §3): lean into the corner.
  for (let i = 0; i < n; i++) {
    camber[i] = Math.max(-CAMBER_MAX, Math.min(CAMBER_MAX, -kappa[i] * CAMBER_GAIN));
  }

  // Explicit features (docs/03 §3).
  markFeatures({ s, h, grade, kappa, heading, feature, width, surfaceId, n, rng });

  const road = {
    seed, biome, control, n, length: s[n - 1],
    x, z, s, tx, tz, nx, nz, heading, kappa, grade, h, camber, width, surfaceId, feature,
    climate: stageClimate(seed, biome),
  };
  buildIndex(road);
  return road;
}

/**
 * Time of day + weather as a PROPERTY OF THE STAGE (PLAN §10.2: "Pora dnia i pogoda to
 * cechy odcinka (funkcja CMR 2.0), nie ustawienie gracza"). Drawn from a dedicated
 * seed fork, so it is deterministic (PLAN §8 #7) and cannot shift any road geometry
 * the ghost / pace notes were built on. Mostly bright day, sometimes overcast, rarely
 * dusk or rain - and the lighting rig, sky, fog and road wetness follow it.
 */
export const WEATHER = { CLEAR: 0, OVERCAST: 1, DUSK: 2, RAIN: 3 };
export const WEATHER_NAMES = ['CLEAR', 'OVERCAST', 'DUSK', 'RAIN'];
export function stageClimate(seed, biome = 'FOREST') {
  const rng = new Rng((seed ^ 0x9e3779b9) >>> 0);
  const roll = rng.next();
  let weather = WEATHER.CLEAR;
  if (roll > 0.965) weather = WEATHER.RAIN;
  else if (roll > 0.90) weather = WEATHER.DUSK;
  else if (roll > 0.68) weather = WEATHER.OVERCAST;
  // Time of day: bright morning-to-golden window is the default band (CMR stages are
  // daylight); dusk weather pushes it late, overcast keeps it high but flat.
  let tod;
  if (weather === WEATHER.DUSK) tod = 0.80 + rng.next() * 0.07;
  else if (weather === WEATHER.OVERCAST) tod = 0.42 + rng.next() * 0.22;
  else if (weather === WEATHER.RAIN) tod = 0.46 + rng.next() * 0.30;
  else tod = 0.34 + rng.next() * 0.36;
  const wet = weather === WEATHER.RAIN ? 0.55 + rng.next() * 0.25
    : weather === WEATHER.OVERCAST ? 0.12 : 0.0;
  return { tod, weather, weatherName: WEATHER_NAMES[weather], wet, haze: rng.range(0.85, 1.15) };
}

export const MIN_DRIVE_RADIUS = 9;   // m: no cusp tighter than this on a generated stage

/**
 * Clamp |curvature| to 1/MIN_DRIVE_RADIUS and rebuild the polyline by integrating
 * the clamped heading. Keeps the start point and the turn sequence; widens only
 * the corners that are too tight to drive.
 */
function enforceMinRadius(x, z, s, heading, kappa, n, minR) {
  const kmax = 1 / minR;
  let dirty = false;
  for (let i = 0; i < n; i++) {
    const c = Math.max(-kmax, Math.min(kmax, kappa[i]));
    if (c !== kappa[i]) dirty = true;
    kappa[i] = c;
  }
  if (!dirty) return false;
  let h = Math.atan2(z[1] - z[0], x[1] - x[0]);
  let px = x[0], pz = z[0];
  x[0] = px; z[0] = pz;
  for (let i = 1; i < n; i++) {
    const ds = s[i] - s[i - 1];
    px += Math.cos(h) * ds;
    pz += Math.sin(h) * ds;
    x[i] = px; z[i] = pz;
    h += kappa[i - 1] * ds;
  }
  return true;
}

/**
 * Checkpoint gates along the stage (docs/03 §4): start, gates every 900-1600 m,
 * finish. Deterministic from the stage seed.
 */
export function planCheckpoints(road, seed) {
  const rng = new Rng(seed ^ 0x1b873593);
  const gates = [{ arc: 0, kind: 'start' }];
  let arc = rng.range(900, 1600);
  let n = 1;
  while (arc < road.length - 500) {
    gates.push({ arc, kind: 'sector' });
    arc += rng.range(900, 1600);
    n++;
  }
  gates.push({ arc: road.length - 20, kind: 'finish' });
  for (const g of gates) g.index = road.indexAt(g.arc);
  return gates;
}

function smoothProfile(src, dst, n, window, passes) {  let a = src, b = dst;
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let k = -window; k <= window; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        const w = 1 - Math.abs(k) / (window + 1);
        sum += a[j] * w; cnt += w;
      }
      b[i] = sum / cnt;
    }
    const t = a; a = b; b = t;
  }
  if (a !== dst) dst.set(a);
}

function pickSurfaces(biome, rng) {
  const seq = [];
  const families = {
    FOREST: [SURF.GRAVEL, SURF.GRAVEL, SURF.DIRT, SURF.GRAVEL, SURF.MUD],
    MOUNTAIN: [SURF.GRAVEL, SURF.STONE, SURF.SNOW, SURF.GRAVEL],
    SWAMP: [SURF.MUD, SURF.PEAT, SURF.GRAVEL, SURF.MUD],
    PLATEAU: [SURF.ASPHALT, SURF.GRAVEL, SURF.ASPHALT, SURF.SAND],
    CANYON: [SURF.STONE, SURF.GRAVEL, SURF.MUD, SURF.ASPHALT],
  }[biome] || [SURF.GRAVEL];
  let remaining = 3400;
  while (remaining > 0) {
    const id = rng.pick(families);
    const len = rng.range(320, 900);
    seq.push({ id, len });
    remaining -= len;
  }
  return seq;
}

function markFeatures({ s, h, grade, kappa, feature, width, n, rng }) {
  // crest / dip: sign change of gradient over >= 20 m of run
  for (let i = 20; i < n - 20; i++) {
    const before = avg(grade, i - 18, i - 4);
    const after = avg(grade, i + 4, i + 18);
    if (before > 0.035 && after < -0.035 && feature[i] === FEATURE.NONE) feature[i] = FEATURE.CREST;
    else if (before < -0.035 && after > 0.035 && feature[i] === FEATURE.NONE) feature[i] = FEATURE.DIP;
  }
  // hairpin: |curvature| sustained over a tight radius
  for (let i = 5; i < n - 5; i++) {
    const R = 1 / Math.max(1e-4, Math.abs(kappa[i]));
    if (R < 22 && feature[i] === FEATURE.NONE) feature[i] = FEATURE.HAIRPIN;
  }
  // jump: explicit, rare, on a crest with a strong gradient change
  let jumps = 0;
  for (let i = 60; i < n - 60 && jumps < 2; i += 120) {
    if (feature[i] === FEATURE.CREST && Math.abs(grade[i]) > 0.05 && rng.next() < 0.5) {
      feature[i] = FEATURE.JUMP; jumps++;
      // landing strip flattens out for 25 m
      for (let k = 0; k < 25 && i + k < n; k++) width[i + k] = Math.max(width[i + k], 8.5);
    }
  }
  // chicane: three direction reversals within 120 m
  for (let i = 10; i < n - 130; i++) {
    let flips = 0, last = 0;
    for (let k = i; k < i + 120 && k < n; k++) {
      const sg = Math.sign(kappa[k]);
      if (Math.abs(kappa[k]) > 0.012 && sg !== 0 && last !== 0 && sg !== last) { flips++; last = sg; }
      else if (Math.abs(kappa[k]) > 0.012) last = sg;
    }
    if (flips >= 3) {
      for (let k = i; k < i + 120 && k < n; k++) if (feature[k] === FEATURE.NONE) feature[k] = FEATURE.CHICANE;
      i += 140;
    }
  }
  // narrow sections (bridge) on strong constrictions of the corridor
  for (let i = 30; i < n - 30; i++) {
    if (rng.next() < 0.0015) {
      feature[i] = FEATURE.BRIDGE;
      for (let k = -12; k <= 12; k++) if (i + k >= 0 && i + k < n) width[i + k] = WIDTH_NARROW;
      i += 40;
    }
  }
}
function avg(a, i0, i1) { let s = 0, c = 0; for (let i = i0; i <= i1; i++) { s += a[i]; c++; } return c ? s / c : 0; }

/** Arc -> index lookup (samples are 1 m apart, so this is a direct map, plus a
 * cached cursor for the monotonic reads the game does). */
export function buildIndex(road) {
  road.indexAt = function indexAt(arc) {
    if (arc <= 0) return 0;
    if (arc >= road.length) return road.n - 1;
    return Math.min(road.n - 1, Math.max(0, Math.round(arc)));
  };
  /** Nearest point on the road for a world position (coarse grid + local refine). */
  const CELL = 40;
  const grid = new Map();
  for (let i = 0; i < road.n; i++) {
    const k = Math.floor(road.x[i] / CELL) * 65536 + Math.floor(road.z[i] / CELL);
    let a = grid.get(k); if (!a) { a = []; grid.set(k, a); }
    a.push(i);
  }
  road.nearest = function nearest(px, pz, radiusCells = 2) {
    const gx = Math.floor(px / CELL), gz = Math.floor(pz / CELL);
    let best = -1, bestD = Infinity;
    for (let dz = -radiusCells; dz <= radiusCells; dz++) {
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const a = grid.get((gx + dx) * 65536 + (gz + dz));
        if (!a) continue;
        for (let j = 0; j < a.length; j++) {
          const i = a[j];
          const d = (road.x[i] - px) ** 2 + (road.z[i] - pz) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    return best < 0 ? 0 : best;
  };
  /** Signed lateral offset from the centreline (+ = left-hand normal side). */
  road.lateral = function lateral(px, pz) {
    const i = road.nearest(px, pz);
    return (px - road.x[i]) * road.nx[i] + (pz - road.z[i]) * road.nz[i];
  };
}
