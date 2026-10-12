// Voxel chunk mesher. Pure module: turns stage columns into flat
// geometry arrays (positions / normals / uvs / colors / indices) with
// hidden faces culled:
//   - a column side is only emitted where the neighbour is lower, and
//     only for the exposed band, split into <=1 m quads
//   - the interior of the terrain is never emitted
// Columns come from stage.columnAt (analytic world, cached), so chunks
// can be built anywhere along a kilometre long stage.
//
// Shading model (baked into vertex colours):
//   - directional face shading: top 1.0, sun side bright, off sides
//     darker, so the voxel steps read in flat light
//   - top face vertices tucked against a higher neighbour are darkened
//     (cheap ambient occlusion feel at block edges)
//   - side bands darken with depth for ground contact grounding
//   - a stable per column tint jitter breaks up flat repetition

import { TILE, tileUV, SURFACE } from './tiles.js';
import { hash2 } from '../core/rng.js';

export const CHUNK = 16;
export const VIS_STEP = 0.25; // visual height quantization (chunky steps)

// Per-biome top/side/sub tile choice (top is a fallback; the surface
// map usually wins via SURFACE_TILE).
const BIOME_TILES = {
  forest: { top: TILE.GRASS, side: TILE.GRASS_SIDE, sub: TILE.DIRT },
  desert: { top: TILE.SAND, side: TILE.SAND_SIDE, sub: TILE.ROCK },
  snow: { top: TILE.SNOW, side: TILE.SNOW_SIDE, sub: TILE.SNOW_SIDE },
  wales: { top: TILE.GRASS, side: TILE.GRASS_SIDE, sub: TILE.DIRT },
  finland: { top: TILE.GRASS, side: TILE.GRASS_SIDE, sub: TILE.DIRT },
  greece: { top: TILE.SCRUB, side: TILE.ROCK, sub: TILE.ROCK },
  monte: { top: TILE.GRASS, side: TILE.GRASS_SIDE, sub: TILE.ROCK },
  kenya: { top: TILE.DRY_GRASS, side: TILE.RED_DIRT, sub: TILE.RED_DIRT },
  sweden: { top: TILE.SNOW, side: TILE.SNOW_SIDE, sub: TILE.SNOW_SIDE },
  australia: { top: TILE.DRY_GRASS, side: TILE.RED_DIRT, sub: TILE.RED_DIRT },
  nz: { top: TILE.GRASS, side: TILE.GRASS_SIDE, sub: TILE.DIRT },
};

const SURFACE_TILE = {
  [SURFACE.TARMAC]: TILE.TARMAC,
  [SURFACE.TARMAC_LINE]: TILE.TARMAC_LINE,
  [SURFACE.GRAVEL]: TILE.GRAVEL,
  [SURFACE.DIRT]: TILE.DIRT,
  [SURFACE.GRASS]: TILE.GRASS,
  [SURFACE.MUD]: TILE.MUD,
  [SURFACE.SAND]: TILE.SAND,
  [SURFACE.SNOW]: TILE.SNOW,
  [SURFACE.PACKED_SNOW]: TILE.SNOW_ROAD,
  [SURFACE.ROCK]: TILE.ROCK,
  [SURFACE.ICE]: TILE.ICE,
  [SURFACE.RED_DIRT]: TILE.RED_DIRT,
  [SURFACE.DRY]: TILE.DRY_GRASS,
  [SURFACE.SCRUB]: TILE.SCRUB,
};

const q = (h) => Math.round(h / VIS_STEP) * VIS_STEP;

export function visualHeight(stage, x, z) {
  return q(stage.columnAt(x, z).h);
}

// Emits one quad (two triangles) with a face normal.
// colors: a single tint, or [tA, tB, tC, tD] per vertex.
function quad(out, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, uv, tint) {
  const base = out.positions.length / 3;
  out.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
  for (let i = 0; i < 4; i++) out.normals.push(nx, ny, nz);
  if (Array.isArray(tint)) out.colors.push(tint[0], tint[0], tint[0], tint[1], tint[1], tint[1], tint[2], tint[2], tint[2], tint[3], tint[3], tint[3]);
  else for (let i = 0; i < 4; i++) out.colors.push(tint, tint, tint);
  out.uvs.push(uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]);
  out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  out.faceCount++;
}

// Faces: +x, -x, +z, -z neighbours, with directional shade factors.
const DIRS = [
  { dx: 1, dz: 0, shade: 0.84 },
  { dx: -1, dz: 0, shade: 0.68 },
  { dx: 0, dz: 1, shade: 0.76 },
  { dx: 0, dz: -1, shade: 0.92 },
];

