// Seeded procedural rally stage generation. Pure module (no DOM/THREE):
// the same seed always produces the same heightfield, road, surfaces,
// props, corners and checkpoints, which the smoke tests rely on.

import { mulberry32, makeNoise2D, fbm, clamp, lerp, smoothstep } from '../core/rng.js';
import { SURFACE } from './tiles.js';

export const SIZE = 256; // world is SIZE x SIZE cells, 1 cell = 1 metre
export const ROAD_HALF = 4.4; // drivable half width

export const BIOMES = {
  forest: {
    name: 'Forest',
    amp: 15, detail: 2.2, rim: 20,
    roadSurface: SURFACE.GRAVEL,
    ground: SURFACE.GRASS,
    shoulder: SURFACE.DIRT,
    patchSurface: SURFACE.MUD, patchAmount: 0.16,
    treeTypes: ['pine', 'pine', 'round', 'round', 'pine'],
    treeCount: 900, rockCount: 130,
    sky: { top: 0x3a7bd5, horizon: 0xcfe8f7, fog: 0xcfe0ee, sun: 0xfff2d8 },
    groundTint: 0x69a84f,
  },
  desert: {
    name: 'Desert',
    amp: 8, detail: 1.4, rim: 14,
    roadSurface: SURFACE.DIRT,
    ground: SURFACE.SAND,
    shoulder: SURFACE.SAND,
    patchSurface: SURFACE.ROCK, patchAmount: 0.2,
    treeTypes: ['cactus', 'cactus', 'deadTree'],
    treeCount: 380, rockCount: 320,
    sky: { top: 0x2f6fd0, horizon: 0xf7e3bb, fog: 0xf2ddba, sun: 0xffe9b0 },
    groundTint: 0xe0be78,
  },
  snow: {
    name: 'Snow',
    amp: 12, detail: 1.8, rim: 18,
    roadSurface: SURFACE.PACKED_SNOW,
    ground: SURFACE.SNOW,
    shoulder: SURFACE.SNOW,
    patchSurface: SURFACE.SNOW, patchAmount: 0,
    treeTypes: ['snowPine', 'snowPine', 'snowPine', 'round'],
    treeCount: 800, rockCount: 110,
    sky: { top: 0x5f8fce, horizon: 0xe8f1fa, fog: 0xdfe9f2, sun: 0xffffff },
    groundTint: 0xf4f8fb,
  },
};

const LENGTH_STEPS = { short: 30, medium: 44, long: 62 };
const STEP_LEN = 13;

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  };
}

