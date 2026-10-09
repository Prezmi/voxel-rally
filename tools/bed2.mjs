// Diagnostic: raw column tops across the corridor at the start of the stage.
import { VoxelWorld, CHUNK, keyToCx, keyToCz } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad, planCheckpoints } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';

const seed = 12345, biome = 'FOREST';
const world = new VoxelWorld(seed);
const terrain = makeTerrain(seed, biome);
const road = buildRoad({ seed, lengthTarget: 3400, terrainHeightAt: terrain.heightAt, biome });
const ci = buildCarveIndex(road);
prewarmArea(world, terrain, road, ci, road.x[12], road.z[12], 140);

console.log('arc  road.h  camber  kappa  width  surf  |  raw column tops across the corridor (metres, -1 = empty)');
for (let i = 8; i <= 18; i++) {
  const hw = road.width[i] / 2;
  const cols = [];
  for (let d = -hw - 1; d <= hw + 1; d += 0.5) {
    const px = road.x[i] + road.nx[i] * d, pz = road.z[i] + road.nz[i] * d;
    cols.push(world.columnTopAt(Math.floor(px), Math.floor(pz)));
  }
  console.log(
    `${String(i).padStart(3)}  ${road.h[i].toFixed(2)}  ${road.camber[i].toFixed(3)}  ${road.kappa[i].toFixed(4)}  ${road.width[i].toFixed(1)}  ${road.surfaceId[i]}  | ` +
    cols.map((c) => (c < 0 ? '  --  ' : (c + 1).toFixed(1))).join(' ')
  );
}

console.log('\nchunk-level: which columns in the start chunk are claimed vs natural');
const cx = Math.floor(road.x[12] / CHUNK), cz = Math.floor(road.z[12] / CHUNK);
const ch = world.chunkAt(cx, cz);
console.log('chunk', cx, cz, 'exists', !!ch, 'carved', ch && ch.carved);
if (ch) {
  for (let lz = 0; lz < CHUNK; lz += 2) {
    const row = [];
    for (let lx = 0; lx < CHUNK; lx += 2) row.push(String(ch.height[lz * CHUNK + lx]).padStart(3));
    console.log(row.join(''));
  }
}
