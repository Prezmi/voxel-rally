// probe: find near-white mesher quads + duplicate faces offset above the surface
import { VoxelWorld, CHUNK } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';
import { meshChunk } from '../src/world/mesher.js';
import { PALETTE } from '../src/world/palette.js';

const seed = 12345, biome = 'FOREST';
const world = new VoxelWorld(seed);
const terrain = makeTerrain(seed, biome);
const road = buildRoad({ seed, lengthTarget: 3400, terrainHeightAt: terrain.heightAt, biome });
const ci = buildCarveIndex(road);
prewarmArea(world, terrain, road, ci, road.x[12], road.z[12], 140);

const seen = new Map();
let lodIx=0; for (const c of world.chunks.values()) { const lod=[0,0,1,2][lodIx++%4];
  const m = meshChunk(world, c, lod);
  const P = m.position, C = m.color, S = m.surface, I = m.index;
  for (let t = 0; t < I.length; t += 3) {
    let mx = 0, my = 0, mz = 0, near = 0;
    for (let k = 0; k < 3; k++) {
      const v = I[t + k] * 3;
      mx += P[v] / 3; my += P[v + 1] / 3; mz += P[v + 2] / 3;
      near = Math.max(near, Math.min(C[v], C[v + 1], C[v + 2]));
    }
    if (near < 0.45) continue;
    const sid = Math.round(S[I[t]]);
    // classify: top face (normal y ~1) or wall
    const key = sid + '|' + (my > 0.5 ? 'top?' : 'wall');
    seen.set(key, (seen.get(key) || 0) + 1);
    const arr = seen.get('samples') || [];
    if (arr.length < 25) {
      arr.push({ key, x: mx.toFixed(1), y: my.toFixed(2), z: mz.toFixed(1), sid, c: [C[I[t] * 3].toFixed(2), C[I[t] * 3 + 1].toFixed(2), C[I[t] * 3 + 2].toFixed(2)], wear: (S[I[t]] - sid).toFixed(2) });
      seen.set('samples', arr);
    }
  }
}
console.log('block ids in corridor:', [...countBlocks()].sort());
function countBlocks() {
  const m = new Map();
  for (const c of world.chunks.values()) for (let i = 0; i < c.height.length; i++) { const h = c.height[i]; if (h < 0) continue; const b = c.blocks[i * 96 + h]; m.set(b, (m.get(b) || 0) + 1); }
  return [...m.entries()].map(([b, n]) => (PALETTE[b] ? PALETTE[b].name : b) + ':' + n);
}
for (const [k, v] of seen) if (k !== 'samples') console.log('nearwhite quads', k, v);
for (const s of (seen.get('samples') || [])) console.log(JSON.stringify(s));
