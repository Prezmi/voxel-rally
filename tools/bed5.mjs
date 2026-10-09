import { VoxelWorld } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';
import { Vehicle } from '../src/car/vehicle.js';
import { DT } from '../src/core/time.js';
import { mul3v } from '../src/core/math3.js';

const seed = 12345, biome = 'FOREST';
const world = new VoxelWorld(seed);
const terrain = makeTerrain(seed, biome);
const road = buildRoad({ seed, lengthTarget: 3400, terrainHeightAt: terrain.heightAt, biome });
const ci = buildCarveIndex(road);
prewarmArea(world, terrain, road, ci, road.x[12], road.z[12], 140);

const car = new Vehicle('A', world, { assists: { autoShift: true } });
car.placeAt(road.x[12], road.z[12], -road.heading[12], road.h[12]);
console.log('hullLocal points:', car.hullLocal.length, car.hullLocal.map((p) => `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`).join(' '));

car.setInput({ throttle: 0.8, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });
for (let i = 0; i < 120; i++) {
  const b = car.body;
  const sumN = car.wheels.reduce((s, w) => s + w.N, 0);
  const lens = car.wheels.map((w) => (w.hub.y - w.y).toFixed(3)).join(' ');
  const _t = { x: 0, y: 0, z: 0 };
  const hullPen = car.hullLocal.filter((lp) => {
    mul3v(b.m, lp, _t);
    return car.world.groundHeight(b.pos.x + _t.x, b.pos.z + _t.z) - (b.pos.y + _t.y) > 0;
  }).length;
  if (i % 6 === 0) {
    console.log(`step ${String(i).padStart(3)} t=${(i * DT).toFixed(3)} y=${b.pos.y.toFixed(3)} vy=${b.vel.y.toFixed(2)} pitch=${b.angVel.x.toFixed(3)} roll=${b.angVel.z.toFixed(3)} sumN=${(sumN / 1000).toFixed(1)}kN hullPen=${hullPen} len=${lens}`);
  }
  car.step(DT);
}
