// Stage generation: named rally stages with hand authored routes plus a
// free play random route generator. Pure module (no DOM/THREE).
//
// WORLD MODEL (v3): there is no fixed grid any more. A stage is a route
// (a 1 m sampled spline, kilometres long) plus analytic terrain: the
// ground height and surface at any (x, z) are computed on demand from
// seeded noise blended into the road profile near the route, and cached
// per 1 m column. The renderer streams detailed chunks in around the
// car, so stage length is no longer capped by a world box — that cap
// was the root cause of the old "every stage is ~400 m with 2
// checkpoints" bug (a 256 m box walk saturates, then the checkpoint
// count, derived from totalLength / 140, pinned at 2).

import { mulberry32, makeNoise2D, fbm, clamp, lerp, smoothstep } from '../core/rng.js';
import { SURFACE } from './tiles.js';

export const ROAD_HALF = 4.4; // drivable half width
export const CHUNK = 16;

// ---------------------------------------------------------------------------
// Environment configs (terrain + scenery character per biome / stage).
// ---------------------------------------------------------------------------

const ENV_FOREST = {
  amp: 15, detail: 2.2, freq: 0.011, detailFreq: 0.055,
  road: SURFACE.GRAVEL, ground: SURFACE.GRASS, shoulder: SURFACE.DIRT,
  patch: SURFACE.MUD, patchAmount: 0.16,
  trees: ['pine', 'pine', 'round', 'round', 'pine'], treePerKm: 650,
  rockPerKm: 90, tuftPerKm: 420, tuftType: 'tuft',
  building: 'house', buildings: 5,
  groundTint: 0x69a84f, rimH: 46,
  profileSmooth: 60, trend: 0, bankH: 0,
};

export const BIOMES = {
  forest: { name: 'Forest', tod: 'day', env: ENV_FOREST },
  desert: {
    name: 'Desert', tod: 'day',
    env: {
      amp: 8, detail: 1.4, freq: 0.009, detailFreq: 0.05,
      road: SURFACE.DIRT, ground: SURFACE.SAND, shoulder: SURFACE.SAND,
      patch: SURFACE.ROCK, patchAmount: 0.2,
      trees: ['cactus', 'cactus', 'deadTree'], treePerKm: 170,
      rockPerKm: 210, tuftPerKm: 0, tuftType: 'tuftDry',
      building: 'barn', buildings: 3,
      groundTint: 0xe0be78, rimH: 30,
      profileSmooth: 70, trend: 0, bankH: 0,
    },
  },
  snow: {
    name: 'Snow', tod: 'day',
    env: {
      amp: 12, detail: 1.8, freq: 0.011, detailFreq: 0.055,
      road: SURFACE.PACKED_SNOW, ground: SURFACE.SNOW, shoulder: SURFACE.SNOW,
      patch: SURFACE.SNOW, patchAmount: 0,
      trees: ['snowPine', 'snowPine', 'snowPine', 'round'], treePerKm: 560,
      rockPerKm: 70, tuftPerKm: 0, tuftType: 'tuft',
      building: 'cabin', buildings: 4,
      groundTint: 0xf4f8fb, rimH: 40,
      profileSmooth: 65, trend: 0, bankH: 0,
    },
  },
};

// ---------------------------------------------------------------------------
// The named stage roster: recreations of the classic Colin McRae Rally
// stages. Routes are authored as segment lists [length m, total heading
// change rad] (+ = right). The generator fits the spline length to the
// design target, so the character survives and the length is honest.
// ---------------------------------------------------------------------------

