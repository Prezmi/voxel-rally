import { VoxelWorld } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';
const seed=12345, biome='FOREST';
const world=new VoxelWorld(seed);
const terrain=makeTerrain(seed,biome);
const road=buildRoad({seed,lengthTarget:3400,terrainHeightAt:terrain.heightAt,biome});
const ci=buildCarveIndex(road);
prewarmArea(world,terrain,road,ci,road.x[12],road.z[12],140);
for (let i=6;i<=20;i++){
  const x=road.x[i], z=road.z[i];
  const nx=road.nx[i], nz=road.nz[i];
  const g0=world.groundHeight(x,z);
  const gl=world.groundHeight(x+nx*0.76, z+nz*0.76);
  const gr=world.groundHeight(x-nx*0.76, z-nz*0.76);
  console.log(`arc ${i} road.h=${road.h[i].toFixed(2)} width=${road.width[i].toFixed(1)} centre=${g0.toFixed(2)} left=${gl.toFixed(2)} right=${gr.toFixed(2)}`);
}
