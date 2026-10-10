import { VoxelWorld, CHUNK } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';
const seed=471304713, biome='FOREST';
const world=new VoxelWorld(seed), terrain=makeTerrain(seed,biome);
const road=buildRoad({seed,lengthTarget:3400,terrainHeightAt:terrain.heightAt,biome});
const ci=buildCarveIndex(road);
prewarmArea(world,terrain,road,ci,road.x[12],road.z[12],140);
// stats over all loaded chunks: adjacent deltas in 1/16 units, split by worn/not worn
const B={'0':0,'1-2':0,'3-7':0,'8-15':0,'16-31':0,'32-63':0,'64+':0};
let pairs=0, sub=0;
let ao3=0, cells=0;
for (const c of world.chunks.values()){
  const Q=new Int16Array(CHUNK*CHUNK);
  for(let i=0;i<CHUNK*CHUNK;i++) Q[i]=c.columnTopQ(i);
  for(let z=0;z<CHUNK;z++)for(let x=0;x<CHUNK;x++){
    const i=z*CHUNK+x; if(Q[i]<0) continue; cells++;
    for(const j of [i+1,i+CHUNK]){ const q=Q[j]; if(q<0) continue;
      const d=Math.abs(Q[i]-q); pairs++;
      const k = d===0?'0': d<=2?'1-2': d<=7?'3-7': d<=15?'8-15': d<=31?'16-31': d<=63?'32-63':'64+';
      B[k]++; if(d<16) sub++;
    }
  }
}
console.log('pairs',pairs,'buckets',B,'sub16frac',(sub/pairs).toFixed(3));
// print a 24x24 map around the start point
const bx=Math.floor(road.x[12]), bz=Math.floor(road.z[12]);
let out='';
for(let dz=-12;dz<12;dz++){ let row='';
 for(let dx=-12;dx<12;dx++){
   const q=world.columnTopQAt(bx+dx,bz+dz);
   const h=world.columnTopAt(bx+dx,bz+dz);
   const c=world.chunks.get(((Math.floor((bx+dx)/16)+32768)*65536)+(Math.floor((bz+dz)/16)+32768));
   const wear=c? c.wear[(((bz+dz)&15)*16)+((bx+dx)&15)]:0;
   const ch = q<0?'.' : (wear>120?'#':(wear>0?'+': (Math.round(q/16)%8).toString(36)));
   row+=ch+' ';
 } out+=row+'\n';}
console.log(out);
// delta histogram along the road line (perpendicular) at the start
let row='';
for(let dx=-14;dx<14;dx++){ const q=world.columnTopQAt(bx+dx,bz); row+= (q/16).toFixed(2)+'|'; }
console.log('cross-section top(m):',row);
