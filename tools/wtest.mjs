import { VoxelWorld, keyToCx, keyToCz } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { carveRoad, buildCarveIndex, carveChunk } from '../src/world/road-carve.js';
import { meshChunk } from '../src/world/mesher.js';

const seed = Number(process.argv[2] || 12345);
const terrain = makeTerrain(seed, 'FOREST');
const t0 = performance.now();
const road = buildRoad({ seed, lengthTarget: 3400, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
const tRoad = performance.now() - t0;

// curvature histogram
let rmin = 1e9, tight = 0, ok = 0;
for (let i = 0; i < road.n; i++) {
  const k = Math.abs(road.kappa[i]);
  if (k > 1e-3) { const R = 1/k; rmin = Math.min(rmin, R); if (R < 15) tight++; else ok++; }
}
console.log(`road: ${road.n} samples, ${road.length.toFixed(0)} m, ${road.control.length} control pts, ${tRoad.toFixed(0)} ms`);
console.log(`  min corner R=${rmin.toFixed(1)} m  corners<15m=${tight}  corners>=15m=${ok}`);
let hmin=1e9,hmax=-1e9; for (let i=0;i<road.n;i++){hmin=Math.min(hmin,road.h[i]);hmax=Math.max(hmax,road.h[i]);}
console.log(`  height ${hmin.toFixed(1)}..${hmax.toFixed(1)} m  features=${road.feature.filter(f=>f).length}`);

const world = new VoxelWorld(seed);
const index = buildCarveIndex(road);
const t1 = performance.now();
for (const key of index.keys()) { const cx=keyToCx(key), cz=keyToCz(key); if(!world.chunkAt(cx,cz)) terrain.generateChunk(world, cx, cz); }
const tGen = performance.now()-t1;
let cw=0;
for (const key of index.keys()) cw += carveChunk(world, keyToCx(key), keyToCz(key), road, index, terrain);
const tCarve = performance.now()-t1-tGen;
console.log(`chunks ${world.chunkCount}  gen ${tGen.toFixed(0)} ms  carve ${tCarve.toFixed(0)} ms  carveWrites ${cw}`);

// road surface fidelity
let err=0,n=0,worst=0,worstAt=0;
for (let i=0;i<road.n;i+=3){
  const cx=Math.floor(road.x[i]/16), cz=Math.floor(road.z[i]/16);
  if(!world.chunkAt(cx,cz)) continue;
  const g = world.groundHeight(road.x[i], road.z[i]);
  const e = Math.abs(g - road.h[i]); err+=e; n++; if(e>worst){worst=e;worstAt=i;}
}
console.log(`road height err avg ${(err/n).toFixed(3)} m worst ${worst.toFixed(3)} m @s=${worstAt}`);

// mesh validity + LOD costs
for (const lod of [0,1,2]) {
  const t2=performance.now(); let quads=0,tris=0,bad=0,topUp=0;
  for (const c of world.chunks.values()) {
    const m = meshChunk(world, c, lod);
    quads+=m.quads; tris+=m.triangles;
    for (let i=0;i<m.index.length;i+=3){
      const a=m.index[i]*3,b=m.index[i+1]*3,d=m.index[i+2]*3;
      const ux=m.position[b]-m.position[a], uy=m.position[b+1]-m.position[a+1], uz=m.position[b+2]-m.position[a+2];
      const vx=m.position[d]-m.position[a], vy=m.position[d+1]-m.position[a+1], vz=m.position[d+2]-m.position[a+2];
      const cx2=uy*vz-uz*vy, cy2=uz*vx-ux*vz, cz2=ux*vy-uy*vx;
      const area=Math.hypot(cx2,cy2,cz2)/2;
      if(area<1e-6) bad++;
      if(m.normal[a+1]>0.9) topUp++;
    }
  }
  const ms=performance.now()-t2;
  console.log(`lod${lod}: quads ${quads} tris ${tris} degenerate ${bad} topfaceTris ${topUp}  ${ms.toFixed(0)} ms (${(ms/world.chunkCount).toFixed(2)} ms/chunk)`);
}
