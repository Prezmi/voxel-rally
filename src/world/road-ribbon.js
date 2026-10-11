// The road SURFACE as one continuous ribbon mesh (JOB: the carriageway still read as a
// lattice of raised paving plates with deep seams).
//
// That fault is no longer the block tile layer (that is detail-only since
// src/world/block-tiles.js TILE_ON_CARRIAGEWAY) - it is the voxel terrain mesher itself:
// the corridor bed carries a different `fine` on every column (src/world/mesher.js
// BED_GRID note), so the greedy merge emits one 1x1 top panel per column and a wall band
// between them, i.e. the heightfield stepped in per-column faces *along the lane*.
//
// Fix: the lane is not terrain, it is a ribbon. This module builds one continuous quad
// grid along the road spline - 1 m along (the spline is arc-length resampled at 1 m in
// src/world/road-spline.js resampleByArc), 0.5 m across - spanning carriageway + shoulder
// + a half metre of block-stepped edge. Vertex heights come from the same carved profile
// the corridor already carries (crown, wheel-line ruts, edge break, gravel ripple,
// src/world/road-carve.js), clamped so the ribbon can never stand above the terrain top.
// Every height/normal here is a PURE function of the global road sample index and the
// lateral offset, so two chunks that share a border vertex compute bit-identical
// positions and normals: the join is welded, no seam, no crack.
//
// THREE-free on purpose (same reason as block-tiles.js / road-skin.js): the shipped grid,
// offsets and profile have to be assertable headless from src/debug/tests.js.
import { CHUNK, WORLD_HEIGHT, chunkKey } from './chunk.js';
import { SHOULDER, CROWN, RUT_DEPTH, RUT_AT, RUT_WIDTH, EDGE_BREAK, GRAVEL_RIPPLE, RIBBON_OVERLAP, RIM_EARTH } from './road-carve.js';
import { blockColor } from './palette.js';
import { blockSurface } from './palette.js';
import { hash01, valueNoise } from './noise.js';

export const STEP_ALONG = 1.0;       // m along the spline (= the road sample pitch)
export const STEP_ACROSS = 0.5;      // m across the corridor
export const RIBBON_DROP = 0.004;    // m BELOW the carved terrain top: never proud, and
                                     // the neighbouring block edges overlap it (no dark gap)
// 0.5 m of block-stepped edge + RIBBON_OVERLAP (0.4 m) of lateral tuck: the ribbon now
// runs past the terrain edge it is carved into and slides UNDER the edge blocks, so the
// rim is never exposed to the camera (road-carve.js RIBBON_OVERLAP / LANE_CORE_INSET).
export const EDGE_BLOCK_BAND = 0.5 + RIBBON_OVERLAP;
export const EDGE_CHIP = 0.16;       // m of broken edge blocks in that band
const GRIT_SALT = 0x7a11c9f3;        // continuous ripple lattice (NOT the carve's
const EDGE_SALT = 0x1ce7a55b;        // per-column hash - that is what steps per column)
const CHIP_SALT = 0x40b3e17d;
const MOTTLE_SALT = 0x9f2d5b31;
const GRAIN_SALT = 0x33af7c19;

const vnoise = valueNoise;

/** Bilinear terrain top over the cell containing (x,z): globally continuous (the grid
 *  points are shared), so the ribbon hugs the carved ground without inheriting a step at
 *  every column boundary. Falls back to the cell minimum over missing chunks. */
export function terrainTopBilinear(world, x, z) {
  const bx = Math.floor(x), bz = Math.floor(z);
  const q00 = world.columnTopQAt(bx, bz), q10 = world.columnTopQAt(bx + 1, bz);
  const q01 = world.columnTopQAt(bx, bz + 1), q11 = world.columnTopQAt(bx + 1, bz + 1);
  if (q00 < 0 || q10 < 0 || q01 < 0 || q11 < 0) return terrainCeilQ(world, x, z) / 16;
  const fx = x - bx, fz = z - bz;
  const a = q00 + (q10 - q00) * fx, b = q01 + (q11 - q01) * fx;
  return (a + (b - a) * fz) / 16;
}

/** Lowest terrain top over the 1 m cell that contains the point (its 4 columns). */
export function terrainCeilQ(world, x, z) {
  const bx = Math.floor(x), bz = Math.floor(z);
  let m = 1 << 20;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) {
      const q = world.columnTopQAt(bx + dx, bz + dz);
      if (q >= 0 && q < m) m = q;
    }
  }
  return m === (1 << 20) ? -1 : m;
}

/** Full cross-section half-width of the ribbon: lane + shoulder + the edge band. */
export function ribbonHalf(road, i) { return road.width[i] / 2 + SHOULDER + EDGE_BLOCK_BAND; }

/** World position of one lattice vertex: pure in (road sample i, lateral d). */
export function ribbonAt(road, i, d) {
  const x = road.x[i] + road.nx[i] * d, z = road.z[i] + road.nz[i] * d;
  return [x, z];
}

