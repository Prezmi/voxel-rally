import { VoxelWorld, CHUNK, chunkKey, keyToCx, keyToCz } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea, carveChunk, SHOULDER, RAMP } from '../src/world/road-carve.js';

const seed = 12345, biome = 'FOREST';
const world = new VoxelWorld(seed);
const terrain = makeTerrain(seed, biome);
const road = buildRoad({ seed, lengthTarget: 3400, terrainHeightAt: terrain.heightAt, biome });
const ci = buildCarveIndex(road);

console.log('arc12 pos', road.x[12].toFixed(2), road.z[12].toFixed(2), 'h', road.h[12].toFixed(2), 'width', road.width[12]);
const k = chunkKey(Math.floor(road.x[12] / CHUNK), Math.floor(road.z[12] / CHUNK));
console.log('chunk key', k, '-> cx,cz', keyToCx(k), keyToCz(k), 'samples', ci.get(k)?.length, 'total chunks in index', ci.size);

// what does the carve index say about the samples that should claim the centre column?
const cx = keyToCx(k), cz = keyToCz(k);
const colX = Math.floor(road.x[12]), colZ = Math.floor(road.z[12]);
console.log('centre column', colX, colZ);
for (const i of ci.get(k) || []) {
  const d = (road.x[i] - road.x[12]) * road.nx[i] + (road.z[i] - road.z[12]) * road.nz[i];
  const along = (road.x[i] - road.x[12]) * road.tx[i] + (road.z[i] - road.z[12]) * road.tz[i];
  if (Math.abs(d) < 2 && Math.abs(along) < 4) {
    console.log(`  sample ${i}: perp=${d.toFixed(2)} along=${along.toFixed(2)} road.h=${road.h[i].toFixed(2)} camber=${road.camber[i].toFixed(3)} width=${road.width[i]}`);
  }
}

prewarmArea(world, terrain, road, ci, road.x[12], road.z[12], 140);
const ch = world.chunkAt(cx, cz);
const lx = colX - cx * CHUNK, lz = colZ - cz * CHUNK;
console.log('after prewarm: chunk height at centre column =', ch.height[lz * CHUNK + lx], 'surface block', ch.surface[lz * CHUNK + lx]);
console.log('terrain.heightAt centre =', terrain.heightAt(road.x[12], road.z[12]).toFixed(2));

// re-run carveChunk alone and report the claimed target for that column
const writes = carveChunk(world, cx, cz, road, ci, terrain);
console.log('carveChunk again -> writes', writes, 'height now', ch.height[lz * CHUNK + lx]);