export function generateStage({ biome = 'forest', seed = 1, length = 'medium' } = {}) {
  const cfg = BIOMES[biome] ?? BIOMES.forest;
  const rng = mulberry32(seed * 7919 + 17);
  const noise = makeNoise2D(seed ^ 0x9e3779b9);
  const noise2 = makeNoise2D(seed ^ 0x51ed27);

  // --- Road centreline -----------------------------------------------------
  const steps = LENGTH_STEPS[length] ?? LENGTH_STEPS.medium;
  const ctrl = [];
  let px = SIZE / 2 + (rng() - 0.5) * 30;
  let pz = SIZE - 24;
  let heading = 0; // 0 = north (-z)
  ctrl.push({ x: px, z: pz });
  for (let i = 0; i < steps; i++) {
    // steer back toward the middle when drifting far out
    const toCx = SIZE / 2 - px, toCz = SIZE / 2 - pz;
    const distC = Math.hypot(toCx, toCz);
    const centreHeading = Math.atan2(toCx, -toCz);
    let diff = centreHeading - heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const bias = smoothstep(46, 92, distC) * 0.55;
    heading += diff * bias + (rng() - 0.5) * 0.86 * (1 - bias);
    heading = clamp(heading, -2.6, 2.6);
    px += Math.sin(heading) * STEP_LEN;
    pz += -Math.cos(heading) * STEP_LEN;
    px = clamp(px, 26, SIZE - 26);
    pz = clamp(pz, 26, SIZE - 26);
    ctrl.push({ x: px, z: pz });
  }

  // Resample the spline at ~1 m intervals.
  const path = [];
  const P = (i) => ctrl[clamp(i, 0, ctrl.length - 1)];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const segLen = Math.hypot(ctrl[i + 1].x - ctrl[i].x, ctrl[i + 1].z - ctrl[i].z);
    const n = Math.max(2, Math.round(segLen));
    for (let j = 0; j < n; j++) {
      path.push(catmullRom(P(i - 1), P(i), P(i + 1), P(i + 2), j / n));
    }
  }
  path.push({ ...ctrl[ctrl.length - 1] });

  // Per point distance / heading / curvature.
  let distAcc = 0;
  for (let i = 0; i < path.length; i++) {
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    if (i > 0) distAcc += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    path[i].dist = distAcc;
    path[i].heading = Math.atan2(next.x - prev.x, -(next.z - prev.z));
  }
  const totalLength = distAcc;
  const rawCurv = new Float32Array(path.length);
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 3)].heading;
    const b = path[Math.min(path.length - 1, i + 3)].heading;
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const span = Math.max(1, path[Math.min(path.length - 1, i + 3)].dist - path[Math.max(0, i - 3)].dist);
    rawCurv[i] = d / span;
  }
  // Smooth curvature (moving average, radius 6 points).
  const curv = new Float32Array(path.length);
  for (let i = 0; i < path.length; i++) {
    let s = 0, n = 0;
    for (let k = -6; k <= 6; k++) {
      const j = i + k;
      if (j >= 0 && j < path.length) { s += rawCurv[j]; n++; }
    }
    curv[i] = s / n;
    path[i].curv = curv[i];
  }

  // --- Raw terrain ----------------------------------------------------------
  const heights = new Float32Array(SIZE * SIZE);
  const rawAt = (x, z) => {
    const hills = (fbm(noise, x * 0.011, z * 0.011, 4) - 0.5) * 2 * cfg.amp;
    const detail = (fbm(noise2, x * 0.055, z * 0.055, 3) - 0.5) * 2 * cfg.detail;
    const dc = Math.hypot(x - SIZE / 2, z - SIZE / 2);
    const rim = smoothstep(96, 130, dc) * cfg.rim;
    return hills + detail + rim + 6;
  };
  for (let z = 0; z < SIZE; z++)
    for (let x = 0; x < SIZE; x++)
      heights[z * SIZE + x] = rawAt(x + 0.5, z + 0.5);

  // --- Road height profile: sampled, heavily smoothed, grade limited -------
  const prof = new Float64Array(path.length);
  for (let i = 0; i < path.length; i++) prof[i] = rawAt(path[i].x, path[i].z);
  for (let pass = 0; pass < 2; pass++) {
    const src = Float64Array.from(prof);
    const R = 26;
    for (let i = 0; i < path.length; i++) {
      let s = 0, n = 0;
      for (let k = -R; k <= R; k += 2) {
        const j = i + k;
        if (j >= 0 && j < path.length) { s += src[j]; n++; }
      }
      prof[i] = s / n;
    }
  }
  const MAX_GRADE = 0.14;
  for (let i = 1; i < path.length; i++)
    prof[i] = clamp(prof[i], prof[i - 1] - MAX_GRADE, prof[i - 1] + MAX_GRADE);
  for (let i = path.length - 2; i >= 0; i--)
    prof[i] = clamp(prof[i], prof[i + 1] - MAX_GRADE, prof[i + 1] + MAX_GRADE);
  for (let i = 0; i < path.length; i++) path[i].roadH = prof[i];

  // --- Path point buckets for nearest queries --------------------------------
  const BUCKET = 4;
  const BN = Math.ceil(SIZE / BUCKET);
  const buckets = new Map();
  for (let i = 0; i < path.length; i++) {
    const bx = Math.floor(path[i].x / BUCKET), bz = Math.floor(path[i].z / BUCKET);
    const key = bz * BN + bx;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  }
  function nearestPath(x, z, maxR = 18) {
    const bx = Math.floor(x / BUCKET), bz = Math.floor(z / BUCKET);
    let best = -1, bestD2 = maxR * maxR;
    const rings = Math.ceil(maxR / BUCKET);
    for (let rz = -rings; rz <= rings; rz++) {
      for (let rx = -rings; rx <= rings; rx++) {
        const arr = buckets.get((bz + rz) * BN + (bx + rx));
        if (!arr) continue;
        for (const i of arr) {
          const dx = path[i].x - x, dz = path[i].z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; best = i; }
        }
      }
    }
    return best < 0 ? null : { idx: best, d: Math.sqrt(bestD2) };
  }

  // --- Carve the road + assign surfaces --------------------------------------
  const surfaces = new Uint8Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const cx = x + 0.5, cz = z + 0.5;
      const idx = z * SIZE + x;
      const near = nearestPath(cx, cz, 16);
      const raw = heights[idx];
      if (near && near.d < 12) {
        const p = path[near.idx];
        const t = smoothstep(ROAD_HALF + 0.4, 11.5, near.d);
        heights[idx] = lerp(p.roadH, raw, t);
        // lateral offset for centre line painting
        const perpX = Math.cos(p.heading), perpZ = Math.sin(p.heading);
        const lat = (cx - p.x) * perpX + (cz - p.z) * perpZ;
        if (near.d <= ROAD_HALF) {
          const onStart = p.dist < 42 || p.dist > totalLength - 26;
          if (onStart) {
            surfaces[idx] = Math.abs(lat) < 0.55 && Math.floor(p.dist / 4) % 2 === 0
              ? SURFACE.TARMAC_LINE : SURFACE.TARMAC;
            if (near.d <= ROAD_HALF) heights[idx] = p.roadH;
          } else {
            surfaces[idx] = cfg.roadSurface;
            heights[idx] = p.roadH;
          }
        } else if (near.d <= ROAD_HALF + 1.3) {
          surfaces[idx] = cfg.shoulder;
        } else {
          surfaces[idx] = groundSurface(cx, cz, raw);
        }
      } else {
        surfaces[idx] = groundSurface(cx, cz, raw);
      }
    }
  }
  function groundSurface(x, z, h) {
    if (cfg.patchAmount > 0) {
      const n = fbm(noise2, x * 0.03 + 40, z * 0.03 + 40, 3);
      if (n > 1 - cfg.patchAmount) return cfg.patchSurface;
    }
    return cfg.ground;
  }

  // --- Corners (pace notes) ---------------------------------------------------
  const corners = [];
  {
    let i = 10;
    while (i < path.length - 6) {
      const c = curv[i];
      if (Math.abs(c) > 0.011) {
        let j = i, minR = Infinity, minIdx = i;
        while (j < path.length - 6 && Math.abs(curv[j]) > 0.008) {
          const r = 1 / Math.max(1e-5, Math.abs(curv[j]));
          if (r < minR) { minR = r; minIdx = j; }
          j++;
        }
        const sev = minR > 80 ? 6 : minR > 55 ? 5 : minR > 38 ? 4 : minR > 26 ? 3 : minR > 17 ? 2 : 1;
        corners.push({
          atDist: path[minIdx].dist,
          pathIdx: minIdx,
          dir: curv[minIdx] > 0 ? 'R' : 'L',
          severity: sev,
          radius: minR,
          x: path[minIdx].x, z: path[minIdx].z,
        });
        i = j + 14;
      } else i++;
    }
  }

  // --- Checkpoints --------------------------------------------------------------
  const cpSpacing = 140;
  const cpCount = Math.max(2, Math.round(totalLength / cpSpacing));
  const checkpoints = [];
  for (let k = 1; k < cpCount; k++) {
    const target = (totalLength / cpCount) * k;
    let idx = path.findIndex((p) => p.dist >= target);
    if (idx < 0) idx = path.length - 1;
    checkpoints.push({ dist: target, pathIdx: idx, x: path[idx].x, z: path[idx].z, heading: path[idx].heading });
  }

  // --- Props ----------------------------------------------------------------------
  const props = [];
  const addProp = (type, x, z, rot = 0, scale = 1, variant = 0) =>
    props.push({ type, x, z, rot, scale, variant });
  const slopeAt = (x, z) => {
    const h = heights[clamp(Math.floor(z), 0, SIZE - 1) * SIZE + clamp(Math.floor(x), 0, SIZE - 1)];
    const hx = heights[clamp(Math.floor(z), 0, SIZE - 1) * SIZE + clamp(Math.floor(x) + 1, 0, SIZE - 1)];
    const hz = heights[clamp(Math.floor(z) + 1, 0, SIZE - 1) * SIZE + clamp(Math.floor(x), 0, SIZE - 1)];
    return Math.max(Math.abs(hx - h), Math.abs(hz - h));
  };

  const prng = mulberry32(seed * 31 + 7);
  // Scatter vegetation / rocks away from the road.
  const scatter = (count, types, minD = 7.5, maxSlope = 1.1) => {
    for (let n = 0; n < count; n++) {
      const x = 4 + prng() * (SIZE - 8);
      const z = 4 + prng() * (SIZE - 8);
      const near = nearestPath(x, z, 15);
      if (near && near.d < minD) continue;
      if (slopeAt(x, z) > maxSlope) continue;
      addProp(types[Math.floor(prng() * types.length)], x, z, prng() * Math.PI * 2, 0.8 + prng() * 0.55, Math.floor(prng() * 4));
    }
  };
  scatter(cfg.treeCount, cfg.treeTypes);
  scatter(cfg.rockCount, ['rock'], 6.5, 2.2);

  // Houses in the forest, ruins of nothing in the desert, cabins in snow.
  const buildingType = biome === 'forest' ? 'house' : biome === 'snow' ? 'cabin' : 'barn';
  for (let n = 0; n < 4; n++) {
    const pi = 60 + Math.floor(prng() * (path.length - 160));
    const p = path[pi];
    const side = prng() > 0.5 ? 1 : -1;
    const lat = side * (12 + prng() * 9);
    const x = p.x + Math.cos(p.heading) * lat;
    const z = p.z + Math.sin(p.heading) * lat;
    if (x > 6 && x < SIZE - 6 && z > 6 && z < SIZE - 6)
      addProp(n === 0 ? buildingType : (prng() > 0.5 ? buildingType : 'barn'), x, z, p.heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, Math.floor(prng() * 3));
  }

  // Start / finish furniture.
  const p0 = path[2], pEnd = path[path.length - 3];
  addProp('gantry', p0.x, p0.z, p0.heading, 1, 0);
  addProp('gantry', pEnd.x, pEnd.z, pEnd.heading, 1, 1);
  for (const cp of checkpoints) addProp('banner', cp.x, cp.z, cp.heading, 1, 0);
  for (let n = 0; n < 3; n++) {
    const side = n % 2 === 0 ? 1 : -1;
    addProp('tent', p0.x + Math.cos(p0.heading) * side * (10 + n * 2), p0.z + Math.sin(p0.heading) * side * (10 + n * 2), p0.heading + prng(), 1, n);
  }
  addProp('van', p0.x + Math.cos(p0.heading) * -11, p0.z + Math.sin(p0.heading) * -11, p0.heading + 0.4, 1, 0);
  addProp('van', pEnd.x + Math.cos(pEnd.heading) * 11, pEnd.z + Math.sin(pEnd.heading) * 11, pEnd.heading - 0.5, 1, 1);

  // Corner dressing: chevron signs before, hay bales + spectators at apex.
  for (const c of corners) {
    if (c.severity <= 4) {
      const signIdx = Math.max(0, c.pathIdx - 26);
      const sp = path[signIdx];
      const outside = c.dir === 'R' ? -1 : 1;
      const lat = outside * 6.4;
      addProp(c.dir === 'R' ? 'signR' : 'signL', sp.x + Math.cos(sp.heading) * lat, sp.z + Math.sin(sp.heading) * lat, sp.heading, 1, c.severity);
    }
    if (c.severity <= 3) {
      const ap = path[c.pathIdx];
      const outside = c.dir === 'R' ? -1 : 1;
      for (let b = 0; b < 3; b++) {
        const idx = clamp(c.pathIdx - 4 + b * 4, 0, path.length - 1);
        const bp = path[idx];
        addProp('hay', bp.x + Math.cos(bp.heading) * outside * 6.1, bp.z + Math.sin(bp.heading) * outside * 6.1, prng() * 3, 1, 0);
      }
      const crowd = 3 + Math.floor(prng() * 4);
      for (let s = 0; s < crowd; s++) {
        const idx = clamp(c.pathIdx - 6 + Math.floor(prng() * 12), 0, path.length - 1);
        const cp2 = path[idx];
        const lat = outside * (8 + prng() * 3.5);
        addProp('person', cp2.x + Math.cos(cp2.heading) * lat + (prng() - 0.5) * 2, cp2.z + Math.sin(cp2.heading) * lat + (prng() - 0.5) * 2, cp2.heading + Math.PI, 1, Math.floor(prng() * 6));
      }
      void ap;
    }
  }

  // Fence runs along a few straights.
  for (let f = 0; f < 7; f++) {
    const startIdx = 40 + Math.floor(prng() * (path.length - 120));
    if (Math.abs(curv[startIdx]) > 0.01) continue;
    const side = prng() > 0.5 ? 1 : -1;
    for (let s = 0; s < 4; s++) {
      const p = path[startIdx + s * 7];
      addProp('fence', p.x + Math.cos(p.heading) * side * 6.3, p.z + Math.sin(p.heading) * side * 6.3, p.heading, 1, 0);
    }
  }

  // --- Sampling helpers ---------------------------------------------------------
  function groundHeight(x, z) {
    const gx = clamp(x - 0.5, 0, SIZE - 1.001);
    const gz = clamp(z - 0.5, 0, SIZE - 1.001);
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    const fx = gx - x0, fz = gz - z0;
    const i00 = z0 * SIZE + x0;
    const h00 = heights[i00], h10 = heights[i00 + 1];
    const h01 = heights[i00 + SIZE], h11 = heights[i00 + SIZE + 1];
    return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
  }
  function surfaceAt(x, z) {
    const cx = clamp(Math.floor(x), 0, SIZE - 1);
    const cz = clamp(Math.floor(z), 0, SIZE - 1);
    return surfaces[cz * SIZE + cx];
  }

  return {
    biome, seed, length, cfg,
    size: SIZE, heights, surfaces, path,
    totalLength, corners, checkpoints, props,
    startPose: { x: path[6].x, z: path[6].z, heading: path[6].heading },
    finishIdx: path.length - 4,
    groundHeight, surfaceAt, nearestPath,
  };
}