/**
 * Ribbon surface height at (road sample i, lateral d), in metres.
 * The analytic carved profile (crown + camber + ruts + edge break + ripple) is the
 * surface; the terrain top over the same cell is the ceiling, so the ribbon can only be
 * at or under the ground it lies on, never above it.
 */
export function ribbonHeight(world, road, i, d) {
  const hw = road.width[i] / 2, ad = Math.abs(d), u = ad / hw;
  const [x, z] = ribbonAt(road, i, d);
  const wl = Math.exp(-Math.pow((ad - hw * RUT_AT) / (hw * RUT_WIDTH), 2));
  let y = road.h[i] + d * Math.tan(road.camber[i]) - CROWN * hw * u * u - RUT_DEPTH * wl;
  y += (vnoise(x, z, 0.5, GRIT_SALT) - 0.5) * GRAVEL_RIPPLE;
  y += (vnoise(x, z, 2, EDGE_SALT) - 0.5) * EDGE_BREAK * Math.max(0, (u - 0.55) / 0.45);
  const bil = terrainTopBilinear(world, x, z);
  if (bil < -1e5) return y - RIBBON_DROP;
  y = Math.min(y, bil) - RIBBON_DROP;
  const minQ = terrainCeilQ(world, x, z);
  // Outer half metre: land on the block lattice (a carved column carries its bed as
  // `height + 1 + fine/16`, so flooring is exactly "drop in block steps"; natural ground
  // already has fine = 0 and does not move), and break the rim with a chip.
  const t = (ad - (hw + SHOULDER)) / EDGE_BLOCK_BAND;
  if (t > 0) {
    const k = t > 1 ? 1 : t;
    const chip = vnoise(x, z, 0.5, CHIP_SALT) * EDGE_CHIP * k;
    const blockY = Math.floor(bil) - RIBBON_DROP - chip;
    y = y * (1 - k) + (blockY < y ? blockY : y) * k;
    // The outer band sits over terrain whose top faces ARE still drawn, so it is clamped
    // hard to that column: a few mm under it, and the block edge overlaps the ribbon.
    const own = world.columnTopQAt(Math.floor(x), Math.floor(z));
    if (own >= 0 && y > own / 16 - RIBBON_DROP) y = own / 16 - RIBBON_DROP;
    // Outermost ring (the RIBBON_OVERLAP tuck under the terrain edge blocks): clamped to
    // the LOWEST terrain top over the cell it spans, so the overlap can never stand above
    // the ground it slides under - that is what put the bright wedge there.
    if (ad > hw + SHOULDER + EDGE_BLOCK_BAND - RIBBON_OVERLAP) {
      const cq = terrainCeilQ(world, x, z);
      if (cq >= 0 && y > cq / 16 - RIBBON_DROP) y = cq / 16 - RIBBON_DROP;
    }
  }
  return y;
}

/** Carve wear band for a ribbon vertex (render-only tone, see road-carve.js). */
export function ribbonWear(road, i, d) {
  const hw = road.width[i] / 2, ad = Math.abs(d);
  if (ad <= hw) {
    const wl = Math.exp(-Math.pow((ad - hw * RUT_AT) / (hw * 0.20), 2))
      + Math.exp(-Math.pow((ad + hw * RUT_AT) / (hw * 0.20), 2));
    const mid = Math.exp(-Math.pow(ad / (hw * 0.45), 2));
    return 134 - 26 * wl + 12 * mid;
  }
  if (ad <= hw + SHOULDER) return 152 - 12 * ((ad - hw) / SHOULDER);
  return Math.max(0, 10 * (1 - (ad - hw - SHOULDER) / (SHOULDER * 2)));
}

