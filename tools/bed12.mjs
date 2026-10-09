import { VoxelWorld } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';
import { Vehicle } from '../src/car/vehicle.js';
import { mul3v } from '../src/core/math3.js';

const seed = 12345, biome = 'FOREST';
const world = new VoxelWorld(seed);
const terrain = makeTerrain(seed, biome);
const road = buildRoad({ seed, lengthTarget: 3400, terrainHeightAt: terrain.heightAt, biome });
const ci = buildCarveIndex(road);
prewarmArea(world, terrain, road, ci, road.x[12], road.z[12], 140);

console.log('road[12]', road.x[12].toFixed(2), road.z[12].toFixed(2), 'h', road.h[12].toFixed(3), 'heading', road.heading[12].toFixed(3), 'bank', road.bank?.[12]);
console.log('ground at centre', world.groundHeight(road.x[12], road.z[12]).toFixed(3));
const car = new Vehicle('A', world, { assists: { autoShift: true } });
car.placeAt(road.x[12], road.z[12], -road.heading[12], road.h[12]);
const b = car.body;
console.log('placed y', b.pos.y.toFixed(3), 'pitch', Math.asin(b.forward.y).toFixed(3), 'roll', Math.atan2(-b.up.x, b.up.y).toFixed(3));
for (const w of car.wheels) {
  mul3v(b.m, w.mountLocal, w.hub);
  const gx = b.pos.x + w.hub.x, gz = b.pos.z + w.hub.z;
  console.log(w.id, 'mount', gx.toFixed(2), gz.toFixed(2), 'ground', world.groundHeight(gx, gz).toFixed(3), 'distFromCentre', Math.hypot(gx - road.x[12], gz - road.z[12]).toFixed(2));
}
// road half width + how the corridor height varies along the car
for (let i = 9; i <= 16; i++) console.log('i', i, 'x', road.x[i].toFixed(1), 'z', road.z[i].toFixed(1), 'h', road.h[i].toFixed(3));
