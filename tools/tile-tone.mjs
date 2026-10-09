// PLAN §10 criterion 2 meter: "różnica tonażu między panelami tej samej
// nawierzchni >= 12%". The terrain tone is computed in the shader
// (src/render/renderer.js -> color_fragment), so this mirrors that formula in JS
// and measures the spread it actually produces over real world positions of one
// surface, sampled on the 1 m column grid the mesher uses.
//
// It measures the *multiplier* the shader applies to the panel's vertex colour
// (hue mix x value swing x grit x edge weathering), which is what the criterion
// is about: no flat uniform slab.
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex } from '../src/world/road-carve.js';
import { VoxelWorld, CHUNK, chunkKey } from '../src/world/chunk.js';
import { meshChunk } from '../src/world/mesher.js';

const fract = (x) => x - Math.floor(x);
function h21(x, y) {
  const px = fract(x * 127.1), py = fract(y * 311.7);
  const d = px * (px + 45.32) + py * (py + 45.32);
  return fract(px * py * (1 + d * 0.001));
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = fract(x), fy = fract(y);
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = h21(ix, iy), b = h21(ix + 1, iy), c = h21(ix, iy + 1), d = h21(ix + 1, iy + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
const fbm3 = (x, y) => 0.55 * vnoise(x, y) + 0.30 * vnoise(x * 2.7 + 13.1, y * 2.7 + 13.1)
  + 0.15 * vnoise(x * 6.3 - 7.7, y * 6.3 - 7.7);

// Mirror of the shader's colour multiplier for one surface id.
function tone(x, z, gritAmt) {
  const patch = vnoise(x * 0.17, z * 0.17);
  const tile = fbm3(x * 0.78 + 41, z * 0.78 + 41);
  const grit = vnoise(x * 3.6 - 17, z * 3.6 - 17);
  const hue = 1 + (patch - 0.5) * 0.14;              // hue anchors differ ~14% in one channel
  const val = 0.76 + 0.50 * tile;
  const gritMul = 1 + (grit - 0.5) * gritAmt;
  return hue * val * gritMul;
}

const SEED = 12345;
const terrain = makeTerrain(SEED, 'FOREST');
const road = buildRoad({ seed: SEED, lengthTarget: 4200, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
const ci = buildCarveIndex(road);
const world = new VoxelWorld(SEED);

// Build + carve the chunks around the start so the mesher has real road panels
// (the same prewarm path main.js uses).
const { prewarmArea } = await import('../src/world/road-carve.js');
await prewarmArea(world, terrain, road, ci, road.x[0], road.z[0], 160);

const t0 = performance.now();
let tris = 0, quads = 0, chunks = 0;
const worn = { min: 9e9, max: -9e9 };
for (const c of world.chunks.values()) {
  if (!c.generated) continue;
  const d = meshChunk(world, c, 0);
  tris += d.triangles; quads += d.quads; chunks++;
  for (let i = 0; i < d.surface.length; i++) {
    const w = d.surface[i] - Math.floor(d.surface[i]);
    if (w < worn.min) worn.min = w;
    if (w > worn.max) worn.max = w;
  }
}
const meshMs = (performance.now() - t0) / Math.max(1, chunks);

// Sample the tone multiplier on the column grid inside the road corridor.
function spread() {}

// Measure on the REAL panels: the mesher's quads (that is what the player sees as
// a panel), using the baked vertex colour (AO + edge wear + material blend) times
// the shader tone multiplier evaluated at the quad centre.
function panelSpread(surfaceId, gritAmt, label) {
  const lum = [];
  for (const c of world.chunks.values()) {
    if (!c.generated) continue;
    const d = meshChunk(world, c, 0);
    const nq = d.quads;
    for (let k = 0; k < nq; k++) {
      const v = 4 * k;
      const sid = Math.floor(d.surface[v] + 0.001);
      if (sid !== surfaceId) continue;
      const cx = (d.position[v * 3] + d.position[(v + 1) * 3] + d.position[(v + 2) * 3] + d.position[(v + 3) * 3]) / 4;
      const cz = (d.position[v * 3 + 2] + d.position[(v + 1) * 3 + 2] + d.position[(v + 2) * 3 + 2] + d.position[(v + 3) * 3 + 2]) / 4;
      let L = 0;
      for (let i = 0; i < 4; i++) {
        const r = d.color[(v + i) * 3], g = d.color[(v + i) * 3 + 1], b = d.color[(v + i) * 3 + 2];
        L += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      L = (L / 4) * tone(cx, cz, gritAmt);
      lum.push(L);
    }
  }
  if (lum.length < 4) { console.log(`${label}: no panels`); return; }
  let mn = 9e9, mx = -9e9, sum = 0;
  for (const v of lum) { if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
  const mean = sum / lum.length;
  let adj = 0, cnt = 0;
  for (let i = 1; i < lum.length; i++) { adj += Math.abs(lum[i] - lum[i - 1]) / mean; cnt++; }
  let sd = 0;
  for (const v of lum) sd += (v - mean) * (v - mean);
  sd = Math.sqrt(sd / lum.length) / mean;
  console.log(`${label}: panels ${lum.length}  min ${(mn / mean * 100).toFixed(0)}% max ${(mx / mean * 100).toFixed(0)}% of mean  range ${(((mx - mn) / mn) * 100).toFixed(1)} %  std ${((sd * 100)).toFixed(1)} %  neighbour-panel mean delta ${((adj / cnt) * 100).toFixed(1)} %`);
}

panelSpread(2, 0.34, 'gravel/shoulder panels');   // SURF.GRAVEL (the szuter road)
panelSpread(5, 0.24, 'grass panels');
panelSpread(7, 0.16, 'stone panels');
console.log(`mesh: chunks ${chunks} quads ${quads} tris ${tris}  ${meshMs.toFixed(2)} ms/chunk (LOD0, AO + baked relief + wear)`);
console.log(`packed wear attribute range: ${worn.min.toFixed(2)} .. ${worn.max.toFixed(2)}`);
