// Headless counter for the "white cards on the verge" shot: down-facing terrain
// triangles inside 1.5 m of the baked ribbon-covered band, per shipped map.
import { VoxelWorld, chunkKey, keyToCx, keyToCz, CHUNK } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, carveChunk, SHAVE_STATS } from '../src/world/road-carve.js';
import { stageChunkList } from '../src/world/pregen.js';
import { meshChunk } from '../src/world/mesher.js';
import { MAP_CATALOG, MAP_FAR_DEFAULT } from '../src/world/map-load.js';

const farR = (d) => d.farRadius ?? MAP_FAR_DEFAULT;
for (const def of MAP_CATALOG) {
  const seed = def.seed >>> 0;
  const world = new VoxelWorld(seed);
  const terrain = makeTerrain(seed, def.biome);
  const road = buildRoad({ seed, lengthTarget: def.lengthTarget, terrainHeightAt: terrain.heightAt, biome: def.biome });
  const index = buildCarveIndex(road);
  SHAVE_STATS.columns = 0; SHAVE_STATS.dropSum = 0;
  for (const { cx, cz } of stageChunkList(road, farR(def))) {
    terrain.generateChunk(world, cx, cz);
    const c = world.chunkAt(cx, cz);
    carveChunk(world, cx, cz, road, index, terrain);
    if (c) c.carved = true;
  }
  const coveredNear = (x, z) => {
    const gx = Math.floor(x), gz = Math.floor(z);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const c = world.chunkAt(Math.floor((gx + dx) / CHUNK), Math.floor((gz + dz) / CHUNK));
      if (!c || !c.roadCover) continue;
      const lx = (((gx + dx) % CHUNK) + CHUNK) % CHUNK, lz = (((gz + dz) % CHUNK) + CHUNK) % CHUNK;
      if (c.roadCover[lz * CHUNK + lx]) return true;
    }
    return false;
  };
  let down = 0, near = 0, tris = 0;
  for (const key of index.keys()) {
    const ch = world.chunkAt(keyToCx(key), keyToCz(key));
    if (!ch) continue;
    const m = meshChunk(world, ch, 0);
    const pos = m.position ?? m.attributes?.position?.array, nor = m.normal ?? m.attributes?.normal?.array;
    const idx = m.index ?? m.geometry?.index?.array;
    const n = idx ? idx.length : (pos.length / 3);
    for (let k = 0; k < n; k += 3) {
      const ia = idx ? idx[k] : k / 3, ib = idx ? idx[k + 1] : k / 3 + 1, ic = idx ? idx[k + 2] : k / 3 + 2;
      const a = ia * 3, b = ib * 3, c2 = ic * 3;
      tris++;
      const ny = (nor[a + 1] + nor[b + 1] + nor[c2 + 1]) / 3;
      if (ny > -0.5) continue;
      down++;
      const cxp = (pos[a] + pos[b] + pos[c2]) / 3, czp = (pos[a + 2] + pos[b + 2] + pos[c2 + 2]) / 3;
      if (coveredNear(cxp, czp)) near++;
    }
  }
  console.log(`${def.id}: downFacing=${down} nearCoveredBand(1.5m)=${near} tris=${tris} colsLowered=${SHAVE_STATS.columns} meanDrop=${(SHAVE_STATS.dropSum / Math.max(1, SHAVE_STATS.columns)).toFixed(3)}m`);
}