export const STAGES = [
  {
    id: 'wales', name: 'Sweet Lamb', country: 'Wales, UK',
    surface: 'Mud and gravel', note: 'Tight, slippery forest test. Rain grey light, puddles in the ruts.',
    lengthKm: 4.6, cpSpacing: 500, seed: 1201, tod: 'overcast', biomeKey: 'wales',
    env: {
      amp: 13, detail: 2.4, freq: 0.013, detailFreq: 0.06,
      road: SURFACE.GRAVEL, ground: SURFACE.GRASS, shoulder: SURFACE.MUD,
      patch: SURFACE.MUD, patchAmount: 0.24,
      trees: ['pine', 'pine', 'round', 'round'], treePerKm: 720,
      rockPerKm: 70, tuftPerKm: 380, tuftType: 'tuft',
      building: 'house', buildings: 3,
      groundTint: 0x5d9450, rimH: 42,
      profileSmooth: 55, trend: 0, bankH: 0,
    },
    plan: [
      { from: 0.18, to: 0.30, surface: SURFACE.MUD },
      { from: 0.52, to: 0.63, surface: SURFACE.MUD },
      { from: 0.78, to: 0.86, surface: SURFACE.MUD },
    ],
    puddles: true,
    route: [
      [140, 0], [90, -0.5], [70, 0.9], [120, -0.35], [60, 1.1], [80, -1.3], [150, 0.15], [55, -2.9],
      [90, 0.7], [65, -0.8], [110, 0.45], [75, 1.4], [130, -0.2], [60, -1.6], [85, 0.95], [150, -0.1],
      [70, 2.7], [95, -0.6], [120, 0.3], [55, -1.1], [80, 1.25], [140, 0], [65, -0.95], [100, 0.55],
      [75, -1.45], [125, 0.2], [90, 0.8], [60, -2.5], [110, -0.3], [85, 1.05], [145, 0.1], [70, -0.7],
      [105, 0.4], [160, 0], [95, -0.5], [70, 1.5], [120, 0.25], [58, -2.8], [88, 0.65], [135, -0.15],
      [72, 1.15], [98, -0.85], [150, 0.05], [80, 0],
    ],
  },
  {
    id: 'finland', name: 'Ouninpohja', country: 'Finland',
    surface: 'Fast gravel', note: 'Flat out over endless crests and jumps. Lakes between the pines.',
    lengthKm: 6.1, cpSpacing: 560, seed: 1202, tod: 'golden', biomeKey: 'finland',
    env: {
      amp: 11, detail: 1.9, freq: 0.010, detailFreq: 0.05,
      road: SURFACE.GRAVEL, ground: SURFACE.GRASS, shoulder: SURFACE.DIRT,
      patch: SURFACE.DIRT, patchAmount: 0.10,
      trees: ['pine', 'pine', 'pine', 'round'], treePerKm: 620,
      rockPerKm: 60, tuftPerKm: 460, tuftType: 'tuft',
      building: 'cabin', buildings: 4,
      groundTint: 0x6aa653, rimH: 34,
      profileSmooth: 26, trend: 0, bankH: 0,
    },
    lakes: true,
    route: [
      [300, 0.2], [240, -0.35], [280, 0.5], [190, -0.25], [330, 0.15], [220, 0.65], [260, -0.5],
      [200, 0.3], [290, -0.15], [240, 0.8], [310, -0.4], [180, 0.25], [270, 0.55], [230, -0.7],
      [300, 0.1], [210, -0.3], [250, 0.45], [280, -0.55], [195, 0.2], [320, -0.1], [235, 0.6],
      [265, -0.35], [205, 0.15], [290, 0],
    ],
  },
  {
    id: 'greece', name: 'Acropolis', country: 'Greece',
    surface: 'Rocky dirt', note: 'Rough mountain switchbacks in harsh sun. Car breaker rocks everywhere.',
    lengthKm: 4.6, cpSpacing: 460, seed: 1203, tod: 'day', biomeKey: 'greece',
    env: {
      amp: 21, detail: 2.6, freq: 0.012, detailFreq: 0.06,
      road: SURFACE.DIRT, ground: SURFACE.SCRUB, shoulder: SURFACE.ROCK,
      patch: SURFACE.ROCK, patchAmount: 0.22,
      trees: ['olive', 'olive', 'deadTree'], treePerKm: 130,
      rockPerKm: 280, tuftPerKm: 520, tuftType: 'tuftDry',
      building: 'house', buildings: 3,
      groundTint: 0x9a8f66, rimH: 70,
      profileSmooth: 48, trend: 0.006, bankH: 0,
    },
    route: [
      [120, 0.3], [70, 2.8], [95, -0.5], [65, -2.9], [110, 0.4], [80, 1.6], [60, -3.0], [130, -0.3],
      [75, 2.6], [90, -1.2], [55, 3.05], [140, 0.2], [85, -1.8], [70, 2.9], [115, -0.45], [65, -2.7],
      [100, 0.9], [60, 3.1], [125, -0.25], [80, -1.5], [70, 2.8], [105, 0.35], [58, -3.0], [135, 0.1],
      [88, 1.7], [72, -2.85], [118, -0.4], [66, 2.6], [95, -0.8], [145, 0], [130, 0.3], [75, -2.9],
      [95, 0.6], [62, 3.0], [120, -0.35], [85, 1.9], [68, -2.75], [110, 0.5], [58, 3.05], [128, -0.2],
      [78, -1.6], [105, 0.7], [140, -0.15], [90, 0],
    ],
  },
  {
    id: 'monte', name: 'Col de Turini', country: 'Monte Carlo',
    surface: 'Tarmac, ice patches', note: 'Hairpin stacks up a mountain pass. Ice hides on the shaded corners.',
    lengthKm: 3.6, cpSpacing: 450, seed: 1204, tod: 'day', biomeKey: 'monte',
    env: {
      amp: 24, detail: 2.2, freq: 0.012, detailFreq: 0.055,
      road: SURFACE.TARMAC, ground: SURFACE.GRASS, shoulder: SURFACE.DIRT,
      patch: SURFACE.SNOW, patchAmount: 0.10,
      trees: ['pine', 'round'], treePerKm: 380,
      rockPerKm: 120, tuftPerKm: 300, tuftType: 'tuft',
      building: 'house', buildings: 3,
      groundTint: 0x639552, rimH: 85,
      profileSmooth: 80, trend: 0.011, bankH: 0,
    },
    iceCorners: true,
    walls: [[0.10, 0.36], [0.50, 0.84]],
    route: [
      [110, 0.4], [55, 3.0], [80, -0.7], [50, -3.05], [95, 0.5], [60, 2.9], [70, -1.4], [48, -3.1],
      [105, -0.3], [58, 3.0], [85, 0.9], [52, -2.95], [90, -0.5], [64, 2.85], [75, 1.2], [50, -3.0],
      [120, 0.25], [68, -2.9], [88, 0.6], [54, 3.05], [100, -0.4], [62, -2.8], [78, 1.5], [52, 2.95],
      [115, 0], [70, -1.8], [95, 0.35], [58, -3.0], [85, -0.6], [130, 0], [95, 0.5], [56, 2.95],
      [82, -0.8], [50, -3.0], [108, 0.3], [60, 2.9], [72, -1.3], [52, -3.05], [118, -0.2], [66, 2.85],
      [90, 0.7], [55, -2.9], [125, 0],
    ],
  },
  {
    id: 'kenya', name: 'Safari', country: 'Kenya',
    surface: 'Red dirt', note: 'Very long, very fast, wide open savanna. Watch the washouts.',
    lengthKm: 7.2, cpSpacing: 620, seed: 1205, tod: 'golden', biomeKey: 'kenya',
    env: {
      amp: 7, detail: 1.6, freq: 0.008, detailFreq: 0.045,
      road: SURFACE.RED_DIRT, ground: SURFACE.DRY, shoulder: SURFACE.DRY,
      patch: SURFACE.SCRUB, patchAmount: 0.14,
      trees: ['acacia'], treePerKm: 55,
      rockPerKm: 55, tuftPerKm: 400, tuftType: 'tuftDry',
      building: 'barn', buildings: 2,
      groundTint: 0xb3a05e, rimH: 26,
      profileSmooth: 90, trend: 0, bankH: 0,
    },
    route: [
      [420, 0.1], [380, -0.2], [460, 0.3], [350, 0.05], [300, 1.1], [410, -0.25], [480, 0.15],
      [360, -0.4], [290, 0.9], [430, -0.1], [390, 0.35], [470, -0.2], [330, 0.55], [405, -0.3],
      [455, 0.12], [310, -0.85], [425, 0.2], [380, 0],
    ],
  },
  {
    id: 'sweden', name: 'Vargasen', country: 'Sweden',
    surface: 'Snow', note: 'Fast sweeping corners between snow banks. Lean on the banks, gently.',
    lengthKm: 5.6, cpSpacing: 530, seed: 1206, tod: 'day', biomeKey: 'sweden',
    env: {
      amp: 11, detail: 1.7, freq: 0.011, detailFreq: 0.05,
      road: SURFACE.PACKED_SNOW, ground: SURFACE.SNOW, shoulder: SURFACE.SNOW,
      patch: SURFACE.SNOW, patchAmount: 0,
      trees: ['snowPine', 'snowPine', 'pine'], treePerKm: 560,
      rockPerKm: 50, tuftPerKm: 0, tuftType: 'tuft',
      building: 'cabin', buildings: 4,
      groundTint: 0xf4f8fb, rimH: 38,
      profileSmooth: 70, trend: 0, bankH: 0.85,
    },
    route: [
      [230, 0.4], [190, -0.6], [260, 0.3], [170, -0.9], [240, 0.55], [205, -0.35], [280, 0.7],
      [185, -0.5], [225, 0.25], [265, -0.75], [195, 0.45], [250, -0.3], [215, 0.85], [175, -0.55],
      [290, 0.2], [240, -0.65], [200, 0.5], [255, -0.25], [220, 0.4], [270, -0.5], [190, 0.3], [235, 0],
    ],
  },
  {
    id: 'australia', name: 'Mineshaft', country: 'Australia',
    surface: 'Red gravel', note: 'Ball bearing gravel over crests, one famous big jump. Eucalyptus everywhere.',
    lengthKm: 4.4, cpSpacing: 490, seed: 1207, tod: 'day', biomeKey: 'australia',
    env: {
      amp: 12, detail: 2.0, freq: 0.011, detailFreq: 0.055,
      road: SURFACE.RED_DIRT, ground: SURFACE.DRY, shoulder: SURFACE.RED_DIRT,
      patch: SURFACE.SCRUB, patchAmount: 0.16,
      trees: ['eucalypt', 'eucalypt', 'deadTree'], treePerKm: 250,
      rockPerKm: 90, tuftPerKm: 430, tuftType: 'tuftDry',
      building: 'barn', buildings: 2,
      groundTint: 0xa89a5e, rimH: 36,
      profileSmooth: 34, trend: 0, bankH: 0,
    },
    route: [
      [210, 0.3], [160, -0.7], [190, 1.1], [140, -0.4], [230, 0.2], [150, 1.8], [180, -0.9],
      [205, 0.5], [165, -1.2], [240, -0.15], [175, 0.8], [145, -1.7], [215, 0.35], [155, -0.6],
      [195, 1.0], [170, -0.3], [225, -0.75], [185, 0.45], [150, 1.4], [200, -0.2], [160, 0.6], [210, 0],
    ],
  },
  {
    id: 'nz', name: 'Whaanga Coast', country: 'New Zealand',
    surface: 'Cambered gravel', note: 'Flowing, cambered, endlessly smooth. Green hills to the sea.',
    lengthKm: 4.8, cpSpacing: 500, seed: 1208, tod: 'day', biomeKey: 'nz',
    env: {
      amp: 16, detail: 2.0, freq: 0.010, detailFreq: 0.05,
      road: SURFACE.GRAVEL, ground: SURFACE.GRASS, shoulder: SURFACE.DIRT,
      patch: SURFACE.GRASS, patchAmount: 0,
      trees: ['pine', 'round', 'round'], treePerKm: 520,
      rockPerKm: 60, tuftPerKm: 480, tuftType: 'tuft',
      building: 'house', buildings: 4,
      groundTint: 0x5f9e4c, rimH: 52,
      profileSmooth: 75, trend: 0, bankH: 0,
    },
    route: [
      [240, 0.5], [200, -0.65], [260, 0.4], [180, -0.85], [230, 0.7], [210, -0.45], [270, 0.3],
      [190, -0.95], [250, 0.6], [205, -0.35], [235, 0.8], [175, -0.55], [265, -0.25], [215, 0.5],
      [195, -0.75], [255, 0.35], [185, -0.5], [245, 0.65], [200, -0.3], [230, 0],
    ],
  },
];