function blockAtColumn(world, x, z) {
  const c = world.chunkAt(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
  if (!c) return 0;
  const lx = ((Math.floor(x) % CHUNK) + CHUNK) % CHUNK, lz = ((Math.floor(z) % CHUNK) + CHUNK) % CHUNK;
  const idx = lz * CHUNK + lx;
  const h = c.height[idx];
  if (h < 0) return 0;
  return c.blocks[idx * WORLD_HEIGHT + h] || 0;
}

/**
 * Build one chunk's ribbon. `carveIndex` is the existing per-chunk road sample index
 * (road-carve.js buildCarveIndex) - the ribbon is generated from the same road table, so
 * nothing new is scanned per chunk. Quads are emitted only when their centre falls in
 * this chunk, so the corridor is never drawn twice.
 */
export function ribbonChunk(world, road, cx, cz, carveIndex) {
  const samples = carveIndex && carveIndex.get(chunkKey(cx, cz));
  if (!samples || !samples.length) return null;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const pos = [], nor = [], col = [], sur = [], idx = [];
  const cCol = [0, 0, 0];
  const vKey = new Map();
  let quads = 0;

  const vertex = (i, d) => {
    const k = i * 64 + (Math.round(d / STEP_ACROSS) + 32);
    let v = vKey.get(k);
    if (v !== undefined) return v;
    const [x, z] = ribbonAt(road, i, d);
    const y = ribbonHeight(world, road, i, d);
    // Welded normals: central differences of the same pure height function, so the
    // neighbour chunk gets bit-identical normals for the shared border vertex.
    const i0 = i > 0 ? i - 1 : i, i1 = i < road.n - 1 ? i + 1 : i;
    const ax = ribbonAt(road, i1, d), az = ribbonAt(road, i0, d);
    const spanA = Math.max(1e-3, Math.hypot(ax[0] - az[0], ax[1] - az[1]));
    const sA = (ribbonHeight(world, road, i1, d) - ribbonHeight(world, road, i0, d)) / spanA;
    const spanB = 2 * STEP_ACROSS;
    const sB = (ribbonHeight(world, road, i, d + STEP_ACROSS)
      - ribbonHeight(world, road, i, d - STEP_ACROSS)) / spanB;
    const tx = (road.x[i1] - road.x[i0]) * (spanA / Math.max(1e-3,
      Math.hypot(road.x[i1] - road.x[i0], road.z[i1] - road.z[i0])));
    const tz = (road.z[i1] - road.z[i0]) * (spanA / Math.max(1e-3,
      Math.hypot(road.x[i1] - road.x[i0], road.z[i1] - road.z[i0])));
    const dfx = sA * tx + sB * road.nx[i];
    const dfz = sA * tz + sB * road.nz[i];
    const inv = 1 / Math.hypot(dfx, 1, dfz);
    pos.push(x, y, z);
    nor.push(-dfx * inv, inv, -dfz * inv);
    // Material response is carried the same way the terrain carries it: surface id in the
    // integer part of aSurface, the carve wear band in its fraction, so the pinned road
    // skin band (render/road-skin.js ROAD_TONE / RUT_GLOSS) drives tone and the rut
    // sheen. Baked on top: gravel-scale albedo grain, and a darker wheel line.
    const b = blockAtColumn(world, x, z) || 0;
    // Rim / edge-chip band: take the corridor's own packed earth, not the pale verge block
    // that happens to lie under it, and darken the broken outer steps.
    const hw0 = road.width[i] / 2, ad0 = Math.abs(d);
    let bid = b, rimDim = 1;
    if (ad0 > hw0 + SHOULDER) {
      bid = RIM_EARTH;
      const o = (ad0 - (hw0 + SHOULDER)) / EDGE_BLOCK_BAND;
      rimDim = o > 1 - RIBBON_OVERLAP / EDGE_BLOCK_BAND ? 0.70 : 0.88;
    }
    blockColor(bid, cCol);
    const wl = Math.exp(-Math.pow((Math.abs(d) - (road.width[i] / 2) * RUT_AT) / ((road.width[i] / 2) * RUT_WIDTH), 2));
    const grain = 1 + (vnoise(x, z, 0.5, GRAIN_SALT) - 0.5) * 0.16
      + (vnoise(x, z, 1.5, MOTTLE_SALT) - 0.5) * 0.10;
    const damp = (1 - 0.10 * wl) * rimDim;
    col.push(cCol[0] * grain * damp, cCol[1] * grain * damp, cCol[2] * grain * damp);
    const wear = ribbonWear(road, i, d) / 255;
    sur.push((bid ? blockSurface(bid) : 0) + (wear > 1 ? 1 : wear < 0 ? 0 : wear));
    v = pos.length / 3 - 1;
    vKey.set(k, v);
    return v;
  };

  for (let k = 0; k < samples.length; k++) {
    const i = samples[k];
    if (i + 1 >= road.n) continue;
    const half = ribbonHalf(road, i);
    const M = Math.ceil(half / STEP_ACROSS);
    for (let j = -M; j < M; j++) {
      const d0 = j * STEP_ACROSS, d1 = (j + 1) * STEP_ACROSS;
      const a = ribbonAt(road, i, d0), b = ribbonAt(road, i + 1, d1);
      const mx = (a[0] + b[0]) * 0.5, mz = (a[1] + b[1]) * 0.5;
      if (Math.floor(mx) < x0 || Math.floor(mx) >= x0 + CHUNK) continue;
      if (Math.floor(mz) < z0 || Math.floor(mz) >= z0 + CHUNK) continue;
      const v0 = vertex(i, d0), v1 = vertex(i + 1, d0), v2 = vertex(i + 1, d1), v3 = vertex(i, d1);
      idx.push(v0, v2, v1, v0, v3, v2);
      quads++;
    }
  }
  if (!quads) return null;
  return {
    position: new Float32Array(pos),
    normal: new Float32Array(nor),
    color: new Float32Array(col),
    surface: new Float32Array(sur),
    index: new Uint32Array(idx),
    quads,
    triangles: idx.length / 3,
    verts: pos.length / 3,
  };
}