export function meshChunk(stage, cx, cz) {
  const out = { positions: [], normals: [], uvs: [], colors: [], indices: [], faceCount: 0, naiveFaceCount: 0 };
  const bt = BIOME_TILES[stage.biome] ?? BIOME_TILES.forest;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;

  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = x0 + lx, z = z0 + lz;
      const h = visualHeight(stage, x, z);
      const surf = stage.columnAt(x, z).s;
      out.naiveFaceCount += 5;

      // Neighbour heights (cached columns; cheap).
      const hE = visualHeight(stage, x + 1, z), hW = visualHeight(stage, x - 1, z);
      const hS = visualHeight(stage, x, z + 1), hN = visualHeight(stage, x, z - 1);
      const nh = [hE, hW, hS, hN];

      // Per column tint jitter (stable hash) for a richer look.
      const tint = 0.92 + hash2(x, z, 1234) * 0.14;

      // Slope: steep columns read as rock (except in snow biomes).
      let topTile = SURFACE_TILE[surf] ?? bt.top;
      let steepest = 0;
      for (const v of nh) steepest = Math.max(steepest, Math.abs(v - h));
      if (steepest > 1.35 && surf !== SURFACE.SNOW && surf !== SURFACE.PACKED_SNOW) topTile = TILE.ROCK;

      // Top face with per vertex AO: a vertex next to a higher column
      // (in either of its two edge directions) sits in shade.
      const ao = (dA, dB) => 1 - 0.16 * Math.min(1, Math.max(0, dA)) - 0.16 * Math.min(1, Math.max(0, dB));
      const tA = tint * ao(hW - h, hN - h); // (-x,-z) corner
      const tB = tint * ao(hW - h, hS - h); // (-x,+z)
      const tC = tint * ao(hE - h, hS - h); // (+x,+z)
      const tD = tint * ao(hE - h, hN - h); // (+x,-z)
      const uvTop = tileUV(topTile);
      quad(out, x, h, z, x, h, z + 1, x + 1, h, z + 1, x + 1, h, z, 0, 1, 0, uvTop, [tA, tB, tC, tD]);

      // Side faces for the exposed band against each lower neighbour.
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di];
        const nvh = nh[di];
        if (nvh >= h) continue;
        let yTop = h;
        let band = 0;
        while (yTop > nvh + 1e-6) {
          const yBot = Math.max(nvh, yTop - 1);
          const tile = band === 0 ? (topTile === TILE.ROCK ? TILE.ROCK : bt.side) : bt.sub;
          const uv = tileUV(tile);
          const t2 = tint * d.shade * (band === 0 ? 0.88 : band === 1 ? 0.74 : 0.62);
          if (d.dx === 1) quad(out, x + 1, yBot, z + 1, x + 1, yBot, z, x + 1, yTop, z, x + 1, yTop, z + 1, 1, 0, 0, uv, t2);
          else if (d.dx === -1) quad(out, x, yBot, z, x, yBot, z + 1, x, yTop, z + 1, x, yTop, z, -1, 0, 0, uv, t2);
          else if (d.dz === 1) quad(out, x, yBot, z + 1, x + 1, yBot, z + 1, x + 1, yTop, z + 1, x, yTop, z + 1, 0, 0, 1, uv, t2);
          else quad(out, x + 1, yBot, z, x, yBot, z, x, yTop, z, x + 1, yTop, z, 0, 0, -1, uv, t2);
          yTop = yBot;
          band++;
        }
      }
    }
  }
  return out;
}

// Converts the pure array output of meshChunk into a THREE geometry.
// Kept here (THREE passed in) so the mesher itself stays testable in Node.
export function chunkGeometry(THREE, data) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));
  g.setIndex(data.indices);
  g.computeBoundingSphere();
  return g;
}

// Stats helper for tests: meshes a square of chunks around a point.
export function meshStatsAround(stage, px, pz, radiusChunks = 3) {
  let faces = 0, naive = 0;
  const ccx = Math.floor(px / CHUNK), ccz = Math.floor(pz / CHUNK);
  for (let cz = ccz - radiusChunks; cz <= ccz + radiusChunks; cz++)
    for (let cx = ccx - radiusChunks; cx <= ccx + radiusChunks; cx++) {
      const m = meshChunk(stage, cx, cz);
      faces += m.faceCount;
      naive += m.naiveFaceCount;
    }
  return { faces, naive };
}