export const stageById = (id) => STAGES.find((s) => s.id === id) ?? null;

const LENGTH_TARGETS = { short: 2400, medium: 4000, long: 6000 };

// ---------------------------------------------------------------------------
// Route construction.
// ---------------------------------------------------------------------------

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  };
}

// Walk an authored segment list into spline control points (~19 m apart).
// Heading change is eased across each segment (curvature ramps in/out).
function controlPointsFromSegments(segments) {
  const ctrl = [{ x: 0, z: 0 }];
  let x = 0, z = 0, heading = 0;
  for (const [len, curve] of segments) {
    const n = Math.max(1, Math.round(len / 19));
    const stepLen = len / n;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      heading += (curve * (6 * t * (1 - t))) / n;
      x += Math.sin(heading) * stepLen;
      z += -Math.cos(heading) * stepLen;
      ctrl.push({ x, z });
    }
  }
  return ctrl;
}

// Random walk route for free play (open plane, no box to fold into).
function controlPointsRandom(rng, approxLen) {
  const ctrl = [{ x: 0, z: 0 }];
  let x = 0, z = 0, heading = 0;
  const steps = Math.round(approxLen / 19);
  for (let i = 0; i < steps; i++) {
    heading += (rng() - 0.5) * 0.34;
    heading = clamp(heading, -2.8, 2.8);
    x += Math.sin(heading) * 19;
    z += -Math.cos(heading) * 19;
    ctrl.push({ x, z });
  }
  return ctrl;
}

