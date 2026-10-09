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

const car = new Vehicle('A', world, { assists: { autoShift: true } });
car.placeAt(road.x[12], road.z[12], -road.heading[12], road.h[12]);
car.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 });

const kF = car.susp.kFront, kR = car.susp.kRear, mu = car.params.unsprung, m = car.mass, I = car.body.I;
const _w = { x: 0, y: 0, z: 0 };
function parts() {
  const b = car.body;
  mul3vT(b.m, b.angVel, _w);
  const p = {
    bodyKE: 0.5 * m * (b.vel.x ** 2 + b.vel.y ** 2 + b.vel.z ** 2),
    rotKE: 0.5 * (I.xx * _w.x ** 2 + I.yy * _w.y ** 2 + I.zz * _w.z ** 2),
    wheelKE: 0, suspPE: 0, tyrePE: 0,
    gravPE: m * 9.81 * b.pos.y + mu * 9.81 * car.wheels.reduce((s, w) => s + w.y, 0),
  };
  for (const w of car.wheels) {
    const k = w.axle === 0 ? kF : kR;
    p.wheelKE += 0.5 * mu * w.vy ** 2;
    p.suspPE += 0.5 * k * w.suspRaw ** 2;
    p.tyrePE += 0.5 * 200000 * Math.min(Math.max(w.compression, 0), 0.045) ** 2;
  }
  return p;
}
const P0 = parts();
const E0 = Object.values(P0).reduce((a, b) => a + b, 0);
const kJ = (v) => (v / 1000).toFixed(2);

for (let i = 0; i <= 240; i++) {
  if (i % 20 === 0) {
    const P = parts();
    const E = Object.values(P).reduce((a, b) => a + b, 0);
    const b = car.body;
    mul3vT(b.m, b.angVel, _w);
    console.log(`t=${(i * DT).toFixed(2)} dE=${kJ(E - E0)} bodyKE=${kJ(P.bodyKE - P0.bodyKE)} rotKE=${kJ(P.rotKE - P0.rotKE)} wheelKE=${kJ(P.wheelKE - P0.wheelKE)} suspPE=${kJ(P.suspPE - P0.suspPE)} tyrePE=${kJ(P.tyrePE - P0.tyrePE)} gravPE=${kJ(P.gravPE - P0.gravPE)} | y=${b.pos.y.toFixed(2)} sumN=${(car.wheels.reduce((s, w) => s + w.N, 0) / 1000).toFixed(1)} susp=${car.wheels.map((w) => w.suspRaw.toFixed(3)).join(' ')}`);
  }
  car.step(DT);
}
