import { VoxelWorld } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad, planCheckpoints } from '../src/world/road-spline.js';
import { buildCarveIndex, carveChunk } from '../src/world/road-carve.js';
import { keyToCx, keyToCz } from '../src/world/chunk.js';
import { Vehicle } from '../src/car/vehicle.js';
const seed=12345, biome='FOREST';
const world=new VoxelWorld(seed);
const terrain=makeTerrain(seed,biome);
const road=buildRoad({seed,lengthTarget:3400,terrainHeightAt:terrain.heightAt,biome});
const carveIndex=buildCarveIndex(road);
for (const key of carveIndex.keys()) carveChunk(world,keyToCx(key),keyToCz(key),road,carveIndex,terrain);
console.log('road.h[0]', road.h[0].toFixed(2), 'terrain.heightAt(0,0)', terrain.heightAt(0,0).toFixed(2));
console.log('world.groundHeight(0,0)', world.groundHeight(0,0).toFixed(2));
for (const [dx,dz] of [[1.31,-0.76],[1.31,0.76],[-1.31,-0.76],[-1.31,0.76],[0,0]])
  console.log(`  at (${dx},${dz}) world=${world.groundHeight(dx,dz).toFixed(2)} terrain=${terrain.heightAt(dx,dz).toFixed(2)} chunk=${Math.floor(dx/16)},${Math.floor(dz/16)} exists=${!!world.chunkAt(Math.floor(dx/16),Math.floor(dz/16))}`);
const car=new Vehicle('A',world,{});
car.placeAt(road.x[0],road.z[0],-road.heading[0],road.h[0]);
console.log('car posy', car.body.pos.y.toFixed(2), 'wheelY', car.wheels.map(w=>w.y.toFixed(2)).join(' '), 'groundY', car.wheels.map(w=>w.groundY.toFixed(2)).join(' '));
