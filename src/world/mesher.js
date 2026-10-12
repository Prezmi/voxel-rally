// Voxel chunk mesher. Pure module: turns the heightfield + surface map
// into flat geometry arrays (positions / normals / uvs / colors / indices)
// with hidden faces culled:
//   - a column side is only emitted where the neighbour is lower, and only
//     for the exposed band, split into <=1 m quads so textures never stretch
//   - the interior of the terrain is never emitted at all
// A naive mesher would emit 5 faces for every one of the 65k columns;
// the test suite asserts this mesher emits far fewer.

import { TILE, tileUV } from './tiles.js';
import { SURFACE } from './tiles.js';
import { SIZE } from './stage.js';
import { hash2, clamp } from '../core/rng.js';

export const CHUNK = 16;
export const VIS_STEP = 0.25; // visual height quantization (chunky steps)

// Per-biome top/side tile choice.
const BIOME_TILES = {
  forest: { top: TILE.GRASS, side: TILE.GRASS_SIDE, sub: TILE.DIRT },
  desert: { top: TILE.SAND, side: TILE.SAND_SIDE, sub: TILE.ROCK },
  snow: { top: TILE.SNOW, side: TILE.SNOW_SIDE, sub: TILE.SNOW_SIDE },
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
};

const q = (h) => Math.round(h / VIS_STEP) * VIS_STEP;

export function visualHeight(stage, x, z) {
  if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) return 0;
  return q(stage.heights[z * SIZE + x]);
}

// Emits one quad (two triangles) with a face normal.
function quad(out, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, uv, tint) {
  const base = out.positions.length / 3;
  out.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
  for (let i = 0; i < 4; i++) {
    out.normals.push(nx, ny, nz);
    out.colors.push(tint, tint, tint);
  }
  out.uvs.push(uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]);
  out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  out.faceCount++;
}

// Faces: +x, -x, +z, -z neighbours.
const DIRS = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 },
];

export function meshChunk(stage, cx, cz) {
  const out = { positions: [], normals: [], uvs: [], colors: [], indices: [], faceCount: 0, naiveFaceCount: 0 };
  const bt = BIOME_TILES[stage.biome] ?? BIOME_TILES.forest;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;

  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = x0 + lx, z = z0 + lz;
      if (x >= SIZE || z >= SIZE) continue;
      const h = visualHeight(stage, x, z);
      const surf = stage.surfaces[z * SIZE + x];
      out.naiveFaceCount += 5;

      // Per column tint jitter (stable hash) for a richer look.
      const tint = 0.92 + hash2(x, z, 1234) * 0.14;

      // Slope: steep columns read as rock (except in snow where they stay snow).
      let topTile = SURFACE_TILE[surf] ?? bt.top;
      let steepest = 0;
      for (const d of DIRS) {
        const nh = visualHeight(stage, x + d.dx, z + d.dz);
        steepest = Math.max(steepest, Math.abs(nh - h));
      }
      if (steepest > 1.35 && surf !== SURFACE.SNOW && surf !== SURFACE.PACKED_SNOW) topTile = TILE.ROCK;

      // Top face.
      const uvTop = tileUV(topTile);
      quad(out, x, h, z, x, h, z + 1, x + 1, h, z + 1, x + 1, h, z, 0, 1, 0, uvTop, tint);

      // Side faces for the exposed band against each lower neighbour.
      for (const d of DIRS) {
        const nh = visualHeight(stage, x + d.dx, z + d.dz);
        if (nh >= h) continue;
        let yTop = h;
        let band = 0;
        while (yTop > nh + 1e-6) {
          const yBot = Math.max(nh, yTop - 1);
          const tile = band === 0 ? (topTile === TILE.ROCK ? TILE.ROCK : bt.side) : bt.sub;
          const uv = tileUV(tile);
          const t2 = tint * (band === 0 ? 0.86 : 0.72);
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

// Whole world stats helper for tests.
export function meshStats(stage) {  let faces = 0, naive = 0;
  const n = SIZE / CHUNK;
  for (let cz = 0; cz < n; cz++)
    for (let cx = 0; cx < n; cx++) {
      const m = meshChunk(stage, cx, cz);
      faces += m.faceCount;
      naive += m.naiveFaceCount;
    }
  return { faces, naive };
}

export { clamp };