function resamplePath(ctrl) {
  const path = [];
  const P = (i) => ctrl[clamp(i, 0, ctrl.length - 1)];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const segLen = Math.hypot(ctrl[i + 1].x - ctrl[i].x, ctrl[i + 1].z - ctrl[i].z);
    const n = Math.max(2, Math.round(segLen));
    for (let j = 0; j < n; j++) path.push(catmullRom(P(i - 1), P(i), P(i + 1), P(i + 2), j / n));
  }
  path.push({ ...ctrl[ctrl.length - 1] });
  let distAcc = 0;
  for (let i = 0; i < path.length; i++) {
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    if (i > 0) distAcc += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    path[i].dist = distAcc;
    path[i].heading = Math.atan2(next.x - prev.x, -(next.z - prev.z));
  }
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
  return { path, totalLength: distAcc };
}

// ---------------------------------------------------------------------------
// Stage generation.
// ---------------------------------------------------------------------------

export function generateStage(opts = {}) {
  const def = opts.stageId ? stageById(opts.stageId) : null;
  const biomeKey = def ? def.biomeKey : (opts.biome ?? 'forest');
  const biomeDef = BIOMES[opts.biome ?? 'forest'] ?? BIOMES.forest;
  const env = def ? def.env : biomeDef.env;
  const seed = def ? def.seed : (opts.seed ?? 1);
  const tod = def ? def.tod : biomeDef.tod;
  const rng = mulberry32(seed * 7919 + 17);
  const noise = makeNoise2D(seed ^ 0x9e3779b9);
  const noise2 = makeNoise2D((seed ^ 0x51ed27) >>> 0);

  // --- Route ----------------------------------------------------------------
  const targetLen = def ? def.lengthKm * 1000 : (LENGTH_TARGETS[opts.length ?? 'medium'] ?? 4000);
  let ctrl = def ? controlPointsFromSegments(def.route) : controlPointsRandom(rng, targetLen);
  let { path, totalLength } = resamplePath(ctrl);
  if (Math.abs(totalLength - targetLen) / targetLen > 0.015) {
    const scale = targetLen / totalLength;
    if (def) {
      ctrl = controlPointsFromSegments(def.route.map(([l, c]) => [l * scale, c]));
    } else {
      ctrl = ctrl.map((p, i) => i === 0 ? p : { x: ctrl[0].x + (p.x - ctrl[0].x) * scale, z: ctrl[0].z + (p.z - ctrl[0].z) * scale });
    }
    ({ path, totalLength } = resamplePath(ctrl));
  }

  // --- Path buckets for nearest queries --------------------------------------
  const BUCKET = 8;
  const buckets = new Map();
  const bKey = (bx, bz) => (bx + 2048) * 8192 + (bz + 2048);
  for (let i = 0; i < path.length; i++) {
    const key = bKey(Math.floor(path[i].x / BUCKET), Math.floor(path[i].z / BUCKET));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  }
  function nearestPath(x, z, maxR = 18) {
    const bx = Math.floor(x / BUCKET), bz = Math.floor(z / BUCKET);
    let best = -1, bestD2 = maxR * maxR;
    const rings = Math.ceil(maxR / BUCKET);
    for (let rz = -rings; rz <= rings; rz++) {
      for (let rx = -rings; rx <= rings; rx++) {
        const arr = buckets.get(bKey(bx + rx, bz + rz));
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

  // --- Coarse distance-to-road grid (chamfer) for cheap far queries ---------
  const DG_CELL = 20, DG_MARGIN = 900;
  let dgMinX = Infinity, dgMinZ = Infinity, dgMaxX = -Infinity, dgMaxZ = -Infinity;
  for (const p of path) {
    dgMinX = Math.min(dgMinX, p.x); dgMaxX = Math.max(dgMaxX, p.x);
    dgMinZ = Math.min(dgMinZ, p.z); dgMaxZ = Math.max(dgMaxZ, p.z);
  }
  dgMinX -= DG_MARGIN; dgMinZ -= DG_MARGIN; dgMaxX += DG_MARGIN; dgMaxZ += DG_MARGIN;
  const dgW = Math.ceil((dgMaxX - dgMinX) / DG_CELL) + 1;
  const dgH = Math.ceil((dgMaxZ - dgMinZ) / DG_CELL) + 1;
  const dg = new Float32Array(dgW * dgH).fill(Infinity);
  for (const p of path) {
    const gx = Math.round((p.x - dgMinX) / DG_CELL), gz = Math.round((p.z - dgMinZ) / DG_CELL);
    dg[gz * dgW + gx] = 0;
  }
  {
    const D1 = DG_CELL, D2 = DG_CELL * Math.SQRT2;
    for (let z = 0; z < dgH; z++) for (let x = 0; x < dgW; x++) {
      const i = z * dgW + x; let v = dg[i];
      if (x > 0) v = Math.min(v, dg[i - 1] + D1);
      if (z > 0) v = Math.min(v, dg[i - dgW] + D1);
      if (x > 0 && z > 0) v = Math.min(v, dg[i - dgW - 1] + D2);
      if (x < dgW - 1 && z > 0) v = Math.min(v, dg[i - dgW + 1] + D2);
      dg[i] = v;
    }
    for (let z = dgH - 1; z >= 0; z--) for (let x = dgW - 1; x >= 0; x--) {
      const i = z * dgW + x; let v = dg[i];
      if (x < dgW - 1) v = Math.min(v, dg[i + 1] + D1);
      if (z < dgH - 1) v = Math.min(v, dg[i + dgW] + D1);
      if (x < dgW - 1 && z < dgH - 1) v = Math.min(v, dg[i + dgW + 1] + D2);
      if (x > 0 && z < dgH - 1) v = Math.min(v, dg[i + dgW - 1] + D2);
      dg[i] = v;
    }
  }
  function distToRoad(x, z) {
    const gx = (x - dgMinX) / DG_CELL, gz = (z - dgMinZ) / DG_CELL;
    if (gx < 0 || gz < 0 || gx > dgW - 1 || gz > dgH - 1) return 9999;
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    const fx = gx - x0, fz = gz - z0;
    const i = z0 * dgW + x0;
    const a = dg[i], b = dg[Math.min(i + 1, dg.length - 1)];
    const c = dg[Math.min(i + dgW, dg.length - 1)], d = dg[Math.min(i + dgW + 1, dg.length - 1)];
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
  }

  // Nearest path point labels per coarse grid cell (multi source BFS).
  // Lets heightAt follow the road's broad elevation trend well beyond
  // the precise 15 m bucket search radius.
  const dgLabel = new Int32Array(dgW * dgH).fill(-1);
  {
    const queue = [];
    for (let i = 0; i < path.length; i++) {
      const gx = Math.round((path[i].x - dgMinX) / DG_CELL), gz = Math.round((path[i].z - dgMinZ) / DG_CELL);
      const cell = gz * dgW + gx;
      if (dgLabel[cell] < 0) { dgLabel[cell] = i; queue.push(cell); }
    }
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head];
      const cx = cell % dgW, cz = Math.floor(cell / dgW);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= dgW || nz >= dgH) continue;
          const nCell = nz * dgW + nx;
          if (dgLabel[nCell] < 0) { dgLabel[nCell] = dgLabel[cell]; queue.push(nCell); }
        }
      }
    }
  }
  function labelAt(x, z) {
    const gx = Math.round((x - dgMinX) / DG_CELL), gz = Math.round((z - dgMinZ) / DG_CELL);
    if (gx < 0 || gz < 0 || gx >= dgW || gz >= dgH) return -1;
    return dgLabel[gz * dgW + gx];
  }

  // --- Lakes (Finland): positions fixed before terrain is sampled ----------
  const lakes = [];
  if (def?.lakes) {
    const lrng = mulberry32(seed * 131 + 5);
    for (const frac of [0.30, 0.66]) {
      const p = path[Math.floor(path.length * frac)];
      const side = lrng() > 0.5 ? 1 : -1;
      const lat = side * (68 + lrng() * 30);
      lakes.push({
        x: p.x + Math.cos(p.heading) * lat,
        z: p.z + Math.sin(p.heading) * lat,
        r: 36 + lrng() * 14, depth: 3.0,
      });
    }
  }

  // --- Terrain ---------------------------------------------------------------
  function rawTerrain(x, z) {
    const hills = (fbm(noise, x * env.freq, z * env.freq, 4) - 0.5) * 2 * env.amp;
    const detail = (fbm(noise2, x * env.detailFreq, z * env.detailFreq, 3) - 0.5) * 2 * env.detail;
    let h = hills + detail + 6;
    for (const L of lakes) {
      const dx = x - L.x, dz = z - L.z;
      h -= L.depth * Math.exp(-((dx * dx + dz * dz) / (L.r * L.r)) * 1.6);
    }
    return h;
  }

  // Road height profile: sampled, smoothed, trend added, grade limited.
  const prof = new Float64Array(path.length);
  for (let i = 0; i < path.length; i++) { prof[i] = rawTerrain(path[i].x, path[i].z); path[i].rawH = prof[i]; }
  {
    const R = Math.max(6, Math.round(env.profileSmooth));
    for (let pass = 0; pass < 2; pass++) {
      const src = Float64Array.from(prof);
      for (let i = 0; i < path.length; i++) {
        let s = 0, n = 0;
        for (let k = -R; k <= R; k += 2) {
          const j = i + k;
          if (j >= 0 && j < path.length) { s += src[j]; n++; }
        }
        prof[i] = s / n;
      }
    }
    for (let i = 0; i < path.length; i++) prof[i] += env.trend * path[i].dist;
    const MAX_GRADE = 0.16;
    for (let i = 1; i < path.length; i++)
      prof[i] = clamp(prof[i], prof[i - 1] - MAX_GRADE, prof[i - 1] + MAX_GRADE);
    for (let i = path.length - 2; i >= 0; i--)
      prof[i] = clamp(prof[i], prof[i + 1] - MAX_GRADE, prof[i + 1] + MAX_GRADE);
    for (let i = 0; i < path.length; i++) path[i].roadH = prof[i];
  }

  function heightAt(x, z) {
    const dGrid = distToRoad(x, z);
    if (dGrid > 130) return rawTerrain(x, z);
    const raw = rawTerrain(x, z);
    // Precise zone: exact nearest path point.
    if (dGrid <= 24) {
      const near = nearestPath(x, z, 15);
      if (near) {
        const p = path[near.idx];
        // Terrain follows the road's broad elevation: the raw noise
        // deviation from its value AT the road grows in over ~90 m,
        // so mountainsides climb with the pass instead of forming
        // sheer independent noise walls beside the road.
        const s = smoothstep(ROAD_HALF + 0.5, 95, near.d);
        let h = p.roadH + (raw - p.rawH) * s;
        if (env.bankH > 0) {
          const bd = near.d - (ROAD_HALF + 0.15);
          if (bd > 0 && bd < 3.4) {
            const bank = Math.sin((bd / 3.4) * Math.PI) * env.bankH;
            h = Math.max(h, p.roadH + bank - 0.05);
          }
        }
        return h;
      }
    }
    // Coarse zone: nearest path point from the BFS label grid.
    const li = labelAt(x, z);
    if (li < 0) return raw;
    const p = path[li];
    const s = smoothstep(ROAD_HALF + 0.5, 95, Math.max(dGrid, 16));
    return p.roadH + (raw - p.rawH) * s;
  }

  function groundSurface(x, z) {
    if (env.patchAmount > 0) {
      const n = fbm(noise2, x * 0.03 + 40, z * 0.03 + 40, 3);
      if (n > 1 - env.patchAmount) return env.patch;
    }
    return env.ground;
  }

  // --- Corners (pace notes) ---------------------------------------------------
  // Thresholds are low: the authored flowing stages (Finland, Kenya)
  // have genuine radius 200-600 m corners that a rally co driver still
  // calls as 5s and 6s. A candidate region must also accumulate a real
  // heading change so spline noise on straights stays silent.
  const corners = [];
  {
    let i = 10;
    while (i < path.length - 6) {
      const c = path[i].curv;
      if (Math.abs(c) > 0.0022) {
        let j = i, minR = Infinity, minIdx = i, turn = 0;
        while (j < path.length - 6 && Math.abs(path[j].curv) > 0.0016) {
          const r = 1 / Math.max(1e-5, Math.abs(path[j].curv));
          if (r < minR) { minR = r; minIdx = j; }
          turn += Math.abs(path[j].curv) * Math.max(0.2, (path[Math.min(j + 1, path.length - 1)].dist - path[j].dist));
          j++;
        }
        if (turn > 0.07) {
          const sev = minR > 250 ? 6 : minR > 140 ? 5 : minR > 90 ? 4 : minR > 55 ? 3 : minR > 32 ? 2 : 1;
          corners.push({
            atDist: path[minIdx].dist, pathIdx: minIdx,
            dir: path[minIdx].curv > 0 ? 'R' : 'L', severity: sev, radius: minR,
            x: path[minIdx].x, z: path[minIdx].z,
          });
        }
        i = Math.max(j + 10, i + 1);
      } else i++;
    }
  }

  // --- Per point road surface (surface plan + ice on shaded corners) ---------
  const pathSurf = new Uint8Array(path.length).fill(env.road);
  if (def?.plan) {
    for (const seg of def.plan) {
      for (let i = 0; i < path.length; i++) {
        const f = path[i].dist / totalLength;
        if (f >= seg.from && f < seg.to) pathSurf[i] = seg.surface;
      }
    }
  }
  if (def?.iceCorners) {
    for (const c of corners) {
      if (c.severity > 3) continue;
      for (let i = 0; i < path.length; i++) {
        if (path[i].dist >= c.atDist - 18 && path[i].dist <= c.atDist + 30) pathSurf[i] = SURFACE.ICE;
      }
    }
  }

  function surfaceAt(x, z) {
    if (distToRoad(x, z) > 12) return groundSurface(x, z);
    const near = nearestPath(x, z, 19);
    if (!near || near.d > ROAD_HALF + 1.5) return groundSurface(x, z);
    const p = path[near.idx];
    if (near.d <= ROAD_HALF) {
      if (p.dist < 42 || p.dist > totalLength - 26) {
        // Start / finish apron: tarmac on hard stages. On snow stages
        // the apron stays packed snow (black asphalt in the snow
        // looked wrong); the gantry marks the line instead.
        if (env.road === SURFACE.PACKED_SNOW) return SURFACE.PACKED_SNOW;
        const lat = (x - p.x) * Math.cos(p.heading) + (z - p.z) * Math.sin(p.heading);
        return Math.abs(lat) < 0.55 && Math.floor(p.dist / 4) % 2 === 0 ? SURFACE.TARMAC_LINE : SURFACE.TARMAC;
      }
      return pathSurf[near.idx];
    }
    return env.shoulder;
  }

  // --- Column cache: the single source for mesher + physics ------------------
  const colCache = new Map();
  function columnAt(cx, cz) {
    const key = (cx + 8192) * 16384 + (cz + 8192);
    let col = colCache.get(key);
    if (col) return col;
    col = { h: heightAt(cx + 0.5, cz + 0.5), s: surfaceAt(cx + 0.5, cz + 0.5) };
    if (colCache.size > 1200000) colCache.clear();
    colCache.set(key, col);
    return col;
  }
  function groundHeight(x, z) {
    const gx = x - 0.5, gz = z - 0.5;
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    const fx = gx - x0, fz = gz - z0;
    const h00 = columnAt(x0, z0).h, h10 = columnAt(x0 + 1, z0).h;
    const h01 = columnAt(x0, z0 + 1).h, h11 = columnAt(x0 + 1, z0 + 1).h;
    return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
  }

  // --- Checkpoints --------------------------------------------------------------
  const cpTarget = def ? def.cpSpacing : 520;
  const cpSegs = Math.max(5, Math.round(totalLength / cpTarget));
  const checkpoints = [];
  for (let k = 1; k < cpSegs; k++) {
    const target = (totalLength / cpSegs) * k;
    let idx = path.findIndex((p) => p.dist >= target);
    if (idx < 0) idx = path.length - 1;
    checkpoints.push({ dist: target, pathIdx: idx, x: path[idx].x, z: path[idx].z, heading: path[idx].heading });
  }

  // --- Props ----------------------------------------------------------------------
  const props = [];
  const addProp = (type, x, z, rot = 0, scale = 1, variant = 0, extra = null) => {
    const p = { type, x, z, rot, scale, variant };
    if (extra) Object.assign(p, extra);
    props.push(p);
  };
  const prng = mulberry32(seed * 31 + 7);
  const slopeAt = (x, z) => {
    const h = heightAt(x, z);
    return Math.max(Math.abs(heightAt(x + 1.5, z) - h), Math.abs(heightAt(x, z + 1.5) - h));
  };
  const perp = (p, lat) => ({ x: p.x + Math.cos(p.heading) * lat, z: p.z + Math.sin(p.heading) * lat });

  // Scatter along the corridor: random path point + lateral band.
  const scatterAlong = (count, types, latMin, latMax, maxSlope = 1.15) => {
    for (let n = 0; n < count; n++) {
      const p = path[Math.floor(prng() * path.length)];
      const side = prng() > 0.5 ? 1 : -1;
      const lat = side * (latMin + prng() * (latMax - latMin));
      const pos = perp(p, lat);
      pos.x += (prng() - 0.5) * 6; pos.z += (prng() - 0.5) * 6;
      if (distToRoad(pos.x, pos.z) < latMin * 0.75) continue;
      if (slopeAt(pos.x, pos.z) > maxSlope) continue;
      addProp(types[Math.floor(prng() * types.length)], pos.x, pos.z, prng() * Math.PI * 2, 0.8 + prng() * 0.55, Math.floor(prng() * 4));
    }
  };
  const km = totalLength / 1000;
  scatterAlong(Math.round(env.treePerKm * km), env.trees, 7.5, 120);
  scatterAlong(Math.round(env.treePerKm * km * 0.35), env.trees, 120, 210, 1.5);
  scatterAlong(Math.round(env.rockPerKm * km), ['rock'], 6.5, 90, 2.4);
  if (env.tuftPerKm > 0) scatterAlong(Math.round(env.tuftPerKm * km), [env.tuftType], 5.6, 15, 1.4);

  // Lakes.
  for (const L of lakes) addProp('lake', L.x, L.z, 0, L.r / 24, 0, { y: heightAt(L.x, L.z) + 0.95 });

  // Wales puddles on the road itself.
  if (def?.puddles) {
    for (let n = 0; n < 16; n++) {
      const p = path[60 + Math.floor(prng() * (path.length - 140))];
      const lat = (prng() - 0.5) * 3.6;
      const pos = perp(p, lat);
      addProp('puddle', pos.x, pos.z, p.heading, 0.8 + prng() * 0.7, 0, { y: p.roadH + 0.16 });
    }
  }

  // Buildings dotted along the route.
  for (let n = 0; n < env.buildings; n++) {
    const p = path[80 + Math.floor(prng() * (path.length - 200))];
    const side = prng() > 0.5 ? 1 : -1;
    const pos = perp(p, side * (13 + prng() * 11));
    if (distToRoad(pos.x, pos.z) > 9)
      addProp(prng() > 0.35 ? env.building : 'barn', pos.x, pos.z, p.heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, Math.floor(prng() * 3));
  }

  // Monte Carlo stone walls along the exposed stretches.
  if (def?.walls) {
    for (const [f0, f1] of def.walls) {
      const i0 = Math.floor(path.length * f0), i1 = Math.floor(path.length * f1);
      for (let i = i0; i < i1; i += 7) {
        const p = path[i];
        for (const side of [-1, 1]) {
          const pos = perp(p, side * (ROAD_HALF + 1.15));
          addProp('wallSeg', pos.x, pos.z, p.heading, 1, 0, { len: 7.6 });
        }
      }
    }
  }

  // Start / finish furniture.
  const p0 = path[2], pEnd = path[path.length - 3];
  addProp('gantry', p0.x, p0.z, p0.heading, 1, 0);
  addProp('gantry', pEnd.x, pEnd.z, pEnd.heading, 1, 1);
  for (const cp of checkpoints) addProp('banner', cp.x, cp.z, cp.heading, 1, 0);
  for (let n = 0; n < 3; n++) {
    const side = n % 2 === 0 ? 1 : -1;
    const pos = perp(p0, side * (10 + n * 2.5));
    addProp('tent', pos.x, pos.z, p0.heading + prng(), 1, n);
    const posE = perp(pEnd, -side * (10 + n * 2.5));
    if (n < 2) addProp('tent', posE.x, posE.z, pEnd.heading + prng(), 1, n + 1);
  }
  addProp('van', ...(() => { const q = perp(p0, -11); return [q.x, q.z]; })(), p0.heading + 0.4, 1, 0);
  addProp('van', ...(() => { const q = perp(pEnd, 11); return [q.x, q.z]; })(), pEnd.heading - 0.5, 1, 1);
  for (let n = 0; n < 3; n++) {
    const pos = perp(p0, (n - 1) * 7 + (n === 1 ? 13 : -13));
    addProp('parkedCar', pos.x, pos.z, p0.heading + (prng() - 0.5) * 0.7, 1, Math.floor(prng() * 5));
  }
  for (const [pp, lat] of [[p0, 7.5], [p0, -7.5], [pEnd, 7.5]]) {
    const pos = perp(pp, lat);
    addProp('marshal', pos.x, pos.z, pp.heading + Math.PI, 1, 0);
  }
  addProp('board', ...(() => { const q = perp(p0, 8.6); return [q.x, q.z]; })(), p0.heading, 1, 0);
  addProp('board', ...(() => { const q = perp(pEnd, -8.6); return [q.x, q.z]; })(), pEnd.heading, 1, 0);

  // Corner dressing: chevron signs, red/white posts + rally tape on the
  // outside, hay bales, spectators and marshals at the hard corners.
  for (const c of corners) {
    const outside = c.dir === 'R' ? -1 : 1;
    if (c.severity <= 4) {
      const sp = path[Math.max(0, c.pathIdx - 26)];
      const pos = perp(sp, outside * 6.4);
      addProp(c.dir === 'R' ? 'signR' : 'signL', pos.x, pos.z, sp.heading, 1, c.severity);
      // Posts + tape run.
      const postPts = [];
      for (let i = c.pathIdx - 32; i <= c.pathIdx + 14; i += 7) {
        const pp = path[clamp(i, 0, path.length - 1)];
        const q = perp(pp, outside * (ROAD_HALF + 0.85));
        postPts.push(q);
        addProp('post', q.x, q.z, pp.heading, 1, 0);
      }
      for (let i = 1; i < postPts.length; i++) {
        const a = postPts[i - 1], b = postPts[i];
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const hd = Math.atan2(b.x - a.x, -(b.z - a.z));
        addProp('tapeSeg', mx, mz, hd, 1, 0, { len });
      }
    }
    if (c.severity <= 3) {
      for (let b = 0; b < 3; b++) {
        const bp = path[clamp(c.pathIdx - 4 + b * 4, 0, path.length - 1)];
        const pos = perp(bp, outside * 6.1);
        addProp('hay', pos.x, pos.z, prng() * 3, 1, 0);
      }
      const crowd = 4 + Math.floor(prng() * 5);
      for (let s = 0; s < crowd; s++) {
        const pp = path[clamp(c.pathIdx - 6 + Math.floor(prng() * 13), 0, path.length - 1)];
        const pos = perp(pp, outside * (8.2 + prng() * 3.5));
        pos.x += (prng() - 0.5) * 2; pos.z += (prng() - 0.5) * 2;
        addProp('person', pos.x, pos.z, pp.heading + Math.PI, 1, Math.floor(prng() * 6));
      }
      const mp = path[clamp(c.pathIdx - 10, 0, path.length - 1)];
      const mpos = perp(mp, outside * 7.6);
      addProp('marshal', mpos.x, mpos.z, mp.heading + Math.PI, 1, 0);
      if (c.severity <= 2) {
        if (prng() > 0.5) {
          const bp2 = path[clamp(c.pathIdx + 18, 0, path.length - 1)];
          const bpos = perp(bp2, outside * 8.4);
          addProp('board', bpos.x, bpos.z, bp2.heading, 1, 0);
        }
        if (prng() > 0.55) {
          const cp3 = path[clamp(c.pathIdx - 16, 0, path.length - 1)];
          const cpos = perp(cp3, outside * 10.5);
          addProp('parkedCar', cpos.x, cpos.z, cp3.heading + (prng() - 0.5), 1, Math.floor(prng() * 5));
        }
      }
    }
  }

  // Fence runs along a few straights (green stages).
  if (env.ground === SURFACE.GRASS) {
    for (let f = 0; f < 7; f++) {
      const startIdx = 40 + Math.floor(prng() * (path.length - 120));
      if (Math.abs(path[startIdx].curv) > 0.01) continue;
      const side = prng() > 0.5 ? 1 : -1;
      for (let s = 0; s < 4; s++) {
        const p = path[startIdx + s * 7];
        const pos = perp(p, side * 6.3);
        addProp('fence', pos.x, pos.z, p.heading, 1, 0);
      }
    }
  }

  // Bucket props per chunk for streaming builds.
  const propsByChunk = new Map();
  for (const p of props) {
    const key = `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)}`;
    if (!propsByChunk.has(key)) propsByChunk.set(key, []);
    propsByChunk.get(key).push(p);
  }

  // --- Bounds ------------------------------------------------------------------
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of path) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const bounds = { minX: minX - 320, maxX: maxX + 320, minZ: minZ - 320, maxZ: maxZ + 320 };

  const displayName = def ? def.name : biomeDef.name;
  return {
    id: def ? def.id : null,
    name: displayName,
    country: def ? def.country : '',
    biome: biomeKey,
    seed, tod, cfg: env, env,
    path, totalLength, corners, checkpoints, props, propsByChunk,
    startPose: { x: path[8].x, z: path[8].z, heading: path[8].heading },
    finishIdx: path.length - 6,
    bounds,
    groundHeight, surfaceAt, heightAt, columnAt, distToRoad, nearestPath,
    meta: {
      lengthKm: totalLength / 1000,
      cpCount: checkpoints.length,
      surfaceLabel: def ? def.surface : '',
      note: def ? def.note : '',
    },
  };
}
