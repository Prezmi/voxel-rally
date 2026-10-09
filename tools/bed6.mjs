import { VoxelWorld } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';
import { Vehicle } from '../src/car/vehicle.js';
import { DT } from '../src/core/time.js';
import { mul3vT } from '../src/core/math3.js';

const seed = 12345, biome = 'FOREST';
const world = new VoxelWorld(seed);
const terrain = makeTerrain(seed, biome);
const road = buildRoad({ seed, lengthTarget: 3400, terrainHeightAt: terrain.heightAt, biome });
const ci = buildCarveIndex(road);
prewarmArea(world, terrain, road, ci, road.x[12], road.z[12], 140);

const flat = process.argv.includes('--flat');
if (flat) { const g = world.groundHeight(road.x[12], road.z[12]); world.groundHeight = () => g; }
const sub = Number((process.argv.find((a) => a.startsWith('--sub=')) || '').split('=')[1] || 4);
const throttle = Number((process.argv.find((a) => a.startsWith('--thr=')) || '').split('=')[1] || 0);

const car = new Vehicle('A', world, { assists: { autoShift: true }, substeps: sub });
car.placeAt(road.x[12], road.z[12], -road.heading[12], road.h[12]);
car.setInput({ throttle, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });

const _t = { x: 0, y: 0, z: 0 };
console.log(`${flat ? 'FLAT' : 'voxel'} ground  substeps ${sub}  y0 ${car.body.pos.y.toFixed(3)}  len ${car.wheels.map((w) => (w.hub.y - w.y).toFixed(3)).join(' ')}`);
for (let i = 0; i < 240; i++) {
  const b = car.body;
  if (i % 20 === 0) {
    mul3vT(b.m, b.angVel, _t);
    const tq = { x: 0, y: 0, z: 0 }; mul3vT(b.m, b.torque, tq);
    console.log(`t=${(i * DT).toFixed(2)} y=${b.pos.y.toFixed(3)} vy=${b.vel.y.toFixed(2)} roll=${_t.x.toFixed(3)} pitch=${_t.z.toFixed(3)} tqRoll=${(tq.x / 1000).toFixed(1)} tqPitch=${(tq.z / 1000).toFixed(1)} kNm sumN=${(car.wheels.reduce((s, w) => s + w.N, 0) / 1000).toFixed(1)}kN Fy=${(b.force.y / 1000).toFixed(1)}kN Fv_tyre=${(car.wheels.reduce((s, w) => s + w.Fvert, 0) / 1000).toFixed(1)}kN Flon=${car.wheels.map((w) => (w.Flon / 1000).toFixed(2)).join(' ')} fwdY=${b.forward.y.toFixed(3)} gnd=${world.groundHeight(b.pos.x, b.pos.z).toFixed(2)} wheelBottom=${car.wheels.map((w) => (w.y - w.rGeo).toFixed(2)).join(' ')} len=${car.wheels.map((w) => (w.hub.y - w.y).toFixed(3)).join(' ')}`);
  }
  car.step(DT);
}
const b = car.body;
mul3vT(b.m, b.angVel, _t);
console.log(`end y ${b.pos.y.toFixed(3)} roll ${_t.x.toFixed(3)} pitch ${_t.z.toFixed(3)}`);
