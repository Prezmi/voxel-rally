// Headless mirror of the browser shot mode (main.js ?frames=...): drives the real
// generated stage with the same pure-pursuit driver so the shot can be tuned
// without a GPU round trip.
import { VoxelWorld } from '../src/world/chunk.js';
import { makeTerrain } from '../src/world/terrain-gen.js';
import { buildRoad, planCheckpoints } from '../src/world/road-spline.js';
import { buildCarveIndex, prewarmArea } from '../src/world/road-carve.js';
import { Vehicle } from '../src/car/vehicle.js';
import { DirtSystem } from '../src/dirt/dirt.js';
import { PANELS } from '../src/dirt/panel-dirt.js';
import { SURFACE_KEYS, surface } from '../src/world/surfaces.js';
import { DT } from '../src/core/time.js';

const key = process.argv[2] || 'gravel';
const frames = Number(process.argv[3] || 3600);
const seed = 12345;
const world = new VoxelWorld(seed);
const terrain = makeTerrain(seed, 'FOREST');
const road = buildRoad({ seed, lengthTarget: 3400, terrainHeightAt: terrain.heightAt, biome: 'FOREST' });
if (SURFACE_KEYS[key] !== undefined) road.surfaceId.fill(SURFACE_KEYS[key]);
const carveIndex = buildCarveIndex(road);
prewarmArea(world, terrain, road, carveIndex, road.x[0], road.z[0], 140);

const carWorld = Object.create(world);
carWorld.surfaceAt = (x, z) => world.surfaceAt(Math.floor(x), Math.floor(z));
carWorld.rutAt = (x, z) => world.rutAt(Math.floor(x), Math.floor(z));
const car = new Vehicle('A', carWorld, { assists: { abs: false, tc: false, counterSteer: false, autoShift: true } });
const dirt = new DirtSystem();
car.placeAt(road.x[12], road.z[12], -road.heading[12], road.h[12]);

const input = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: 0, shiftDown: 0 };
let maxRoll = 0, maxPitch = 0, maxAir = 0, minSpeed = 99;
let idx0 = 12;
for (let i = 0; i < frames; i++) {
  let idx = road.nearest(car.body.pos.x, car.body.pos.z);
  if (idx < 0) idx = idx0;
  const lat = Math.hypot(car.body.pos.x - road.x[idx], car.body.pos.z - road.z[idx]);
  const roll = Math.abs(Math.asin(Math.max(-1, Math.min(1, -car.body.m[7]))) * 180 / Math.PI);
  // Shot-mode recovery: put the car back on the road if it left it or tipped over,
  // so the frame always shows a car *on the tested surface*.
  if (lat > 6 || roll > 20) {
    idx0 = Math.min(road.n - 2, idx + 2);
    car.placeAt(road.x[idx0], road.z[idx0], -road.heading[idx0], road.h[idx0]);
    car.wheels.forEach((w) => { w.omega = car.body.groundSpeed / w.rEff; });
    idx = idx0;
  }
  idx0 = idx;
  const sp = Math.max(1, car.body.groundSpeed);
  const look = Math.max(16, sp * 1.15);
  const j = Math.min(road.n - 1, idx + Math.round(look / (road.s[1] - road.s[0])));
  const want = Math.atan2(road.z[j] - car.body.pos.z, road.x[j] - car.body.pos.x);
  let dA = want - Math.atan2(car.body.forward.z, car.body.forward.x);
  while (dA > Math.PI) dA -= 2 * Math.PI;
  while (dA < -Math.PI) dA += 2 * Math.PI;
  input.steer = Math.max(-1, Math.min(1, -Math.atan(2 * car.params.wheelbase * Math.sin(dA) / look) / car.params.steerMax));
  input.throttle = 0.75;
  input.handbrake = (i % 1000) < 40 ? 0.30 : 0;
  car.setInput(input);
  car.step(DT);
  dirt.step(car, DT);
  if (i % 90 === 89) prewarmArea(world, terrain, road, carveIndex, car.body.pos.x, car.body.pos.z, 90);
  if (i % 8 === 7) dirt.frame(car);
  if (process.env.TRACE && i % 240 === 0) {
    const gi = road.nearest(car.body.pos.x, car.body.pos.z);
    console.log(`t=${(i*DT).toFixed(1)} arc=${road.s[gi]?.toFixed(0)} v=${car.body.groundSpeed.toFixed(1)} y=${car.body.pos.y.toFixed(2)} roadY=${road.h[gi].toFixed(2)} surf=${surface(car.wheels[2].surfaceId).key} chunk=${world.chunkAt(Math.floor(car.body.pos.x/16), Math.floor(car.body.pos.z/16)) ? 'yes':'MISSING'} air=${car.airborneWheels}`);
  }
  maxRoll = Math.max(maxRoll, Math.abs(Math.asin(Math.max(-1, Math.min(1, -car.body.m[7]))) * 180 / Math.PI));
  maxPitch = Math.max(maxPitch, Math.abs(Math.asin(Math.max(-1, Math.min(1, car.body.m[1]))) * 180 / Math.PI));
  maxAir = Math.max(maxAir, car.airborneWheels);
}
const idx = road.nearest(car.body.pos.x, car.body.pos.z);
console.log(`${key} frames=${frames} arc=${road.s[idx]?.toFixed(0)} v=${car.body.groundSpeed.toFixed(1)} maxRoll=${maxRoll.toFixed(1)} maxPitch=${maxPitch.toFixed(1)} maxAir=${maxAir} surf=${surface(car.wheels[2].surfaceId).name}`);
console.log('panels: ' + PANELS.map((p, i) => `${p.key} ${dirt.panels.load(i).toFixed(2)}`).join(' '));
console.log('lens: ' + dirt.lens.severity().toFixed(2) + ' splats/frame ' + dirt.stats.splats);
