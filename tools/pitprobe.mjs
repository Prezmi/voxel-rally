// probe: count tiny wall faces / dark faces / missing top faces on near-flat ground
import { VoxelWorld, CHUNK } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';
import { meshChunk } from '../src/world/mesher.js';

const seed = 471304713, biome = 'FOREST';
const world = new VoxelWorld(seed);
const terrain = makeTerrain(seed, biome);
const road = buildRoad({ seed, lengthTarget: 3400, terrainHeightAt: terrain.heightAt, biome });
const ci = buildCarveIndex(road);
const sx = road.x[12], sz = road.z[12];
prewarmArea(world, terrain, road, ci, sx, sz, 140);

let quads = 0, tris = 0;
let tinyWallQuads = 0, tinyWallNearFlat = 0, allWallQuads = 0, bigWallQuads = 0;
let topQuads = 0;
let minLum = 9, dark40 = 0, dark55 = 0;
let missingTop = 0, columns = 0;
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

for (const c of world.chunks.values()) {
  const m = meshChunk(world, c, 0);
  const P = m.position, C = m.color, N = m.normal, I = m.index;
  quads += m.quads; tris += m.triangles;
  // group into quads (2 tris per quad, emitted in order base,base+1,base+2,base,base+2,base+3)
  for (let t = 0; t < I.length; t += 6) {
    const a = I[t] * 3, b = I[t + 1] * 3, d = I[t + 3] * 3;
    const nx = (N[a + 1] + N[b + 1] + N[d + 1]) / 3;
    const ny = (N[a + 1] + N[b + 1] + N[d + 1]) / 3;
    let ymin = 1e9, ymax = -1e9;
    for (let k = 0; k < 6; k++) {
      const v = I[t + k] * 3;
      if (P[v + 1] < ymin) ymin = P[v + 1];
      if (P[v + 1] > ymax) ymax = P[v + 1];
    }
    const span = ymax - ymin;
    let mn = 1e9;
    for (let k = 0; k < 6; k++) {
      const v = I[t + k] * 3;
      const L = lum(C[v], C[v + 1], C[v + 2]);
      if (L < mn) mn = L;
    }
    if (mn < minLum) minLum = mn;
    if (mn < 0.40) dark40++;
    if (mn < 0.55) dark55++;
    if (ny > 0.7) { topQuads++; continue; }
    allWallQuads++;
    if (span < 0.2) {
      tinyWallQuads++;
      // near-flat: the two columns it separates differ by < 0.2 m in true height
      const wx = Math.floor(P[a]), wz = Math.floor(P[a + 2]);
      const ha = world.columnTopQAt(wx, wz), hb = world.columnTopQAt(wx + (Math.abs(P[d] - P[a]) > 0.5 ? 1 : 0), wz + (Math.abs(P[d + 2] - P[a + 2]) > 0.5 ? 1 : 0));
      if (ha >= 0 && hb >= 0 && Math.abs(ha - hb) / 16 < 0.2) tinyWallNearFlat++;
    } else bigWallQuads++;
  }
  // missing top face test: is (lx+0.5, topQ/16, lz+0.5) inside any upward quad?
  const tops = [];
  for (let t = 0; t < I.length; t += 6) {
    const a = I[t] * 3, b = I[t + 1] * 3, d = I[t + 3] * 3;
    if ((N[a + 1] + N[b + 1] + N[d + 1]) / 3 <= 0.7) continue;
    const vs = [];
    for (const k of [0, 1, 2, 5]) vs.push([I[t + k]]);
    const pts = [0, 1, 2, 5].map((k) => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]]);
    tops.push(pts);
  }
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const col = lz * CHUNK + lx;
      const tq = c.columnTopQ(col);
      if (tq < 0) continue;
      columns++;
      const px = c.cx * CHUNK + lx + 0.5, pz = c.cz * CHUNK + lz + 0.5, py = tq / 16;
      let found = false;
      for (const pts of tops) {
        if (Math.abs(pts[0][1] - py) > 0.5) continue;
        if (inQuad(pts, px, pz)) { found = true; break; }
      }
      if (!found) missingTop++;
    }
  }
}
function inQuad(pts, x, z) {
  // split quad (0,1,2,0,2,3) into two triangles
  return tri(pts[0], pts[1], pts[2], x, z) || tri(pts[0], pts[2], pts[3], x, z);
}
function tri(a, b, cc, x, z) {
  const s = (p, q) => (q[0] - p[0]) * (z - p[2]) - (q[2] - p[2]) * (x - p[0]);
  const s1 = s(a, b), s2 = s(b, cc), s3 = s(cc, a);
  return (s1 >= -1e-6 && s2 >= -1e-6 && s3 >= -1e-6) || (s1 <= 1e-6 && s2 <= 1e-6 && s3 <= 1e-6);
}
console.log(JSON.stringify({ quads, tris, topQuads, allWallQuads, tinyWallQuads, tinyWallNearFlat, bigWallQuads, minLum: +minLum.toFixed(3), dark40, dark55, columns, missingTop }, null, 0));
